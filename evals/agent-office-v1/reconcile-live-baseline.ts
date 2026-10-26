import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseClient } from '../../server/platform/database';
import { agentOfficeV1Corpus } from './corpus';
import { summarize, type RunResult } from './run-baseline';

interface LiveReport {
  formatVersion: number;
  createdAt: string;
  updatedAt: string;
  source: string;
  providerHost: string;
  model: string;
  strategyDefinitions: Record<string, string>;
  baselinePlan: {
    taskIds: string[];
    strategies: Array<'single-agent' | 'multi-agent'>;
    repetitions: number;
    maxTotalUsd: number;
    plannedExposureUsd: number;
    runs: Array<{ taskId: string; category: string; strategy: 'single-agent' | 'multi-agent'; repetition: number; maxBudgetUsd: number }>;
  };
  guardrails: Record<string, unknown>;
  executionState: string;
  activeRun: { taskId: string; strategy: 'single-agent' | 'multi-agent'; repetition: number; startedAt: string } | null;
  summary: Record<string, unknown>;
  stoppedEarly: boolean;
  stopReason: string | null;
  runs: RunResult[];
  reconciliation?: Record<string, unknown>;
}

interface RunDbRow {
  id: string;
  conversation_id: string;
  project_id: string;
  status: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_CAPTURED_TEXT_CHARS = 30_000;

async function main(): Promise<void> {
  const [checkpointPathArg, remainingPathArg, dataDirArg, outputPathArg] = process.argv.slice(2);
  if (!checkpointPathArg || !remainingPathArg || !dataDirArg || !outputPathArg) {
    throw new Error('Usage: tsx reconcile-live-baseline.ts <original.json.partial> <remaining.json> <recovered-data-dir> <combined-output.json>');
  }
  const checkpointPath = resolve(checkpointPathArg);
  const remainingPath = resolve(remainingPathArg);
  const outputPath = resolve(outputPathArg);
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as LiveReport;
  const remaining = JSON.parse(await readFile(remainingPath, 'utf8')) as LiveReport;
  const active = checkpoint.activeRun;
  if (checkpoint.executionState !== 'running' || !active) throw new Error('The source checkpoint must contain one active, unreconciled run.');
  if (remaining.executionState !== 'finished' || remaining.stoppedEarly) throw new Error('The remaining run report must be finished without an early stop.');
  if (checkpoint.providerHost !== remaining.providerHost || checkpoint.model !== remaining.model) throw new Error('Provider or model differs between the source and remaining reports.');
  if (checkpoint.runs.length !== 60 || remaining.runs.length !== 12) throw new Error('Expected 60 checkpointed and 12 remaining runs.');

  const activeKey = runKey(active);
  const extra = remaining.runs.filter((run) => runKey(run) === activeKey);
  if (extra.length !== 1) throw new Error('Expected exactly one repeated run matching the checkpoint active run.');
  if (extra[0]!.status !== 'succeeded') throw new Error('The repeated run must have succeeded before it can be classified as superseded.');

  const recovery = await recoverCompletedRun(resolve(dataDirArg), checkpoint, active);
  const recovered = recovery.result;
  const canonicalRuns = [...checkpoint.runs, recovered, ...remaining.runs.filter((run) => runKey(run) !== activeKey)];
  const planByKey = new Map(checkpoint.baselinePlan.runs.map((run) => [runKey(run), run]));
  const canonicalByKey = new Map(canonicalRuns.map((run) => [runKey(run), run]));
  if (canonicalByKey.size !== checkpoint.baselinePlan.runs.length || planByKey.size !== checkpoint.baselinePlan.runs.length) {
    throw new Error('The combined report does not contain exactly one result for every planned run.');
  }
  const orderedRuns = checkpoint.baselinePlan.runs.map((planned) => {
    const result = canonicalByKey.get(runKey(planned));
    if (!result || result.status !== 'succeeded') throw new Error(`Planned run is missing or unsuccessful: ${runKey(planned)}.`);
    return result;
  });

  const canonicalCost = sumKnownCosts(orderedRuns);
  const duplicate = extra[0]!;
  const actualCost = canonicalCost === null || duplicate.measuredCostUsd === null ? null : canonicalCost + duplicate.measuredCostUsd;
  const report: LiveReport = {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
    source: 'Agent Office v1 eval corpus; reconciled from the original checkpoint, one recovered isolated SQLite run, and the remaining report.',
    guardrails: { ...checkpoint.guardrails, activeRunMayHaveUnknownProviderUsage: false },
    executionState: 'finished',
    activeRun: null,
    summary: summarize(orderedRuns, checkpoint.baselinePlan as never, canonicalCost, Number(checkpoint.guardrails.aggregateMeasuredTokenCeiling)) as Record<string, unknown>,
    stoppedEarly: false,
    stopReason: null,
    runs: orderedRuns,
    reconciliation: {
      canonicalPlannedRuns: orderedRuns.length,
      recoveredRun: { taskId: recovered.taskId, strategy: recovered.strategy, repetition: recovered.repetition, runId: recovery.runId, source: 'completed isolated SQLite run retained after the checkpoint stopped updating' },
      supersededDuplicate: { taskId: duplicate.taskId, strategy: duplicate.strategy, repetition: duplicate.repetition, status: duplicate.status, measuredTokens: duplicate.measuredTokens, measuredCostUsd: duplicate.measuredCostUsd, countedInCanonicalSummary: false },
      actualMeasuredTokensIncludingDuplicate: orderedRuns.reduce((sum, run) => sum + run.measuredTokens, 0) + duplicate.measuredTokens,
      actualMeasuredCostUsdIncludingDuplicate: actualCost,
      sourceCheckpoint: checkpointPath,
      remainingReport: remainingPath,
      rawCheckpointsPreserved: true,
    },
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ outputPath, canonicalRuns: orderedRuns.length, actualMeasuredTokensIncludingDuplicate: report.reconciliation!.actualMeasuredTokensIncludingDuplicate, actualMeasuredCostUsdIncludingDuplicate: actualCost })}\n`);
}

async function recoverCompletedRun(dataDir: string, checkpoint: LiveReport, active: NonNullable<LiveReport['activeRun']>): Promise<{ result: RunResult; runId: string }> {
  const db = await DatabaseClient.openReadOnly(dataDir, true);
  try {
    const row = await db.one<RunDbRow>('SELECT id, conversation_id, project_id, status, error_code, created_at, updated_at FROM runs LIMIT 1');
    if (!row || row.status !== 'succeeded') throw new Error('The isolated SQLite run is not recorded as succeeded.');
    const task = agentOfficeV1Corpus.find((item) => item.id === active.taskId);
    if (!task) throw new Error(`Unknown task in checkpoint: ${active.taskId}.`);
    const messages = await db.all<{ speaker: string; agent_instance_id: string | null; status: string; content: string }>(
      'SELECT speaker, agent_instance_id, status, content FROM messages WHERE run_id = ? ORDER BY sequence', [row.id],
    );
    const usage = await db.one<{ modelRequests: number; measuredTokens: number; reservedTokens: number; unknownRequests: number; unpricedRequests: number; measuredCostMicrousd: number }>(`SELECT COUNT(*) AS modelRequests,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN total_tokens ELSE 0 END),0) AS measuredTokens,
      COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN prompt_reservation + output_reservation ELSE 0 END),0) AS reservedTokens,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknownRequests,
      SUM(CASE WHEN pricing_version IS NULL THEN 1 ELSE 0 END) AS unpricedRequests,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN COALESCE(actual_cost_microusd,0) ELSE 0 END),0) AS measuredCostMicrousd
      FROM model_call_reservations WHERE run_id = ?`, [row.id]);
    const usageByAgent = await db.all<{ agent_instance_id: string | null; request_count: number; measured_tokens: number }>(
      'SELECT agent_instance_id, COUNT(*) AS request_count, SUM(total_tokens) AS measured_tokens FROM model_usage WHERE run_id = ? GROUP BY agent_instance_id ORDER BY agent_instance_id', [row.id],
    );
    const toolRows = await db.all<{ tool_id: string; status: string; count: number }>(
      'SELECT tool_id, status, COUNT(*) AS count FROM tool_operations WHERE run_id = ? GROUP BY tool_id, status ORDER BY tool_id, status', [row.id],
    );
    const repairRows = await db.all<{ payload_json: string }>(
      "SELECT payload_json FROM domain_events WHERE type = 'coordinator.plan_repair_attempted' AND aggregate_id = ? ORDER BY sequence", [row.id],
    );
    const workspace = await db.one<{ workspace_root: string }>('SELECT workspace_root FROM projects WHERE id = ?', [row.project_id]);
    const workspaceFiles: RunResult['workspaceFiles'] = [];
    if (workspace?.workspace_root) {
      const file = join(workspace.workspace_root, 'state.json');
      const contents = await readFile(file);
      workspaceFiles.push({ path: 'state.json', checksum: createHash('sha256').update(contents).digest('hex'), sizeBytes: contents.byteLength });
    }
    const costUsd = usage && (usage.unpricedRequests || usage.unknownRequests || usage.reservedTokens > 0) ? null : (usage?.measuredCostMicrousd ?? 0) / 1_000_000;
    const planned = checkpoint.baselinePlan.runs.find((run) => runKey(run) === runKey(active));
    if (!planned) throw new Error('Active run is not present in the original plan.');
    const result: RunResult = {
      taskId: task.id, category: task.category, strategy: active.strategy, repetition: active.repetition,
      status: row.status, errorCode: row.error_code, planRepairs: repairRows.map(({ payload_json }) => {
        const payload = JSON.parse(payload_json) as Record<string, unknown>;
        return { attempt: Number(payload.attempt), errorCode: typeof payload.errorCode === 'string' ? payload.errorCode : 'PLAN_INVALID', fieldIssues: Array.isArray(payload.fieldIssues) ? payload.fieldIssues.filter((item): item is string => typeof item === 'string').slice(0, 8) : [], willRetry: payload.willRetry === true };
      }),
      terminationReason: null, stateBeforeHarnessStop: null,
      durationMs: Math.max(1, Date.parse(row.updated_at) - Date.parse(active.startedAt)),
      modelRequests: usage?.modelRequests ?? 0,
      usageByAgent: usageByAgent.map((item) => ({ agentInstanceId: item.agent_instance_id, requestCount: item.request_count, measuredTokens: item.measured_tokens })),
      measuredTokens: usage?.measuredTokens ?? 0, reservedTokens: usage?.reservedTokens ?? 0, unknownRequests: usage?.unknownRequests ?? 0, unpricedRequests: usage?.unpricedRequests ?? 0,
      measuredCostUsd: costUsd, costCeilingUsd: planned.maxBudgetUsd,
      toolOperations: toolRows.map((item) => ({ toolId: item.tool_id, status: item.status, count: item.count })),
      automatedIsolatedApprovals: 0, pendingApprovals: 0, tasks: [],
      messages: messages.map((item) => ({ speaker: item.speaker, agentInstanceId: item.agent_instance_id, status: item.status, content: item.content.slice(0, MAX_CAPTURED_TEXT_CHARS) })),
      artifacts: [], workspaceFiles, expectedProperties: task.expectedProperties, acceptance: task.acceptance, reviewerRubric: task.reviewerRubric, qualityReview: 'human-review-required',
    };
    return { result, runId: row.id };
  } finally {
    await db.close().catch(() => undefined);
  }
}

function sumKnownCosts(runs: readonly RunResult[]): number | null {
  return runs.some((run) => run.measuredCostUsd === null) ? null : runs.reduce((sum, run) => sum + (run.measuredCostUsd ?? 0), 0);
}

function runKey(run: { taskId: string; strategy: string; repetition: number }): string {
  return `${run.taskId}/${run.strategy}/r${run.repetition}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Baseline reconciliation failed.'}\n`);
    process.exitCode = 1;
  });
}

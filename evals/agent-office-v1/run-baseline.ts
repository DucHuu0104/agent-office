import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ArtifactService } from '../../server/platform/artifacts';
import { loadAppConfig, profileEnvValue, type AppConfig } from '../../server/platform/config';
import { DatabaseClient } from '../../server/platform/database';
import { EventHub } from '../../server/platform/events';
import { loadRegistry, type Registry } from '../../server/platform/registry';
import { ProjectService } from '../../server/platform/projects';
import { AgentRuntime } from '../../server/platform/runtime';
import { agentOfficeV1Corpus, type EvalTask } from './corpus';
import { createProviderPacedFetch } from './baseline-rate-limit';
import { allocateBaselineRunTokens, MIN_REMAINING_TOKENS_TO_START_RUN, requiredBaselineStartTokens } from './baseline-budget';
import { summarizeBaselineToolOperations } from './baseline-report';
import { createBaselinePlan, resolveBaselineTaskIds, startsPairedComparison, summarizePairedComparisons, type BaselinePlan, type BaselineRun, type BaselineStrategy } from './baseline-plan';
import { isSafeIsolatedWorkspaceApproval, resolveFixturePath } from './baseline-safety';

const execFile = promisify(execFileCallback);
const DEFAULT_MAX_TOKENS_PER_RUN = 40_000;
const MAX_TOKENS_PER_RUN = 80_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const MAX_CAPTURED_TEXT_CHARS = 30_000;

interface Options {
  live: boolean;
  taskIds?: string[];
  strategies?: BaselineStrategy[];
  repetitions: number;
  maxTotalUsd: number;
  maxTotalTokens?: number;
  maxTokensPerRun: number;
  maxOutputTokens: number;
  timeoutSeconds: number;
  approveIsolatedOperations: boolean;
  dockerChecks: boolean;
  allowUnpriced: boolean;
  minProviderRequestIntervalMs: number;
  modelProfile?: string;
  outputPath?: string;
}

interface ResolvedModelProfile {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface CapturedMessage {
  speaker: string;
  agentInstanceId: string | null;
  status: string;
  content: string;
}

interface RunResult {
  taskId: string;
  category: EvalTask['category'];
  strategy: BaselineStrategy;
  repetition: number;
  status: string;
  errorCode: string | null;
  planRepairs: Array<{ attempt: number; errorCode: string; fieldIssues: string[]; willRetry: boolean }>;
  terminationReason: 'deadline' | 'approval_required' | 'user_input_required' | null;
  stateBeforeHarnessStop: { runStatus: string | null; tasks: Array<{ title: string; status: string; assignedAgentId: string | null }> } | null;
  durationMs: number;
  modelRequests: number;
  usageByAgent: Array<{ agentInstanceId: string | null; requestCount: number; measuredTokens: number }>;
  measuredTokens: number;
  reservedTokens: number;
  unknownRequests: number;
  unpricedRequests: number;
  measuredCostUsd: number | null;
  costCeilingUsd: number;
  toolOperations: Array<{ toolId: string; status: string; count: number }>;
  automatedIsolatedApprovals: number;
  pendingApprovals: number;
  tasks: Array<{ title: string; status: string; assignedAgentId: string | null; output: string | null }>;
  messages: CapturedMessage[];
  artifacts: Array<{ name: string; mimeType: string; checksum: string; sizeBytes: number; content: string | null }>;
  workspaceFiles: Array<{ path: string; checksum: string; sizeBytes: number }>;
  expectedProperties: string[];
  acceptance: string[];
  reviewerRubric: string[];
  qualityReview: 'human-review-required';
}

export async function runBaselineCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options === 'help') return;
  const plan = createBaselinePlan({
    ...(options.taskIds ? { taskIds: options.taskIds } : {}),
    ...(options.strategies ? { strategies: options.strategies } : {}),
    repetitions: options.repetitions,
    maxTotalUsd: options.maxTotalUsd,
  });
  if (!options.live) {
    printJson({ mode: 'dry-run', providerCalls: 0, maxTokensPerRun: options.maxTokensPerRun, plan });
    return;
  }
  const firstPair = plan.runs.length > 1 && startsPairedComparison(plan.runs[0]!, plan.runs[1]);
  const minimumTokensToStart = requiredBaselineStartTokens(options.maxTokensPerRun, firstPair);
  if (!Number.isInteger(options.maxTotalTokens) || minimumTokensToStart === null || options.maxTotalTokens! < minimumTokensToStart) {
    throw new Error(`Live baseline requires --max-total-tokens >= ${minimumTokensToStart} to reserve the full ${options.maxTokensPerRun}-token ceiling${firstPair ? ' for both runs in the first strategy pair' : ' for the first run'}.`);
  }
  if (!options.approveIsolatedOperations && plan.taskIds.some((id) => getTask(id).category === 'coding')) {
    throw new Error('Coding cases require --approve-isolated-operations; approvals will be limited to the generated temporary workspace and Docker checks.');
  }
  const configDir = process.cwd();
  process.env.OFFICE_CONFIG_DIR = configDir;
  process.env.OFFICE_EXECUTION_MODE = options.dockerChecks ? 'docker' : 'disabled';
  const config = loadAppConfig(process.env);
  const registry = await loadRegistry(configDir);
  const modelProfile = options.modelProfile ?? 'primary';
  const provider = resolveModelProfile(registry, modelProfile, config);
  if (!provider.apiKey || !provider.model) throw new Error(`Live baseline stopped before model requests: credentials or model name are missing for profile ${modelProfile}.`);
  if (options.modelProfile) for (const definition of registry.definitions.values()) definition.manifest.modelProfile = modelProfile;
  const missingPriceProfiles = activeModelProfiles(plan, registry).filter((id) => {
    const profile = registry.profiles.get(id);
    return !profile?.pricing || profile.pricing.modelName !== provider.model;
  });
  if (missingPriceProfiles.length && !options.allowUnpriced) {
    throw new Error(`Live baseline stopped before model requests: exact owner prices are missing for ${missingPriceProfiles.join(', ')}. Configure exact model prices, or pass --allow-unpriced with --max-total-tokens to record USD as unknown.`);
  }
  if (options.dockerChecks) {
    const image = config.docker.image;
    const result = await execFile('docker', ['image', 'inspect', image], { windowsHide: true, timeout: 15_000 }).catch(() => null);
    if (!result) throw new Error('Docker check mode requires the configured digest-pinned image to be available locally; no image pull is attempted.');
  }

  const outputPath = resolve(options.outputPath ?? join(configDir, 'evals', 'results', `agent-office-v1-baseline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const checkpointPath = `${outputPath}.partial`;
  await mkdir(dirname(outputPath), { recursive: true });
  await assertReportPathAvailable(outputPath);
  await assertReportPathAvailable(checkpointPath);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createProviderPacedFetch(provider.baseUrl, options.minProviderRequestIntervalMs, originalFetch);
  let report: Awaited<ReturnType<typeof executePlan>>;
  try { report = await executePlan(plan, options, outputPath, checkpointPath, { providerHost: new URL(provider.baseUrl).host, model: provider.model }); }
  finally { globalThis.fetch = originalFetch; }
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rm(checkpointPath, { force: true }).catch(() => undefined);
  printJson({ mode: 'live', reportPath: outputPath, summary: report.summary, stoppedEarly: report.stoppedEarly, stopReason: report.stopReason });
}

async function executePlan(plan: BaselinePlan, options: Options, outputPath: string, checkpointPath: string, provider: { providerHost: string; model: string }): Promise<Record<string, unknown> & {
  summary: Record<string, unknown>;
  stoppedEarly: boolean;
  stopReason: string | null;
}> {
  const maxTotalTokens = options.maxTotalTokens!;
  const runs: RunResult[] = [];
  let measuredTokens = 0;
  let measuredCostUsd = 0;
  let allPriced = true;
  let stoppedEarly = false;
  let stopReason: string | null = null;
  const createdAt = new Date().toISOString();
  const createReport = (executionState: 'running' | 'finished', activeRun: Record<string, unknown> | null) => ({
    formatVersion: 1,
    createdAt,
    updatedAt: new Date().toISOString(),
    source: 'Agent Office v1 eval corpus',
    providerHost: provider.providerHost,
    model: provider.model,
    strategyDefinitions: {
      'single-agent': 'Coordinator plus the one domain-specialist definition for the task category; the Coordinator may create multiple tasks for that specialist.',
      'multi-agent': 'Coordinator plus the full enabled specialist roster, filtered to the task allowed tools.',
    },
    baselinePlan: plan,
    guardrails: {
      aggregateMeasuredTokenCeiling: maxTotalTokens,
      minimumRemainingTokensToStartRun: MIN_REMAINING_TOKENS_TO_START_RUN,
      maxTokensPerRun: options.maxTokensPerRun,
      maxOutputTokensPerCall: options.maxOutputTokens,
      minProviderRequestIntervalMs: options.minProviderRequestIntervalMs,
      runTimeoutSeconds: options.timeoutSeconds,
      usdPricingConfiguredForEveryRequest: allPriced,
      usdBudgetEnforced: allPriced,
      approvalsAutomaticallyAccepted: options.approveIsolatedOperations,
      approvalsRestrictedToTemporaryWorkspaces: true,
      executionMode: options.dockerChecks ? 'docker' : 'disabled',
      outputPublishedWithExclusiveCreate: outputPath,
      progressCheckpointPath: checkpointPath,
      activeRunMayHaveUnknownProviderUsage: activeRun !== null,
    },
    executionState,
    activeRun,
    summary: summarize(runs, plan, allPriced ? measuredCostUsd : null, maxTotalTokens),
    stoppedEarly,
    stopReason,
    runs,
  });
  await writeBaselineCheckpoint(checkpointPath, createReport('running', null), true);
  for (let index = 0; index < plan.runs.length; index++) {
    const planned = plan.runs[index]!;
    if (measuredTokens >= maxTotalTokens) { stoppedEarly = true; stopReason = 'aggregate-token-ceiling'; break; }
    if (allPriced && measuredCostUsd >= plan.maxTotalUsd) { stoppedEarly = true; stopReason = 'aggregate-usd-ceiling'; break; }
    const remainingTokens = maxTotalTokens - measuredTokens;
    const startsPairedRun = startsPairedComparison(planned, plan.runs[index + 1]);
    const tokenAllocation = allocateBaselineRunTokens(remainingTokens, options.maxTokensPerRun, startsPairedRun);
    if (!tokenAllocation) {
      stoppedEarly = true;
      stopReason = startsPairedRun ? 'insufficient-tokens-to-start-complete-pair' : 'insufficient-tokens-to-start-next-run';
      break;
    }
    const remainingUsd = allPriced ? plan.maxTotalUsd - measuredCostUsd : plan.maxTotalUsd;
    if (allPriced && remainingUsd <= 0) { stoppedEarly = true; stopReason = 'aggregate-usd-ceiling'; break; }
    await writeBaselineCheckpoint(checkpointPath, createReport('running', {
      taskId: planned.taskId,
      strategy: planned.strategy,
      repetition: planned.repetition,
      tokenCeiling: tokenAllocation.tokenCeiling,
      startedAt: new Date().toISOString(),
    }));
    const result = await runOne(planned, getTask(planned.taskId), options, tokenAllocation.tokenCeiling, remainingUsd);
    runs.push(result);
    measuredTokens += result.measuredTokens;
    if (result.measuredCostUsd === null) allPriced = false;
    else measuredCostUsd += result.measuredCostUsd;
    await writeBaselineCheckpoint(checkpointPath, createReport('running', null));
    if (result.unknownRequests > 0) { stoppedEarly = true; stopReason = 'provider-usage-unknown'; break; }
    if (result.terminationReason === 'deadline') { stoppedEarly = true; stopReason = 'run-timeout'; break; }
    if (result.terminationReason === 'approval_required') { stoppedEarly = true; stopReason = 'run-waiting-for-approval'; break; }
    if (result.terminationReason === 'user_input_required') { stoppedEarly = true; stopReason = 'run-needs-user-input'; break; }
    if (result.status === 'paused') {
      stoppedEarly = true;
      stopReason = result.errorCode === 'BUDGET_EXHAUSTED' ? 'run-budget-exhausted' : result.errorCode === 'TOOL_OUTCOME_UNKNOWN' ? 'run-tool-outcome-unknown' : 'run-paused';
      break;
    }
    if (result.status === 'interrupted' || result.status === 'cancelled') { stoppedEarly = true; stopReason = 'run-did-not-finish'; break; }
  }
  const report = createReport('finished', null);
  await writeBaselineCheckpoint(checkpointPath, report);
  return report;
}

async function writeBaselineCheckpoint(path: string, report: unknown, exclusive = false): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (exclusive) {
    await writeFile(path, serialized, { encoding: 'utf8', flag: 'wx' });
    return;
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertReportPathAvailable(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (path.endsWith('.partial')) throw new Error(`Baseline progress checkpoint already exists; inspect it and choose a new --output path instead of overwriting it: ${path}`);
  throw new Error(`Baseline report path already exists; choose a new path: ${path}`);
}

async function runOne(
  planned: BaselineRun,
  task: EvalTask,
  options: Options,
  tokenCeiling: number,
  remainingUsd: number,
): Promise<RunResult> {
  const sandboxRoot = await mkdtemp(join(tmpdir(), `agent-office-eval-${task.id.toLowerCase()}-`));
  const dataDir = join(sandboxRoot, 'data');
  const workspaceRoot = join(sandboxRoot, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFixtures(workspaceRoot, task.fixtures);

  let db: DatabaseClient | undefined;
  let runtime: AgentRuntime | undefined;
  const startedAt = Date.now();
  let runId: string | null = null;
  let projectId: string | null = null;
  let approvalsAutomaticallyAccepted = 0;
  let pendingApprovals = 0;
  let terminationReason: RunResult['terminationReason'] = null;
  let stateBeforeHarnessStop: RunResult['stateBeforeHarnessStop'] = null;
  try {
    const registry = await loadRegistry(process.cwd());
    if (options.modelProfile) {
      if (!registry.profiles.has(options.modelProfile)) throw new Error(`Unknown model profile: ${options.modelProfile}.`);
      for (const definition of registry.definitions.values()) definition.manifest.modelProfile = options.modelProfile;
    }
    restrictRegistry(registry, task, planned.strategy);
    registry.policy.limits.maxOutputTokensPerCall = options.maxOutputTokens;
    registry.policy.limits.maxTokensPerRun = tokenCeiling;
    registry.policy.approvals.shell = options.dockerChecks ? 'docker' : 'disabled';
    const modelProfile = options.modelProfile ?? 'primary';
    const modelConfig = resolveModelProfile(registry, modelProfile, loadAppConfig(process.env));
    const priceKnown = areActiveProfilesPriced(registry, task, planned.strategy, modelConfig.model);
    if (!priceKnown && !options.allowUnpriced) throw new Error('This model profile has no exact configured price. Pass --allow-unpriced to run under the hard token ceiling and record USD cost as unknown.');
    registry.policy.limits.moneyBudgetUsd = priceKnown ? Math.max(0.000001, Math.min(planned.maxBudgetUsd, remainingUsd)) : null;

    const config = loadAppConfig({ ...process.env, OFFICE_DATA_DIR: dataDir, OFFICE_CONFIG_DIR: process.cwd(), OFFICE_EXECUTION_MODE: options.dockerChecks ? 'docker' : 'disabled' });
    db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const projects = new ProjectService(db, events, registry);
    const artifacts = new ArtifactService(db, events, dataDir);
    await projects.seedRegistry();
    runtime = new AgentRuntime(db, events, projects, registry, artifacts, config);
    await runtime.recover();

    const project = await projects.createProject({
      name: `Eval ${task.id} ${planned.strategy} ${planned.repetition}`,
      goal: `${task.input}\n\nUntrusted fixture input:\n${formatFixtures(task.fixtures)}`,
      workspaceRoot,
    });
    projectId = project.id;
    const fixtureList = task.fixtures.map(({ path }) => `- ${path}`).join('\n');
    const requestText = `${task.input}\n\nFixture files are in the isolated project workspace:\n${fixtureList}\n\nUntrusted fixture contents:\n${formatFixtures(task.fixtures)}\n\nUse only tools listed in this task's allowed-tool list: ${task.allowedTools.join(', ') || '(none)'}. Do not claim checks or external actions that were not performed.`;
    const request = await projects.createUserMessage(project.id, project.conversationId, requestText);
    runId = request.runId;
    const moneyCeiling = priceKnown ? Math.max(0.000001, Math.min(planned.maxBudgetUsd, remainingUsd)) : null;
    await db.run('UPDATE runs SET token_budget = ?, money_budget_microusd = ? WHERE id = ?', [tokenCeiling, moneyCeiling === null ? null : Math.floor(moneyCeiling * 1_000_000), runId]);
    runtime.enqueue(runId);

    const deadline = Date.now() + options.timeoutSeconds * 1_000;
    let terminal: string | null = null;
    while (Date.now() < deadline) {
      const state = await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [runId]);
      if (state && ['succeeded', 'failed', 'cancelled', 'interrupted', 'paused'].includes(state.status)) { terminal = state.status; break; }
      const approvals = await pendingRunApprovals(db, runId);
      if (approvals.length) {
        if (!options.approveIsolatedOperations) { pendingApprovals = approvals.length; break; }
        for (const approval of approvals) {
          if (!isSafeIsolatedWorkspaceApproval(approval.tool_id, approval.arguments_json, workspaceRoot, options.dockerChecks)) throw new Error(`Refusing non-isolated approval for ${approval.tool_id}.`);
          const decided = await runtime.decideApproval(approval.id, 'approve');
          if (decided.status === 'approved' || decided.status === 'executing') approvalsAutomaticallyAccepted++;
        }
      }
      if (state?.status === 'waiting_approval' && approvals.length === 0) { terminal = state.status; terminationReason = 'user_input_required'; break; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    if (!terminal && (pendingApprovals || Date.now() >= deadline)) {
      const beforeStop = await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [runId]);
      if (beforeStop && ['succeeded', 'failed', 'cancelled', 'interrupted', 'paused'].includes(beforeStop.status)) {
        terminal = beforeStop.status;
      } else {
        const tasksBeforeStop = await projects.getTasks(runId);
        stateBeforeHarnessStop = {
          runStatus: beforeStop?.status ?? null,
          tasks: tasksBeforeStop.map((task) => ({ title: task.title, status: task.status, assignedAgentId: task.assignedAgentId })),
        };
        terminationReason = pendingApprovals ? 'approval_required' : 'deadline';
        await runtime.cancel(runId).catch(() => false);
        terminal = 'interrupted';
      }
    }
    const state = await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [runId]);
    const usage = await readRunUsage(db, runId);
    const usageByAgent = await db.all<{ agent_instance_id: string | null; request_count: number; measured_tokens: number }>(
      'SELECT agent_instance_id, COUNT(*) AS request_count, SUM(total_tokens) AS measured_tokens FROM model_usage WHERE run_id = ? GROUP BY agent_instance_id ORDER BY agent_instance_id', [runId],
    );
    const toolOperationRows = await db.all<{ tool_id: string; status: string; count: number }>(
      'SELECT tool_id, status, COUNT(*) AS count FROM tool_operations WHERE run_id = ? GROUP BY tool_id, status ORDER BY tool_id, status', [runId],
    );
    const planRepairRows = await db.all<{ payload_json: string }>(
      "SELECT payload_json FROM domain_events WHERE type = 'coordinator.plan_repair_attempted' AND aggregate_id = ? ORDER BY sequence", [runId],
    );
    const planRepairs = planRepairRows.map(({ payload_json }) => {
      const payload = JSON.parse(payload_json) as Record<string, unknown>;
      return {
        attempt: Number(payload.attempt),
        errorCode: typeof payload.errorCode === 'string' ? payload.errorCode : 'PLAN_INVALID',
        fieldIssues: Array.isArray(payload.fieldIssues) ? payload.fieldIssues.filter((item): item is string => typeof item === 'string').slice(0, 8) : [],
        willRetry: payload.willRetry === true,
      };
    });
    const tasks = await projects.getTasks(runId);
    const messages = (await projects.listMessages(project.conversationId)).filter((message) => message.runId === runId).map((message) => ({
      speaker: message.speaker,
      agentInstanceId: message.agentInstanceId,
      status: message.status,
      content: message.content.slice(0, MAX_CAPTURED_TEXT_CHARS),
    }));
    const artifactList = await artifacts.list(project.id);
    const artifactContents = await Promise.all(artifactList.map(async (artifact) => {
      const loaded = await artifacts.content(artifact.versionId);
      return { name: artifact.logicalName, mimeType: artifact.mimeType, checksum: artifact.checksum, sizeBytes: artifact.sizeBytes,
        content: loaded && artifact.sizeBytes <= MAX_CAPTURED_TEXT_CHARS ? loaded.content.toString('utf8') : null };
    }));
    const workspaceFiles = await listWorkspaceChecksums(workspaceRoot);
    const costUsd = usage.unpricedRequests || usage.unknownRequests || usage.reservedTokens > 0 ? null : usage.measuredCostMicrousd / 1_000_000;
    return {
      taskId: task.id, category: task.category, strategy: planned.strategy, repetition: planned.repetition,
      status: terminationReason === 'approval_required' || terminationReason === 'user_input_required' ? 'waiting_approval' : terminationReason === 'deadline' ? 'timed_out' : state?.status ?? terminal ?? 'missing',
      errorCode: terminationReason === 'deadline' ? 'EVAL_RUN_TIMEOUT'
        : terminationReason === 'approval_required' ? 'EVAL_APPROVAL_REQUIRED'
          : terminationReason === 'user_input_required' ? 'EVAL_USER_INPUT_REQUIRED' : state?.error_code ?? null,
      planRepairs,
      terminationReason, stateBeforeHarnessStop,
      durationMs: Date.now() - startedAt, modelRequests: usage.modelRequests,
      usageByAgent: usageByAgent.map((row) => ({ agentInstanceId: row.agent_instance_id, requestCount: row.request_count, measuredTokens: row.measured_tokens })),
      measuredTokens: usage.measuredTokens,
      reservedTokens: usage.reservedTokens, unknownRequests: usage.unknownRequests, unpricedRequests: usage.unpricedRequests,
      measuredCostUsd: costUsd, costCeilingUsd: planned.maxBudgetUsd,
      toolOperations: summarizeBaselineToolOperations(toolOperationRows),
      automatedIsolatedApprovals: approvalsAutomaticallyAccepted, pendingApprovals,
      tasks: tasks.map((item) => ({ title: item.title, status: item.status, assignedAgentId: item.assignedAgentId, output: item.output?.slice(0, MAX_CAPTURED_TEXT_CHARS) ?? null })),
      messages, artifacts: artifactContents, workspaceFiles,
      expectedProperties: task.expectedProperties, acceptance: task.acceptance, reviewerRubric: task.reviewerRubric,
      qualityReview: 'human-review-required',
    };
  } finally {
    if (runtime) await runtime.stop().catch(() => undefined);
    if (db) await db.close().catch(() => undefined);
    await rm(sandboxRoot, { recursive: true, force: true });
  }
}

function restrictRegistry(registry: Registry, task: EvalTask, strategy: BaselineStrategy): void {
  const singleDefinition: Record<EvalTask['category'], string> = {
    coding: 'developer', research: 'researcher', analysis: 'analyst', 'orchestration-recovery': 'reviewer',
  };
  if (strategy === 'single-agent') {
    const definition = singleDefinition[task.category];
    for (const entry of registry.roster) entry.enabled = entry.enabled && entry.definition === definition;
  }
  const allowed = new Set(task.allowedTools);
  for (const definition of registry.definitions.values()) {
    if (definition.manifest.kind === 'specialist') definition.manifest.allowedTools = definition.manifest.allowedTools.filter((toolId) => allowed.has(toolId));
  }
}

function activeModelProfiles(plan: BaselinePlan, registry: Registry): string[] {
  const ids = new Set<string>([registry.definitions.get('coordinator')?.manifest.modelProfile ?? 'primary']);
  for (const run of plan.runs) {
    const task = getTask(run.taskId);
    if (run.strategy === 'single-agent') {
      const definition = task.category === 'coding' ? 'developer' : task.category === 'research' ? 'researcher' : task.category === 'analysis' ? 'analyst' : 'reviewer';
      const profile = registry.definitions.get(definition)?.manifest.modelProfile;
      if (profile) ids.add(profile);
    } else {
      for (const entry of registry.roster) {
        if (!entry.enabled) continue;
        const profile = registry.definitions.get(entry.definition)?.manifest.modelProfile;
        if (profile) ids.add(profile);
      }
    }
  }
  return [...ids];
}

function areActiveProfilesPriced(registry: Registry, task: EvalTask, strategy: BaselineStrategy, modelName: string): boolean {
  const ids = new Set([registry.definitions.get('coordinator')?.manifest.modelProfile ?? 'primary']);
  if (strategy === 'single-agent') {
    const definition = task.category === 'coding' ? 'developer' : task.category === 'research' ? 'researcher' : task.category === 'analysis' ? 'analyst' : 'reviewer';
    const profile = registry.definitions.get(definition)?.manifest.modelProfile;
    if (profile) ids.add(profile);
  } else {
    for (const entry of registry.roster) {
      if (!entry.enabled) continue;
      const profile = registry.definitions.get(entry.definition)?.manifest.modelProfile;
      if (profile) ids.add(profile);
    }
  }
  return [...ids].every((id) => {
    const profile = registry.profiles.get(id);
    return !!profile?.pricing && profile.pricing.modelName === modelName;
  });
}

function resolveModelProfile(registry: Registry, profileId: string, config: AppConfig, env: NodeJS.ProcessEnv = process.env): ResolvedModelProfile {
  const profile = registry.profiles.get(profileId);
  if (!profile) throw new Error(`Unknown model profile: ${profileId}.`);
  const baseUrl = profileEnvValue(env, profile.baseUrlEnv, 'MODEL_PRIMARY_BASE_URL', config.model.baseUrl).trim().replace(/\/+$/, '');
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); }
  catch { throw new Error(`Model profile ${profileId} has an invalid base URL.`); }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) {
    throw new Error(`Model profile ${profileId} must use HTTPS; HTTP is allowed only for loopback providers.`);
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error(`Model profile ${profileId} base URL may not contain credentials, query parameters, or a fragment.`);
  return {
    id: profileId,
    baseUrl,
    apiKey: profileEnvValue(env, profile.apiKeyEnv, 'MODEL_PRIMARY_API_KEY', config.model.apiKey).trim(),
    model: profileEnvValue(env, profile.modelEnv, 'MODEL_PRIMARY_NAME', config.model.name).trim(),
  };
}

async function writeFixtures(workspaceRoot: string, fixtures: EvalTask['fixtures']): Promise<void> {
  const realRoot = await realpath(workspaceRoot);
  for (const fixture of fixtures) {
    const target = resolveFixturePath(realRoot, fixture.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, fixture.content, { encoding: 'utf8', flag: 'wx' });
  }
}

interface PendingApproval { id: string; tool_id: string; arguments_json: string }

async function pendingRunApprovals(db: DatabaseClient, runId: string): Promise<PendingApproval[]> {
  return db.all<PendingApproval>(`SELECT a.id, o.tool_id, a.arguments_json
    FROM approvals a JOIN tool_operations o ON o.id = a.operation_id
    WHERE a.run_id = ? AND a.status = 'pending' ORDER BY a.expires_at`, [runId]);
}

async function readRunUsage(db: DatabaseClient, runId: string): Promise<{
  modelRequests: number; measuredTokens: number; reservedTokens: number; unknownRequests: number; unpricedRequests: number; measuredCostMicrousd: number;
}> {
  const row = await db.one<{ modelRequests: number; measuredTokens: number; reservedTokens: number; unknownRequests: number; unpricedRequests: number; measuredCostMicrousd: number }>(`SELECT COUNT(*) AS modelRequests,
    COALESCE(SUM(CASE WHEN status = 'settled' THEN total_tokens ELSE 0 END),0) AS measuredTokens,
    COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN prompt_reservation + output_reservation ELSE 0 END),0) AS reservedTokens,
    SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknownRequests,
    SUM(CASE WHEN pricing_version IS NULL THEN 1 ELSE 0 END) AS unpricedRequests,
    COALESCE(SUM(CASE WHEN status = 'settled' THEN COALESCE(actual_cost_microusd,0) ELSE 0 END),0) AS measuredCostMicrousd
    FROM model_call_reservations WHERE run_id = ?`, [runId]);
  return row ?? { modelRequests: 0, measuredTokens: 0, reservedTokens: 0, unknownRequests: 0, unpricedRequests: 0, measuredCostMicrousd: 0 };
}

async function listWorkspaceChecksums(root: string): Promise<Array<{ path: string; checksum: string; sizeBytes: number }>> {
  const results: Array<{ path: string; checksum: string; sizeBytes: number }> = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const content = await readFile(absolute);
        results.push({ path: relative(root, absolute).replace(/\\/g, '/'), checksum: createHash('sha256').update(content).digest('hex'), sizeBytes: content.byteLength });
      }
    }
  };
  await visit(root);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function summarize(runs: RunResult[], plan: BaselinePlan, measuredCostUsd: number | null, maxTotalTokens: number): Record<string, unknown> {
  const pairedComparison = summarizePairedComparisons(plan, runs);
  const byStrategy = Object.fromEntries(['single-agent', 'multi-agent'].map((strategy) => {
    const selected = runs.filter((run) => run.strategy === strategy);
    return [strategy, {
      plannedRuns: plan.runs.filter((run) => run.strategy === strategy).length,
      attemptedRuns: selected.length,
      completedRuns: selected.filter((run) => run.status === 'succeeded').length,
      failedRuns: selected.filter((run) => run.status === 'failed').length,
      pausedRuns: selected.filter((run) => run.status === 'paused').length,
      executionSucceeded: selected.filter((run) => run.status === 'succeeded').length,
      pendingApprovalRuns: selected.filter((run) => run.terminationReason === 'approval_required').length,
      userInputRuns: selected.filter((run) => run.terminationReason === 'user_input_required').length,
      timedOutRuns: selected.filter((run) => run.terminationReason === 'deadline').length,
      modelRequests: selected.reduce((sum, run) => sum + run.modelRequests, 0),
      measuredTokens: selected.reduce((sum, run) => sum + run.measuredTokens, 0),
      meanLatencyMs: mean(selected.map((run) => run.durationMs)),
      qualityScoring: 'manual; no model-generated quality score is counted',
    }];
  }));
  const latencies = runs.map((run) => run.durationMs).sort((a, b) => a - b);
  return {
    plannedRuns: plan.runs.length,
    attemptedRuns: runs.length,
    notAttemptedRuns: Math.max(0, plan.runs.length - runs.length),
    completedRunStates: runs.filter((run) => ['succeeded', 'failed'].includes(run.status)).length,
    pausedRuns: runs.filter((run) => run.status === 'paused').length,
    executionSuccessRate: runs.length ? runs.filter((run) => run.status === 'succeeded').length / runs.length : null,
    modelRequests: runs.reduce((sum, run) => sum + run.modelRequests, 0),
    measuredTokens: runs.reduce((sum, run) => sum + run.measuredTokens, 0),
    reservedTokens: runs.reduce((sum, run) => sum + run.reservedTokens, 0),
    unknownRequests: runs.reduce((sum, run) => sum + run.unknownRequests, 0),
    unpricedRequests: runs.reduce((sum, run) => sum + run.unpricedRequests, 0),
    measuredCostUsd,
    costCeilingUsd: plan.maxTotalUsd,
    costCeilingEnforced: runs.every((run) => run.unpricedRequests === 0 && run.unknownRequests === 0),
    tokenCeiling: maxTotalTokens,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    manualInterventionCount: runs.reduce((sum, run) => sum + run.pendingApprovals, 0),
    timedOutRuns: runs.filter((run) => run.terminationReason === 'deadline').length,
    userInputRuns: runs.filter((run) => run.terminationReason === 'user_input_required').length,
    byStrategy,
    pairedComparison,
    note: 'Execution status is not a quality pass. Review each answer against expectedProperties, acceptance, and reviewerRubric before comparing quality.',
  };
}

function mean(values: number[]): number | null { return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null; }
function percentile(sorted: number[], quantile: number): number | null { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]! : null; }
function getTask(id: string): EvalTask { const task = agentOfficeV1Corpus.find((item) => item.id === id); if (!task) throw new Error(`Unknown eval task: ${id}.`); return task; }
function printJson(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function formatFixtures(fixtures: EvalTask['fixtures']): string {
  return fixtures.map((fixture) => `### ${fixture.path}\n\`\`\`\n${fixture.content}\n\`\`\``).join('\n\n');
}

function parseArgs(args: string[]): Options | 'help' {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: npm run eval:baseline -- [--dry-run | --live] [--tasks C01,R01,...] [--repetitions 3] [--strategies single-agent,multi-agent] [--model-profile PROFILE] [--max-total-usd 16.20] [--max-total-tokens N] [--max-tokens-per-run 40000] [--max-output-tokens 2048] [--min-request-interval-ms 8000] [--allow-unpriced] [--approve-isolated-operations] [--docker-checks] [--output PATH]\n');
    return 'help';
  }
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const result = args[index + 1]?.trim();
    if (!result || result.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    return result;
  };
  const numeric = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const number = Number(raw);
    if (!Number.isFinite(number)) throw new Error(`${flag} must be a finite number.`);
    return number;
  };
  const strategyArg = value('--strategies');
  const strategies = strategyArg?.split(',').map((item) => item.trim()) as BaselineStrategy[] | undefined;
  const live = args.includes('--live');
  if (live && args.includes('--dry-run')) throw new Error('Choose only one of --live or --dry-run.');
  const taskArg = value('--tasks');
  const maxTotalUsd = numeric('--max-total-usd', 16.2);
  if (maxTotalUsd <= 0) throw new Error('--max-total-usd must be positive.');
  const maxOutputTokens = numeric('--max-output-tokens', DEFAULT_MAX_OUTPUT_TOKENS);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 4096) throw new Error('--max-output-tokens must be an integer from 64 to 4096.');
  const maxTokensPerRun = numeric('--max-tokens-per-run', DEFAULT_MAX_TOKENS_PER_RUN);
  if (!Number.isInteger(maxTokensPerRun) || maxTokensPerRun < MIN_REMAINING_TOKENS_TO_START_RUN || maxTokensPerRun > MAX_TOKENS_PER_RUN) throw new Error(`--max-tokens-per-run must be an integer from ${MIN_REMAINING_TOKENS_TO_START_RUN} to ${MAX_TOKENS_PER_RUN}.`);
  const timeoutSeconds = numeric('--timeout-seconds', 300);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) throw new Error('--timeout-seconds must be an integer from 30 to 3600.');
  const minProviderRequestIntervalMs = numeric('--min-request-interval-ms', 8_000);
  if (!Number.isInteger(minProviderRequestIntervalMs) || minProviderRequestIntervalMs < 0 || minProviderRequestIntervalMs > 60_000) throw new Error('--min-request-interval-ms must be an integer from 0 to 60000.');
  return {
    live,
    ...(taskArg ? { taskIds: resolveBaselineTaskIds(taskArg) } : {}),
    ...(strategies ? { strategies } : {}),
    repetitions: numeric('--repetitions', 3),
    maxTotalUsd,
    ...(value('--max-total-tokens') ? { maxTotalTokens: numeric('--max-total-tokens', 0) } : {}),
    maxTokensPerRun,
    maxOutputTokens,
    timeoutSeconds,
    approveIsolatedOperations: args.includes('--approve-isolated-operations'),
    dockerChecks: args.includes('--docker-checks'),
    allowUnpriced: args.includes('--allow-unpriced'),
    minProviderRequestIntervalMs,
    ...(value('--model-profile') ? { modelProfile: value('--model-profile') } : {}),
    ...(value('--output') ? { outputPath: value('--output') } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runBaselineCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Eval baseline failed.'}\n`);
    process.exitCode = 1;
  });
}

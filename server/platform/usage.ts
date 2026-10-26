import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatTool, ModelUsage } from './models/chat-completions';
import type { DatabaseClient } from './database';

export class RunTokenBudgetExceeded extends Error {
  readonly code = 'RUN_TOKEN_BUDGET_EXCEEDED';

  constructor(readonly limit: number, readonly requested: number, readonly committed: number) {
    super(`Lượt chạy đã hết ngân sách token (${committed}/${limit}); yêu cầu tiếp theo cần dự phòng ${requested} token.`);
    this.name = 'RunTokenBudgetExceeded';
  }
}

export class RunMoneyBudgetExceeded extends Error {
  readonly code = 'RUN_MONEY_BUDGET_EXCEEDED';

  constructor(readonly limitMicrousd: number, readonly requestedMicrousd: number, readonly committedMicrousd: number) {
    super(`Lượt chạy đã hết ngân sách tiền (USD ${formatUsd(committedMicrousd)}/${formatUsd(limitMicrousd)}); yêu cầu tiếp theo cần dự phòng USD ${formatUsd(requestedMicrousd)}.`);
    this.name = 'RunMoneyBudgetExceeded';
  }
}

export class ModelPricingRequiredError extends Error {
  readonly code = 'MODEL_PRICING_REQUIRED';

  constructor() {
    super('Run có giới hạn tiền nhưng model chưa khớp price profile. Hãy cấu hình model và giá trước khi tiếp tục.');
    this.name = 'ModelPricingRequiredError';
  }
}

export interface ModelPricing {
  modelName: string;
  version: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface ProjectUsageSummary {
  limitTokensPerRun: number;
  measuredTokens: number;
  reservedTokens: number;
  measuredCostMicrousd: number;
  reservedCostMicrousd: number;
  unpricedRequests: number;
  runs: Array<{
    runId: string;
    status: string;
    limitTokens: number;
    measuredTokens: number;
    reservedTokens: number;
    remainingTokens: number;
    pendingRequests: number;
    unknownRequests: number;
    moneyBudgetMicrousd: number | null;
    measuredCostMicrousd: number;
    reservedCostMicrousd: number;
    unpricedRequests: number;
  }>;
  byAgent: Array<{
    agentInstanceId: string | null;
    displayName: string | null;
    measuredTokens: number;
    reservedTokens: number;
    requestCount: number;
  }>;
}

export function estimatePromptTokenCeiling(messages: ChatMessage[], tools: ChatTool[] = []): number {
  // UTF-8 bytes are a conservative preflight bound for byte-fallback tokenizers.
  // Extra framing covers roles, separators and provider-side message metadata.
  const payload = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8');
  return payload + messages.length * 32 + tools.length * 64 + 256;
}

export class UsageLedger {
  constructor(private readonly db: DatabaseClient, readonly limitTokens: number) {}

  async reserve(input: {
    runId: string;
    taskId: string | null;
    agentInstanceId: string;
    promptTokens: number;
    outputTokens: number;
    pricing?: ModelPricing;
  }): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const run = await this.db.one<{ token_budget: number; money_budget_microusd: number | null }>('SELECT token_budget, money_budget_microusd FROM runs WHERE id = ?', [input.runId]);
    if (!run) throw new Error('Không tìm thấy lượt chạy để giữ ngân sách token.');
    const limitTokens = run.token_budget;
    const promptTokens = Math.max(0, Math.ceil(input.promptTokens));
    const outputTokens = Math.max(0, Math.ceil(input.outputTokens));
    const requested = promptTokens + outputTokens;
    if (run.money_budget_microusd !== null && !input.pricing) throw new ModelPricingRequiredError();
    const inputRate = input.pricing?.inputUsdPerMillionTokens ?? null;
    const outputRate = input.pricing?.outputUsdPerMillionTokens ?? null;
    const reservedCostMicrousd = input.pricing ? calculateCostMicrousd(promptTokens, outputTokens, input.pricing) : 0;
    const result = await this.db.run(`INSERT INTO model_call_reservations(
      id, run_id, task_id, agent_instance_id, prompt_reservation, output_reservation,
      input_rate_usd_per_million, output_rate_usd_per_million, pricing_model, pricing_version, reserved_cost_microusd, status, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ? WHERE
      COALESCE((SELECT SUM(CASE WHEN status = 'settled' THEN total_tokens ELSE prompt_reservation + output_reservation END)
        FROM model_call_reservations WHERE run_id = ?), 0) + ? <= ? AND
      (? IS NULL OR COALESCE((SELECT SUM(CASE WHEN status = 'settled' THEN COALESCE(actual_cost_microusd, reserved_cost_microusd) ELSE reserved_cost_microusd END)
        FROM model_call_reservations WHERE run_id = ?), 0) + ? <= ?)`,
    [id, input.runId, input.taskId, input.agentInstanceId, promptTokens, outputTokens, inputRate, outputRate, input.pricing?.modelName ?? null, input.pricing?.version ?? null, reservedCostMicrousd, now,
      input.runId, requested, limitTokens, run.money_budget_microusd, input.runId, reservedCostMicrousd, run.money_budget_microusd]);
    if (result.changes !== 1) {
      const row = await this.db.one<{ committedTokens: number; committedMicrousd: number }>(`SELECT
        COALESCE(SUM(CASE WHEN status = 'settled' THEN total_tokens ELSE prompt_reservation + output_reservation END), 0) AS committedTokens,
        COALESCE(SUM(CASE WHEN status = 'settled' THEN COALESCE(actual_cost_microusd, reserved_cost_microusd) ELSE reserved_cost_microusd END), 0) AS committedMicrousd
        FROM model_call_reservations WHERE run_id = ?`, [input.runId]);
      const committedTokens = row?.committedTokens ?? 0;
      if (committedTokens + requested > limitTokens) throw new RunTokenBudgetExceeded(limitTokens, requested, committedTokens);
      if (run.money_budget_microusd !== null) throw new RunMoneyBudgetExceeded(run.money_budget_microusd, reservedCostMicrousd, row?.committedMicrousd ?? 0);
      throw new Error('Không thể giữ ngân sách cho lượt gọi model.');
    }
    return id;
  }

  async settle(id: string, requestId: string, usage: ModelUsage | null): Promise<void> {
    const now = new Date().toISOString();
    if (!usage) {
      await this.db.run("UPDATE model_call_reservations SET status = 'unknown', request_id = ?, completed_at = ? WHERE id = ? AND status = 'reserved'", [requestId || null, now, id]);
      return;
    }
    const promptTokens = Math.max(0, Math.floor(usage.promptTokens));
    const completionTokens = Math.max(0, Math.floor(usage.completionTokens));
    const totalTokens = Math.max(promptTokens + completionTokens, Math.floor(usage.totalTokens));
    const price = await this.db.one<{ input_rate_usd_per_million: number | null; output_rate_usd_per_million: number | null }>(
      'SELECT input_rate_usd_per_million, output_rate_usd_per_million FROM model_call_reservations WHERE id = ? AND status = \'reserved\'', [id],
    );
    const actualCostMicrousd = price && price.input_rate_usd_per_million !== null && price.output_rate_usd_per_million !== null
      ? calculateCostMicrousd(promptTokens, completionTokens, { inputUsdPerMillionTokens: price.input_rate_usd_per_million, outputUsdPerMillionTokens: price.output_rate_usd_per_million })
      : null;
    await this.db.batch([
      { mode: 'run', sql: `INSERT INTO model_usage(id, run_id, task_id, agent_instance_id, request_id, prompt_tokens, completion_tokens, total_tokens, created_at)
        SELECT ?, run_id, task_id, agent_instance_id, ?, ?, ?, ?, ? FROM model_call_reservations WHERE id = ? AND status = 'reserved'`,
      params: [randomUUID(), requestId || null, promptTokens, completionTokens, totalTokens, now, id] },
      { mode: 'run', sql: `UPDATE model_call_reservations SET request_id = ?, prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, actual_cost_microusd = ?, status = 'settled', completed_at = ?
        WHERE id = ? AND status = 'reserved'`, params: [requestId || null, promptTokens, completionTokens, totalTokens, actualCostMicrousd, now, id] },
    ], true);
  }

  async markUnknown(id: string): Promise<void> {
    await this.db.run("UPDATE model_call_reservations SET status = 'unknown', completed_at = ? WHERE id = ? AND status = 'reserved'", [new Date().toISOString(), id]);
  }

  async reconcileOnStartup(): Promise<void> {
    await this.db.run("UPDATE model_call_reservations SET status = 'unknown', completed_at = ? WHERE status = 'reserved'", [new Date().toISOString()]);
  }

  async projectSummary(projectId: string): Promise<ProjectUsageSummary> {
    const [totals, runs, byAgent] = await Promise.all([
      this.db.one<{ measured: number; reserved: number; measuredCost: number; reservedCost: number; unpriced: number }>(`SELECT
        COALESCE(SUM(CASE WHEN c.status = 'settled' THEN c.total_tokens ELSE 0 END), 0) AS measured,
        COALESCE(SUM(CASE WHEN c.status <> 'settled' THEN c.prompt_reservation + c.output_reservation ELSE 0 END), 0) AS reserved,
        COALESCE(SUM(CASE WHEN c.status = 'settled' THEN COALESCE(c.actual_cost_microusd, 0) ELSE 0 END), 0) AS measuredCost,
        COALESCE(SUM(CASE WHEN c.status <> 'settled' THEN c.reserved_cost_microusd ELSE 0 END), 0) AS reservedCost,
        COALESCE(SUM(CASE WHEN c.pricing_version IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
        FROM model_call_reservations c JOIN runs r ON r.id = c.run_id WHERE r.project_id = ?`, [projectId]),
      this.db.all<{ runId: string; status: string; limitTokens: number; measuredTokens: number; reservedTokens: number; pendingRequests: number; unknownRequests: number; moneyBudgetMicrousd: number | null; measuredCostMicrousd: number; reservedCostMicrousd: number; unpricedRequests: number }>(`SELECT
        r.id AS runId, r.status, r.token_budget AS limitTokens, r.money_budget_microusd AS moneyBudgetMicrousd,
        COALESCE(SUM(CASE WHEN c.status = 'settled' THEN c.total_tokens ELSE 0 END), 0) AS measuredTokens,
        COALESCE(SUM(CASE WHEN c.status <> 'settled' THEN c.prompt_reservation + c.output_reservation ELSE 0 END), 0) AS reservedTokens,
        COALESCE(SUM(CASE WHEN c.status = 'settled' THEN COALESCE(c.actual_cost_microusd, 0) ELSE 0 END), 0) AS measuredCostMicrousd,
        COALESCE(SUM(CASE WHEN c.status <> 'settled' THEN c.reserved_cost_microusd ELSE 0 END), 0) AS reservedCostMicrousd,
        COALESCE(SUM(CASE WHEN c.id IS NOT NULL AND c.pricing_version IS NULL THEN 1 ELSE 0 END), 0) AS unpricedRequests,
        SUM(CASE WHEN c.status = 'reserved' THEN 1 ELSE 0 END) AS pendingRequests,
        SUM(CASE WHEN c.status = 'unknown' THEN 1 ELSE 0 END) AS unknownRequests
        FROM runs r LEFT JOIN model_call_reservations c ON c.run_id = r.id WHERE r.project_id = ?
        GROUP BY r.id ORDER BY r.created_at DESC`, [projectId]),
      this.db.all<{ agentInstanceId: string | null; displayName: string | null; measuredTokens: number; reservedTokens: number; requestCount: number }>(`SELECT
        c.agent_instance_id AS agentInstanceId, i.display_name AS displayName,
        COALESCE(SUM(CASE WHEN c.status = 'settled' THEN c.total_tokens ELSE 0 END), 0) AS measuredTokens,
        COALESCE(SUM(CASE WHEN c.status <> 'settled' THEN c.prompt_reservation + c.output_reservation ELSE 0 END), 0) AS reservedTokens,
        COUNT(*) AS requestCount
        FROM model_call_reservations c JOIN runs r ON r.id = c.run_id LEFT JOIN agent_instances i ON i.id = c.agent_instance_id
        WHERE r.project_id = ? GROUP BY c.agent_instance_id, i.display_name ORDER BY measuredTokens + reservedTokens DESC`, [projectId]),
    ]);
    const measuredTokens = totals?.measured ?? 0;
    const reservedTokens = totals?.reserved ?? 0;
    return {
      limitTokensPerRun: this.limitTokens,
      measuredTokens,
      reservedTokens,
      measuredCostMicrousd: totals?.measuredCost ?? 0,
      reservedCostMicrousd: totals?.reservedCost ?? 0,
      unpricedRequests: totals?.unpriced ?? 0,
      runs: runs.map((run) => ({ ...run, remainingTokens: Math.max(0, run.limitTokens - run.measuredTokens - run.reservedTokens) })),
      byAgent,
    };
  }
}

function calculateCostMicrousd(promptTokens: number, outputTokens: number, pricing: Pick<ModelPricing, 'inputUsdPerMillionTokens' | 'outputUsdPerMillionTokens'>): number {
  const amount = promptTokens * pricing.inputUsdPerMillionTokens + outputTokens * pricing.outputUsdPerMillionTokens;
  if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) throw new Error('Giá model tạo ra số tiền không hợp lệ.');
  return Math.ceil(amount);
}

function formatUsd(microusd: number): string {
  return (microusd / 1_000_000).toFixed(6);
}

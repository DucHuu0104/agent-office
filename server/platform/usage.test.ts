import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';
import { ModelPricingRequiredError, RunMoneyBudgetExceeded, RunTokenBudgetExceeded, UsageLedger } from './usage';

describe('per-run model token budget', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let projects: ProjectService;
  let runId: string;
  let projectId: string;
  let coordinatorId: string;
  let conversationId: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-usage-'));
    db = await DatabaseClient.open(dataDir, true);
    const registry = await loadRegistry(process.cwd());
    projects = new ProjectService(db, new EventHub(db), registry);
    await projects.seedRegistry();
    const project = await projects.createProject({ name: 'Usage test', goal: '' });
    projectId = project.id;
    coordinatorId = project.coordinatorInstanceId;
    conversationId = project.conversationId;
    runId = (await projects.createUserMessage(project.id, project.conversationId, 'Measure model usage')).runId;
    await db.run('UPDATE runs SET token_budget = 1000 WHERE id = ?', [runId]);
  });

  afterEach(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reserves before dispatch and replaces the reservation with provider usage', async () => {
    const ledger = new UsageLedger(db, 1000);
    const reservationId = await ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 300, outputTokens: 100 });

    expect((await ledger.projectSummary(projectId)).runs[0]).toMatchObject({ reservedTokens: 400, measuredTokens: 0, remainingTokens: 600, pendingRequests: 1 });

    await ledger.settle(reservationId, 'provider-call-1', { promptTokens: 120, completionTokens: 30, totalTokens: 150 });

    const summary = await ledger.projectSummary(projectId);
    expect(summary.runs[0]).toMatchObject({ reservedTokens: 0, measuredTokens: 150, remainingTokens: 850, pendingRequests: 0, unknownRequests: 0 });
    expect(summary.byAgent).toMatchObject([{ agentInstanceId: coordinatorId, measuredTokens: 150, reservedTokens: 0, requestCount: 1 }]);
    expect(await db.one<{ total_tokens: number }>('SELECT total_tokens FROM model_usage WHERE request_id = ?', ['provider-call-1'])).toMatchObject({ total_tokens: 150 });
  });

  it('atomically prevents concurrent requests from reserving beyond the run limit', async () => {
    const ledger = new UsageLedger(db, 1000);
    const results = await Promise.allSettled([
      ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 600, outputTokens: 100 }),
      ledger.reserve({ runId, taskId: null, agentInstanceId: 'developer', promptTokens: 600, outputTokens: 100 }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(RunTokenBudgetExceeded) });
    const summary = await ledger.projectSummary(projectId);
    expect(summary.runs[0]!.reservedTokens).toBe(700);
    expect(summary.runs[0]!.remainingTokens).toBe(300);
  });

  it('measures costs from the exact versioned model price and keeps unknown attempts conservatively reserved', async () => {
    const ledger = new UsageLedger(db, 1000);
    const pricing = { modelName: 'model-x', version: 'owner-price-v1', inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 4 };
    await db.run('UPDATE runs SET money_budget_microusd = 1000000 WHERE id = ?', [runId]);
    const measuredId = await ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 100, outputTokens: 50, pricing });
    const unknownId = await ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 25, outputTokens: 10, pricing });

    expect(await db.one<{ pricing_model: string; pricing_version: string; reserved_cost_microusd: number }>(
      'SELECT pricing_model, pricing_version, reserved_cost_microusd FROM model_call_reservations WHERE id = ?', [measuredId],
    )).toEqual({ pricing_model: 'model-x', pricing_version: 'owner-price-v1', reserved_cost_microusd: 400 });
    await ledger.settle(measuredId, 'priced-provider-call', { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    await ledger.settle(unknownId, 'unknown-priced-call', null);

    const summary = await ledger.projectSummary(projectId);
    expect(summary).toMatchObject({ measuredCostMicrousd: 80, reservedCostMicrousd: 90, unpricedRequests: 0 });
    expect(summary.runs[0]).toMatchObject({ moneyBudgetMicrousd: 1000000, measuredCostMicrousd: 80, reservedCostMicrousd: 90 });
    expect(await db.one<{ actual_cost_microusd: number | null }>('SELECT actual_cost_microusd FROM model_call_reservations WHERE id = ?', [measuredId]))
      .toEqual({ actual_cost_microusd: 80 });
  });

  it('requires a matching price before a money-budgeted call and rejects atomic over-budget reservations', async () => {
    const ledger = new UsageLedger(db, 1000);
    const pricing = { modelName: 'model-x', version: 'v1', inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 4 };
    await db.run('UPDATE runs SET money_budget_microusd = 500 WHERE id = ?', [runId]);

    await expect(ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 1, outputTokens: 1 }))
      .rejects.toBeInstanceOf(ModelPricingRequiredError);
    const concurrent = await Promise.allSettled([
      ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 100, outputTokens: 50, pricing }),
      ledger.reserve({ runId, taskId: null, agentInstanceId: 'developer-01', promptTokens: 100, outputTokens: 50, pricing }),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.find((result) => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: expect.any(RunMoneyBudgetExceeded) });
    expect((await ledger.projectSummary(projectId)).runs[0]).toMatchObject({ moneyBudgetMicrousd: 500, reservedCostMicrousd: 400 });
  });

  it('labels calls without a configured price as unpriced instead of reporting zero cost', async () => {
    const ledger = new UsageLedger(db, 1000);
    const reservationId = await ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 10, outputTokens: 5 });
    await ledger.settle(reservationId, 'unpriced-provider-call', { promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    expect(await ledger.projectSummary(projectId)).toMatchObject({ measuredCostMicrousd: 0, reservedCostMicrousd: 0, unpricedRequests: 1 });
  });

  it('enforces a USD budget with an explicitly owner-confirmed zero price and keeps missing price blocked', async () => {
    const ledger = new UsageLedger(db, 1000);
    await db.run('UPDATE runs SET money_budget_microusd = 1 WHERE id = ?', [runId]);
    const confirmedFreePrice = {
      modelName: 'confirmed-free-model', version: 'owner-free-2026-10',
      inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0,
    };

    const reservationId = await ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 100, outputTokens: 50, pricing: confirmedFreePrice });
    expect(await db.one<{ input_rate_usd_per_million: number; output_rate_usd_per_million: number; pricing_version: string; reserved_cost_microusd: number }>(
      'SELECT input_rate_usd_per_million, output_rate_usd_per_million, pricing_version, reserved_cost_microusd FROM model_call_reservations WHERE id = ?', [reservationId],
    )).toEqual({ input_rate_usd_per_million: 0, output_rate_usd_per_million: 0, pricing_version: 'owner-free-2026-10', reserved_cost_microusd: 0 });
    await ledger.settle(reservationId, 'confirmed-free-provider-call', { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    await expect(ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 1, outputTokens: 1 }))
      .rejects.toBeInstanceOf(ModelPricingRequiredError);

    expect(await ledger.projectSummary(projectId)).toMatchObject({ measuredCostMicrousd: 0, unpricedRequests: 0 });
  });

  it('snapshots the configured money budget on each newly created run', async () => {
    const registry = await loadRegistry(process.cwd());
    registry.policy.limits.moneyBudgetUsd = 3.25;
    const budgetProjects = new ProjectService(db, new EventHub(db), registry);
    await budgetProjects.seedRegistry();
    const project = await budgetProjects.createProject({ name: 'USD budget snapshot', goal: '' });
    const run = await budgetProjects.createUserMessage(project.id, project.conversationId, 'Keep this run under its configured USD limit.');

    expect(await db.one<{ money_budget_microusd: number | null }>('SELECT money_budget_microusd FROM runs WHERE id = ?', [run.runId]))
      .toEqual({ money_budget_microusd: 3250000 });
  });

  it('keeps unknown calls reserved and marks in-flight requests unknown after restart', async () => {
    const ledger = new UsageLedger(db, 1000);
    const noUsageId = await ledger.reserve({ runId, taskId: null, agentInstanceId: coordinatorId, promptTokens: 200, outputTokens: 80 });
    await ledger.settle(noUsageId, 'provider-call-without-usage', null);
    const pendingId = await ledger.reserve({ runId, taskId: null, agentInstanceId: 'developer-01', promptTokens: 150, outputTokens: 70 });

    await ledger.reconcileOnStartup();

    expect(await db.one<{ status: string }>('SELECT status FROM model_call_reservations WHERE id = ?', [pendingId])).toMatchObject({ status: 'unknown' });
    expect(await db.one<{ status: string }>('SELECT status FROM model_call_reservations WHERE id = ?', [noUsageId])).toMatchObject({ status: 'unknown' });
    expect((await ledger.projectSummary(projectId)).runs[0]).toMatchObject({ reservedTokens: 500, unknownRequests: 2, remainingTokens: 500 });
  });

  it('pauses before contacting the provider when the prompt cannot fit the run budget', async () => {
    const registry = await loadRegistry(process.cwd());
    registry.policy.limits.maxTokensPerRun = 1024;
    const events = new EventHub(db);
    const runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir,
      MODEL_PRIMARY_BASE_URL: 'https://example.invalid/v1',
      MODEL_PRIMARY_API_KEY: 'test-key',
      MODEL_PRIMARY_NAME: 'test-model',
    }));
    const runtimeProject = await projects.createProject({ name: 'Budget preflight test', goal: '' });
    const run = await projects.createUserMessage(runtimeProject.id, runtimeProject.conversationId, 'This request must be rejected by the budget preflight.');
    await db.run('UPDATE runs SET token_budget = 1024 WHERE id = ?', [run.runId]);

    try {
      runtime.enqueue(run.runId);
      await vi.waitFor(async () => expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [run.runId])).toMatchObject({ status: 'paused', error_code: 'BUDGET_EXHAUSTED' }));
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM model_call_reservations WHERE run_id = ?', [run.runId])).toMatchObject({ count: 0 });
    } finally {
      await runtime.stop();
    }
  });

  it('migrates an existing schema v2 database to the reservation ledger', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'agent-office-v2-'));
    const legacy = new Database(join(legacyDir, 'agent-office.sqlite'));
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY); CREATE TABLE tasks (id TEXT PRIMARY KEY); CREATE TABLE agent_instances (id TEXT PRIMARY KEY);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE assignments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_instance_id TEXT NOT NULL, status TEXT NOT NULL, reserved_at TEXT NOT NULL, released_at TEXT);
      INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (1, 'v1', '2026-01-01T00:00:00.000Z'), (2, 'v2', '2026-01-01T00:00:00.000Z');`);
    legacy.close();

    const migrated = await DatabaseClient.open(legacyDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toMatchObject({ version: 15 });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_call_reservations'")).toMatchObject({ name: 'model_call_reservations' });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_record_revisions'")).toMatchObject({ name: 'memory_record_revisions' });
    } finally {
      await migrated.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('migrates schema v11 with priced usage columns and preserves its existing reservations', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'agent-office-v11-'));
    const legacy = new Database(join(legacyDir, 'agent-office.sqlite'));
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, token_budget INTEGER NOT NULL);
      CREATE TABLE model_call_reservations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, agent_instance_id TEXT, request_id TEXT,
        prompt_reservation INTEGER NOT NULL, output_reservation INTEGER NOT NULL, prompt_tokens INTEGER,
        completion_tokens INTEGER, total_tokens INTEGER, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
      );
      INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (11, 'v11', '2026-01-01T00:00:00.000Z');
      INSERT INTO runs(id, token_budget) VALUES ('run-v11', 1000);
      INSERT INTO model_call_reservations(id, run_id, prompt_reservation, output_reservation, status, created_at)
        VALUES ('reservation-v11', 'run-v11', 10, 20, 'unknown', '2026-01-01T00:00:00.000Z');`);
    legacy.close();

    const migrated = await DatabaseClient.open(legacyDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await migrated.one<{ version: string | null; reserved: number; actual: number | null }>(
        "SELECT pricing_version AS version, reserved_cost_microusd AS reserved, actual_cost_microusd AS actual FROM model_call_reservations WHERE id = 'reservation-v11'",
      )).toEqual({ version: null, reserved: 0, actual: null });
      expect(await migrated.one<{ budget: number | null }>("SELECT money_budget_microusd AS budget FROM runs WHERE id = 'run-v11'")).toEqual({ budget: null });
    } finally {
      await migrated.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('migrates schema v12 with a persistent default-off agent drain flag', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'agent-office-v12-'));
    const legacy = new Database(join(legacyDir, 'agent-office.sqlite'));
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE agent_instances (id TEXT PRIMARY KEY, role TEXT NOT NULL, enabled INTEGER NOT NULL);
      INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (12, 'v12', '2026-01-01T00:00:00.000Z');
      INSERT INTO agent_instances(id, role, enabled) VALUES ('developer-01', 'specialist', 1);`);
    legacy.close();

    const migrated = await DatabaseClient.open(legacyDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await migrated.one<{ draining: number }>("SELECT draining FROM agent_instances WHERE id = 'developer-01'")).toEqual({ draining: 0 });
      await migrated.run("UPDATE agent_instances SET draining = 1 WHERE id = 'developer-01'");
      expect(await migrated.one<{ draining: number }>("SELECT draining FROM agent_instances WHERE id = 'developer-01'")).toEqual({ draining: 1 });
    } finally {
      await migrated.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('migrates schema v13 to a content-minimizing durable hook outbox', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'agent-office-v13-'));
    const legacy = new Database(join(legacyDir, 'agent-office.sqlite'));
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (13, 'v13', '2026-01-01T00:00:00.000Z');`);
    legacy.close();

    const migrated = await DatabaseClient.open(legacyDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hook_outbox'")).toEqual({ name: 'hook_outbox' });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'hook_outbox_pending'")).toEqual({ name: 'hook_outbox_pending' });
      await migrated.run(`INSERT INTO hook_outbox(
        hook_id, event_id, event, handler, execution_id, run_id, project_id, agent_instance_id,
        payload_json, payload_hash, timeout_ms, on_error, status, created_at, updated_at
      ) VALUES ('hook-1', 'event-1', 'after_run', 'memory.propose_summary', 'run-1', 'run-1', 'project-1', 'coordinator-1',
        '{"outcome":"succeeded"}', 'hash', 5000, 'warn', 'pending', 'now', 'now')`);
      expect(await migrated.one<{ status: string; attempts: number }>("SELECT status, attempts FROM hook_outbox WHERE hook_id = 'hook-1'")).toEqual({ status: 'pending', attempts: 0 });
    } finally {
      await migrated.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('migrates schema v7 assignments to leases without changing their history', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'agent-office-v7-'));
    const legacy = new Database(join(legacyDir, 'agent-office.sqlite'));
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE agent_instances (id TEXT PRIMARY KEY);
      CREATE TABLE runs (id TEXT PRIMARY KEY);
      CREATE TABLE assignments (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_instance_id TEXT NOT NULL, project_id TEXT NOT NULL,
        status TEXT NOT NULL, reserved_at TEXT NOT NULL, released_at TEXT
      );
      INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (7, 'v7', '2026-01-01T00:00:00.000Z');
      INSERT INTO agent_instances VALUES ('agent-a');
      INSERT INTO assignments VALUES ('legacy-assignment', 'task-a', 'agent-a', 'project-a', 'active', '2026-01-01T00:00:00.000Z', NULL);`);
    legacy.close();

    const migrated = await DatabaseClient.open(legacyDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toMatchObject({ version: 15 });
      expect(await migrated.one<{ status: string; lease_owner: string | null; lease_expires_at: string | null; fence_token: number; worker_acknowledged_at: string | null }>(
        "SELECT status, lease_owner, lease_expires_at, fence_token, worker_acknowledged_at FROM assignments WHERE id = 'legacy-assignment'",
      )).toEqual({ status: 'active', lease_owner: null, lease_expires_at: null, fence_token: 0, worker_acknowledged_at: null });
      expect(await migrated.one<{ fence_token: number }>("SELECT fence_token FROM agent_instances WHERE id = 'agent-a'")).toEqual({ fence_token: 0 });
    } finally {
      await migrated.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('migrates schema v8 databases to sequenced steering commands', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'agent-office-v8-'));
    const legacy = new Database(join(legacyDir, 'agent-office.sqlite'));
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (8, 'v8', '2026-01-01T00:00:00.000Z');`);
    legacy.close();

    const migrated = await DatabaseClient.open(legacyDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_steering'")).toEqual({ name: 'run_steering' });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'run_steering_pending'")).toEqual({ name: 'run_steering_pending' });
      expect(await migrated.one<{ name: string }>("SELECT name FROM pragma_table_info('runs') WHERE name = 'version'")).toEqual({ name: 'version' });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments'")).toEqual({ name: 'message_attachments' });
    } finally {
      await migrated.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('migrates schema v9 runs to optimistic concurrency versions', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'agent-office-v9-'));
    const legacy = new Database(join(legacyDir, 'agent-office.sqlite'));
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY);
      INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (9, 'v9', '2026-01-01T00:00:00.000Z');
      INSERT INTO runs VALUES ('run-v9');`);
    legacy.close();

    const migrated = await DatabaseClient.open(legacyDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await migrated.one<{ version: number }>("SELECT version FROM runs WHERE id = 'run-v9'")).toEqual({ version: 1 });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments'")).toEqual({ name: 'message_attachments' });
    } finally {
      await migrated.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('migrates schema v10 databases to bounded message attachments', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'agent-office-v10-'));
    const legacy = new Database(join(legacyDir, 'agent-office.sqlite'));
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (10, 'v10', '2026-01-01T00:00:00.000Z');`);
    legacy.close();

    const migrated = await DatabaseClient.open(legacyDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'message_attachments_message'")).toEqual({ name: 'message_attachments_message' });
    } finally {
      await migrated.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy memory to a truthful baseline and scrubs deleted content', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'agent-office-memory-v5-'));
    const legacy = new Database(join(legacyDir, 'agent-office.sqlite'));
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
        content TEXT NOT NULL, source_type TEXT NOT NULL, source_ref TEXT, source_version TEXT, source_checksum TEXT,
        created_by TEXT NOT NULL, confidence_label TEXT NOT NULL, expires_at TEXT, status TEXT NOT NULL, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_record_revisions (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, content TEXT NOT NULL,
        source_type TEXT NOT NULL, source_ref TEXT, source_version TEXT, source_checksum TEXT, created_by TEXT NOT NULL,
        confidence_label TEXT NOT NULL, expires_at TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(memory_id, revision)
      );
      CREATE TABLE runs (id TEXT PRIMARY KEY);
      CREATE TABLE assignments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_instance_id TEXT NOT NULL, status TEXT NOT NULL, reserved_at TEXT NOT NULL, released_at TEXT);
      INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (5, 'v5', '2026-01-01T00:00:00.000Z');
      INSERT INTO memory_records VALUES
        ('legacy-live', 'local-workspace', 'project-a', 'project', 'project-a', 'Keep the API stable.', 'owner_note', NULL, NULL, NULL, 'local-user', 'owner_confirmed', NULL, 'accepted', 4, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('legacy-deleted', 'local-workspace', 'project-a', 'project', 'project-a', 'old private note', 'owner_note', NULL, NULL, NULL, 'local-user', 'owner_confirmed', NULL, 'deleted', 3, '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z');`);
    legacy.close();

    const migrated = await DatabaseClient.open(legacyDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toMatchObject({ version: 15 });
      expect(await migrated.one<{ revision: number; content: string }>("SELECT revision, content FROM memory_records WHERE id = 'legacy-live'")).toEqual({ revision: 1, content: 'Keep the API stable.' });
      expect(await migrated.one<{ revision: number; content: string; source_type: string }>("SELECT revision, content, source_type FROM memory_records WHERE id = 'legacy-deleted'")).toEqual({ revision: 1, content: '', source_type: 'deleted' });
      expect(await migrated.one<{ reason: string; created_at: string }>("SELECT reason, created_at FROM memory_record_revisions WHERE memory_id = 'legacy-live'")).toEqual({ reason: 'migration_v6_baseline', created_at: '2026-01-02T00:00:00.000Z' });
      expect(await migrated.one<{ content: string }>("SELECT content FROM memory_record_revisions WHERE memory_id = 'legacy-deleted'")).toEqual({ content: '' });
    } finally {
      await migrated.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });
});

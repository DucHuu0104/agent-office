import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { RetentionService } from './retention';

describe('local execution-content retention', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-retention-'));
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, await loadRegistry(process.cwd()));
    await projects.seedRegistry();
  });

  afterEach(async () => {
    await db?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('scrubs old terminal tool content and checkpoints while retaining active evidence and conversation history', async () => {
    const terminalProject = await projects.createProject({ name: 'Terminal retention fixture', goal: '' });
    const terminalRequest = await projects.createUserMessage(terminalProject.id, terminalProject.conversationId, 'Keep this user-visible conversation.');
    await projects.updateRun(terminalRequest.runId, 'succeeded');
    const activeProject = await projects.createProject({ name: 'Active retention fixture', goal: '' });
    const activeRequest = await projects.createUserMessage(activeProject.id, activeProject.conversationId, 'Keep active recovery evidence.');
    await db.run("UPDATE runs SET status = 'executing' WHERE id = ?", [activeRequest.runId]);

    const now = new Date();
    const old = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const terminalTaskId = randomUUID();
    const activeTaskId = randomUUID();
    await db.batch([
      { mode: 'run', sql: 'UPDATE runs SET updated_at = ? WHERE id = ?', params: [old, terminalRequest.runId] },
      { mode: 'run', sql: 'UPDATE runs SET updated_at = ? WHERE id = ?', params: [old, activeRequest.runId] },
      { mode: 'run', sql: `INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
        VALUES (?, ?, 'terminal-task', 'specialist', 'Terminal task', 'Old content', '[]', 'succeeded', ?, ?)` , params: [terminalTaskId, terminalRequest.runId, old, old] },
      { mode: 'run', sql: `INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
        VALUES (?, ?, 'active-task', 'specialist', 'Active task', 'Recovery needed', '[]', 'running', ?, ?)` , params: [activeTaskId, activeRequest.runId, old, old] },
      { mode: 'run', sql: 'INSERT INTO checkpoints(id, execution_id, position, state_json, schema_version, created_at) VALUES (?, ?, 1, ?, 1, ?)', params: [randomUUID(), terminalTaskId, '{"prompt":"old private content"}', old] },
      { mode: 'run', sql: 'INSERT INTO checkpoints(id, execution_id, position, state_json, schema_version, created_at) VALUES (?, ?, 1, ?, 1, ?)', params: [randomUUID(), activeTaskId, '{"prompt":"active recovery context"}', old] },
      { mode: 'run', sql: `INSERT INTO tool_operations(id, run_id, task_id, tool_id, arguments_hash, status, receipt_json, created_at, updated_at)
        VALUES (?, ?, ?, 'workspace.read', ?, 'succeeded', ?, ?, ?)`, params: [randomUUID(), terminalRequest.runId, terminalTaskId, 'a'.repeat(64), '{"content":"old private result"}', old, old] },
      { mode: 'run', sql: `INSERT INTO tool_operations(id, run_id, task_id, tool_id, arguments_hash, status, receipt_json, created_at, updated_at)
        VALUES (?, ?, ?, 'workspace.read', ?, 'dispatched', ?, ?, ?)`, params: [randomUUID(), activeRequest.runId, activeTaskId, 'b'.repeat(64), '{"content":"active receipt"}', old, old] },
      { mode: 'run', sql: 'UPDATE domain_events SET occurred_at = ? WHERE project_id = ?', params: [old, terminalProject.id] },
      { mode: 'run', sql: 'UPDATE domain_events SET occurred_at = ? WHERE project_id = ?', params: [old, activeProject.id] },
      { mode: 'run', sql: `INSERT INTO hook_outbox(
        hook_id, event_id, event, handler, execution_id, run_id, project_id, agent_instance_id, payload_hash,
        timeout_ms, on_error, status, attempts, result_json, created_at, updated_at
      ) VALUES (?, ?, 'after_run', 'lifecycle.audit', ?, ?, ?, ?, ?, 1000, 'warn', 'completed', 1, '{}', ?, ?)`,
      params: [randomUUID(), randomUUID(), terminalRequest.runId, terminalRequest.runId, terminalProject.id, terminalProject.coordinatorInstanceId, 'c'.repeat(64), old, old] },
    ], true);
    const activeEventCountBefore = await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM domain_events WHERE project_id = ?', [activeProject.id]);

    const pruned = await new RetentionService(db).prune(now);

    expect(pruned.receiptsScrubbed).toBe(1);
    expect(pruned.checkpointsDeleted).toBe(1);
    expect(pruned.eventsDeleted).toBeGreaterThan(0);
    expect(pruned.hookDeliveriesDeleted).toBe(1);
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM checkpoints WHERE execution_id = ?', [terminalTaskId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM checkpoints WHERE execution_id = ?', [activeTaskId])).toEqual({ count: 1 });
    expect(await db.one<{ receipt_json: string | null }>("SELECT receipt_json FROM tool_operations WHERE run_id = ? AND status = 'succeeded'", [terminalRequest.runId])).toEqual({ receipt_json: null });
    expect(await db.one<{ receipt_json: string | null }>("SELECT receipt_json FROM tool_operations WHERE run_id = ? AND status = 'dispatched'", [activeRequest.runId])).toEqual({ receipt_json: '{"content":"active receipt"}' });
    expect((await projects.listMessages(terminalProject.conversationId)).map((message) => message.content)).toContain('Keep this user-visible conversation.');
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM domain_events WHERE project_id = ?', [activeProject.id])).toEqual(activeEventCountBefore);
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM hook_outbox')).toEqual({ count: 0 });
  });

  it('scrubs resolved approval payloads after 14 days only when their run is terminal', async () => {
    const now = new Date('2026-10-26T12:00:00.000Z');
    const old = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const terminalProject = await projects.createProject({ name: 'Resolved approval retention', goal: '' });
    const terminalRequest = await projects.createUserMessage(terminalProject.id, terminalProject.conversationId, 'Finish the approved change.');
    await projects.updateRun(terminalRequest.runId, 'succeeded');
    const activeProject = await projects.createProject({ name: 'Active approval retention', goal: '' });
    const activeRequest = await projects.createUserMessage(activeProject.id, activeProject.conversationId, 'Continue the approved change.');
    await db.run("UPDATE runs SET status = 'executing', updated_at = ? WHERE id = ?", [old, activeRequest.runId]);
    const pendingProject = await projects.createProject({ name: 'Pending approval retention', goal: '' });
    const pendingRequest = await projects.createUserMessage(pendingProject.id, pendingProject.conversationId, 'Wait for approval.');
    await db.run("UPDATE runs SET status = 'waiting_approval', updated_at = ? WHERE id = ?", [old, pendingRequest.runId]);

    const resolvedId = randomUUID();
    const recentId = randomUUID();
    const activeId = randomUUID();
    const pendingId = randomUUID();
    const oldArguments = JSON.stringify({ path: 'src/private.txt', content: 'approval-content-retention-sentinel' });
    const recentArguments = JSON.stringify({ path: 'src/recent.txt', content: 'recent-approval-content-sentinel' });
    await db.batch([
      { mode: 'run', sql: `INSERT INTO approvals(id, project_id, run_id, operation_id, summary, arguments_json, arguments_hash, status, expires_at, decided_at)
        VALUES (?, ?, ?, ?, 'Create approved file', ?, ?, 'approved', ?, ?)`,
      params: [resolvedId, terminalProject.id, terminalRequest.runId, randomUUID(), oldArguments, 'a'.repeat(64), old, old] },
      { mode: 'run', sql: `INSERT INTO approvals(id, project_id, run_id, operation_id, summary, arguments_json, arguments_hash, status, expires_at, decided_at)
        VALUES (?, ?, ?, ?, 'Create recent file', ?, ?, 'denied', ?, ?)`,
      params: [recentId, terminalProject.id, terminalRequest.runId, randomUUID(), recentArguments, 'b'.repeat(64), recent, recent] },
      { mode: 'run', sql: `INSERT INTO approvals(id, project_id, run_id, operation_id, summary, arguments_json, arguments_hash, status, expires_at, decided_at)
        VALUES (?, ?, ?, ?, 'Continue active file', ?, ?, 'approved', ?, ?)`,
      params: [activeId, activeProject.id, activeRequest.runId, randomUUID(), oldArguments, 'c'.repeat(64), old, old] },
      { mode: 'run', sql: `INSERT INTO approvals(id, project_id, run_id, operation_id, summary, arguments_json, arguments_hash, status, expires_at, decided_at)
        VALUES (?, ?, ?, ?, 'Review pending file', ?, ?, 'pending', ?, NULL)`,
      params: [pendingId, pendingProject.id, pendingRequest.runId, randomUUID(), oldArguments, 'd'.repeat(64), old] },
    ], true);

    const pruned = await new RetentionService(db).prune(now);

    expect(pruned.approvalArgumentsScrubbed).toBe(1);
    const approvalsById = Object.fromEntries((await db.all<{ id: string; arguments_json: string; arguments_hash: string }>(
      'SELECT id, arguments_json, arguments_hash FROM approvals',
    )).map(({ id, arguments_json, arguments_hash }) => [id, { arguments_json, arguments_hash }]));
    expect(approvalsById).toEqual({
      [activeId]: { arguments_json: oldArguments, arguments_hash: 'c'.repeat(64) },
      [pendingId]: { arguments_json: oldArguments, arguments_hash: 'd'.repeat(64) },
      [recentId]: { arguments_json: recentArguments, arguments_hash: 'b'.repeat(64) },
      [resolvedId]: { arguments_json: '{}', arguments_hash: 'a'.repeat(64) },
    });
    expect((await new RetentionService(db).prune(now)).approvalArgumentsScrubbed).toBe(0);
  });
});

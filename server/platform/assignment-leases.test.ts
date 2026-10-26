import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { ASSIGNMENT_LEASE_TTL_MS, assertAssignmentLease, renewAssignmentLease, startAssignmentLeaseSession } from './assignment-leases';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';
import type { Task } from '../../shared/platform/contracts';

interface ReservedAgent {
  lease: { assignmentId: string; taskId: string; agentInstanceId: string; ownerId: string; fenceToken: number };
  agentId: string;
  definitionId: string;
  displayName: string;
}

async function startArtifactToolProvider(): Promise<{ baseUrl: string; requestCount: () => number; close: () => Promise<void> }> {
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { raw += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
      const tool = payload.tools?.find((item) => item.function?.name === 'create_artifact')?.function?.name;
      const callId = `artifact-call-${calls}`;
      const artifactArgs = JSON.stringify({ name: 'limit-test.md', content: '# Limit test', mimeType: 'text/markdown' });
      const chunks = [
        { id: `mock-${calls}`, choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool ?? 'unavailable_tool', arguments: artifactArgs } }] }, finish_reason: null }] },
        { id: `mock-${calls}`, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
      ];
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe('assignment leases and fencing', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  let runtime: AgentRuntime;
  let projectId: string;
  let task: Task;
  let requiredAgentId: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-assignment-lease-'));
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    registry = await loadRegistry(process.cwd());
    projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({ OFFICE_DATA_DIR: dataDir }));

    const firstCapable = registry.roster.find((candidate) => {
      const definition = registry.definitions.get(candidate.definition);
      return candidate.enabled && !!definition?.manifest.capabilities.length;
    })!;
    const capability = registry.definitions.get(firstCapable.definition)!.manifest.capabilities[0]!;
    requiredAgentId = registry.roster.find((candidate) => candidate.enabled && registry.definitions.get(candidate.definition)?.manifest.capabilities.includes(capability))!.id;
    const project = await projects.createProject({ name: 'Lease test', goal: '' });
    projectId = project.id;
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Reserve a specialist task.');
    await db.run("UPDATE runs SET status = 'executing' WHERE id = ?", [request.runId]);
    const taskId = randomUUID();
    const now = new Date().toISOString();
    await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
      VALUES (?, ?, 'lease-task', 'specialist', 'Lease task', 'Test assignment fencing', ?, 'ready', ?, ?)`, [taskId, request.runId, JSON.stringify([capability]), now, now]);
    task = (await projects.getTasks(request.runId))[0]!;
  });

  afterEach(async () => {
    await runtime.stop();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('does not reserve a capability when every matching specialist is draining', async () => {
    const capability = task.requiredCapabilities[0]!;
    const matching = registry.roster.filter((entry) => registry.definitions.get(entry.definition)?.manifest.capabilities.includes(capability));
    expect(matching.length).toBeGreaterThan(0);
    for (const entry of matching) await projects.setSpecialistDraining(entry.id, true);
    const internals = runtime as unknown as { reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null> };

    await expect(internals.reserveAgent(task, projectId)).resolves.toBeNull();
    expect(await db.one<{ status: string; assigned_agent_id: string | null }>('SELECT status, assigned_agent_id FROM tasks WHERE id = ?', [task.id]))
      .toEqual({ status: 'ready', assigned_agent_id: null });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM assignments WHERE task_id = ?', [task.id])).toEqual({ count: 0 });

    for (const entry of matching) await projects.setSpecialistDraining(entry.id, false);
    await expect(internals.reserveAgent(task, projectId)).resolves.toMatchObject({ agentId: requiredAgentId });
  });

  it('allows only one project to lease a shared specialist when both reserve concurrently', async () => {
    const project = await projects.createProject({ name: 'Competing project', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Reserve the same specialist.');
    await db.run("UPDATE runs SET status = 'executing' WHERE id = ?", [request.runId]);
    const otherTaskId = randomUUID();
    const now = new Date().toISOString();
    await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
      VALUES (?, ?, 'competing-task', 'specialist', 'Competing task', 'Test cross-project reservation fencing', ?, 'ready', ?, ?)`, [otherTaskId, request.runId, JSON.stringify(task.requiredCapabilities), now, now]);
    const otherTask = (await projects.getTasks(request.runId))[0]!;
    const internals = runtime as unknown as { reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null> };

    const reservations = await Promise.all([
      internals.reserveAgent(task, projectId),
      internals.reserveAgent(otherTask, project.id),
    ]);

    expect(reservations.filter((reservation) => reservation !== null)).toHaveLength(1);
    expect(await db.one<{ count: number }>(`SELECT COUNT(*) AS count FROM assignments
      WHERE agent_instance_id = ? AND status IN ('reserved','active','releasing')`, [requiredAgentId])).toEqual({ count: 1 });
    const taskStates = await db.all<{ id: string; status: string; assigned_agent_id: string | null }>(
      'SELECT id, status, assigned_agent_id FROM tasks WHERE id IN (?, ?) ORDER BY id', [task.id, otherTask.id],
    );
    expect(taskStates.filter((state) => state.status === 'assigned')).toHaveLength(1);
    expect(taskStates.filter((state) => state.status === 'ready' && state.assigned_agent_id === null)).toHaveLength(1);
  });

  it('releases a specialist through repeated worker failures and recovers the agent at the next fence', async () => {
    const nextTaskIds = [randomUUID(), randomUUID()];
    const now = new Date().toISOString();
    for (const [index, nextTaskId] of nextTaskIds.entries()) {
      await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
        VALUES (?, ?, ?, 'specialist', ?, 'Verify the pool remains usable after repeated worker failures', ?, 'ready', ?, ?)`,
      [nextTaskId, task.runId, `after-worker-failure-${index + 1}`, `Continue after worker failure ${index + 1}`, JSON.stringify(task.requiredCapabilities), now, now]);
    }
    const tasks = await projects.getTasks(task.runId);
    const firstTask = tasks.find((candidate) => candidate.id === task.id)!;
    const [secondTask, thirdTask] = nextTaskIds.map((id) => tasks.find((candidate) => candidate.id === id)!);
    const run = await db.one<{ conversation_id: string }>('SELECT conversation_id FROM runs WHERE id = ?', [task.runId]);
    const internals = runtime as unknown as {
      executeTask(task: Task, projectId: string, conversationId: string, signal: AbortSignal): Promise<boolean>;
      runSpecialist(task: Task, projectId: string, agentId: string, definition: NonNullable<ReturnType<typeof registry.definitions.get>>, leaseSession: ReturnType<typeof startAssignmentLeaseSession>): Promise<string>;
    };
    const worker = vi.spyOn(internals, 'runSpecialist')
      .mockRejectedValueOnce(Object.assign(new Error('Injected specialist worker failure.'), { code: 'INJECTED_WORKER_FAILURE' }))
      .mockRejectedValueOnce(Object.assign(new Error('Injected repeated specialist worker failure.'), { code: 'INJECTED_WORKER_FAILURE' }))
      .mockResolvedValueOnce('The agent completed after repeated worker failures.');
    const signal = new AbortController().signal;

    try {
      await expect(internals.executeTask(firstTask, projectId, run!.conversation_id, signal)).resolves.toBe(true);
      expect(await db.one<{ status: string; assigned_agent_id: string | null; output: string }>('SELECT status, assigned_agent_id, output FROM tasks WHERE id = ?', [firstTask.id]))
        .toMatchObject({ status: 'failed', assigned_agent_id: requiredAgentId, output: 'Injected specialist worker failure.' });
      expect(await db.one<{ status: string; fence_token: number }>('SELECT status, fence_token FROM assignments WHERE task_id = ?', [firstTask.id]))
        .toEqual({ status: 'released', fence_token: 1 });
      expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE agent_instance_id = ? AND status IN ('reserved','active','releasing')", [requiredAgentId]))
        .toEqual({ count: 0 });

      await expect(internals.executeTask(secondTask!, projectId, run!.conversation_id, signal)).resolves.toBe(true);
      expect(await db.one<{ status: string; assigned_agent_id: string | null; output: string }>('SELECT status, assigned_agent_id, output FROM tasks WHERE id = ?', [secondTask!.id]))
        .toMatchObject({ status: 'failed', assigned_agent_id: requiredAgentId, output: 'Injected repeated specialist worker failure.' });
      expect(await db.one<{ status: string; fence_token: number }>('SELECT status, fence_token FROM assignments WHERE task_id = ?', [secondTask!.id]))
        .toEqual({ status: 'released', fence_token: 2 });
      expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE agent_instance_id = ? AND status IN ('reserved','active','releasing')", [requiredAgentId]))
        .toEqual({ count: 0 });

      await expect(internals.executeTask(thirdTask!, projectId, run!.conversation_id, signal)).resolves.toBe(true);
      expect(await db.one<{ status: string; assigned_agent_id: string | null; output: string }>('SELECT status, assigned_agent_id, output FROM tasks WHERE id = ?', [thirdTask!.id]))
        .toMatchObject({ status: 'succeeded', assigned_agent_id: requiredAgentId, output: 'The agent completed after repeated worker failures.' });
      expect(await db.all<{ task_id: string; status: string; fence_token: number }>('SELECT task_id, status, fence_token FROM assignments WHERE task_id IN (?, ?, ?) ORDER BY fence_token', [firstTask.id, secondTask!.id, thirdTask!.id]))
        .toEqual([
          { task_id: firstTask.id, status: 'released', fence_token: 1 },
          { task_id: secondTask!.id, status: 'released', fence_token: 2 },
          { task_id: thirdTask!.id, status: 'released', fence_token: 3 },
        ]);
      expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE agent_instance_id = ? AND status IN ('reserved','active','releasing')", [requiredAgentId]))
        .toEqual({ count: 0 });
      expect(worker).toHaveBeenCalledTimes(3);
    } finally {
      worker.mockRestore();
    }
  });

  it('upgrades legacy v1 checkpoints in memory and writes the next checkpoint as v2', async () => {
    const now = new Date().toISOString();
    await db.run(`INSERT INTO checkpoints(id, execution_id, position, state_json, schema_version, created_at)
      VALUES (?, ?, 1, ?, 1, ?)`, [randomUUID(), task.id, JSON.stringify({
      schemaVersion: 1, definitionId: 'writer', messages: [], nextTurn: 2, totalToolCalls: 3,
    }), now]);
    const internals = runtime as unknown as {
      latestCheckpoint(executionId: string): Promise<{ schemaVersion: 2; definitionId: string; messages: never[]; nextTurn: number; totalToolCalls: number; consumedSteeringIds: string[]; pendingToolCalls: never[] } | null>;
      saveCheckpoint(executionId: string, state: { schemaVersion: 2; definitionId: string; messages: never[]; nextTurn: number; totalToolCalls: number; consumedSteeringIds: string[]; pendingToolCalls: never[] }): Promise<void>;
    };

    const upgraded = await internals.latestCheckpoint(task.id);
    expect(upgraded).toMatchObject({
      schemaVersion: 2, definitionId: 'writer', nextTurn: 2, totalToolCalls: 3,
      consumedSteeringIds: [], pendingToolCalls: [],
    });
    await internals.saveCheckpoint(task.id, upgraded!);
    const persisted = await db.one<{ schema_version: number }>('SELECT schema_version FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [task.id]);
    expect(persisted?.schema_version).toBe(2);
  });

  it('increments a per-agent fence token and rejects completion from a released assignment', async () => {
    const internals = runtime as unknown as {
      reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null>;
      finishTask(task: Task, projectId: string, agentId: string | null, output: string, success: boolean, lease?: ReservedAgent['lease']): Promise<void>;
      saveCheckpoint(executionId: string, state: { schemaVersion: 2; definitionId: string; messages: never[]; nextTurn: number; totalToolCalls: number }, lease?: ReservedAgent['lease']): Promise<void>;
      recordToolDispatch(input: { operationId: string; task: Task; projectId: string; toolId: string; argumentsHash: string; lease: ReservedAgent['lease'] }): Promise<void>;
      recordToolCompletionAndCheckpoint(input: { operationId: string; task: Task; projectId: string; lease: ReservedAgent['lease']; status: 'succeeded' | 'failed'; receipt: string; checkpoint: { schemaVersion: 2; definitionId: string; messages: never[]; nextTurn: number; totalToolCalls: number; pendingToolCalls: never[] } }): Promise<void>;
    };

    const first = await internals.reserveAgent(task, projectId);
    expect(first).not.toBeNull();
    expect(first!.agentId).toBe(requiredAgentId);
    expect(first!.lease.fenceToken).toBe(1);
    expect(await db.one<{ fence_token: number; lease_owner: string; status: string }>('SELECT fence_token, lease_owner, status FROM assignments WHERE id = ?', [first!.lease.assignmentId]))
      .toMatchObject({ fence_token: 1, lease_owner: first!.lease.ownerId, status: 'reserved' });

    const now = new Date().toISOString();
    await db.batch([
      { mode: 'run', sql: "UPDATE assignments SET status = 'released', released_at = ?, lease_expires_at = ? WHERE id = ?", params: [now, now, first!.lease.assignmentId] },
      { mode: 'run', sql: "UPDATE tasks SET status = 'ready', assigned_agent_id = NULL WHERE id = ?", params: [task.id] },
    ], true);
    const second = await internals.reserveAgent(task, projectId);
    expect(second).not.toBeNull();
    expect(second!.agentId).toBe(requiredAgentId);
    expect(second!.lease.fenceToken).toBe(2);

    const staleOperationId = randomUUID();
    await expect(internals.recordToolDispatch({ operationId: staleOperationId, task, projectId, toolId: 'research.fetch', argumentsHash: 'b'.repeat(64), lease: first!.lease }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE id = ?', [staleOperationId])).toEqual({ count: 0 });

    await expect(internals.saveCheckpoint(task.id, { schemaVersion: 2, definitionId: 'writer', messages: [], nextTurn: 1, totalToolCalls: 0 }, first!.lease))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_LEASE_LOST' });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM checkpoints WHERE execution_id = ?', [task.id])).toEqual({ count: 0 });

    const activatedAt = new Date().toISOString();
    await db.batch([
      { mode: 'run', sql: "UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ?", params: [activatedAt, second!.lease.assignmentId] },
      { mode: 'run', sql: "UPDATE tasks SET status = 'running' WHERE id = ?", params: [task.id] },
    ], true);
    const operationId = randomUUID();
    await internals.recordToolDispatch({ operationId, task, projectId, toolId: 'research.fetch', argumentsHash: 'a'.repeat(64), lease: second!.lease });
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [operationId])).toEqual({ status: 'dispatched' });

    const reassignedAt = new Date().toISOString();
    await db.batch([
      { mode: 'run', sql: "UPDATE assignments SET status = 'released', released_at = ?, lease_expires_at = ? WHERE id = ?", params: [reassignedAt, reassignedAt, second!.lease.assignmentId] },
      { mode: 'run', sql: "UPDATE tasks SET status = 'ready', assigned_agent_id = NULL WHERE id = ?", params: [task.id] },
    ], true);
    const third = await internals.reserveAgent(task, projectId);
    expect(third?.lease.fenceToken).toBe(3);
    const sequenceBefore = await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events');
    await expect(internals.recordToolCompletionAndCheckpoint({ operationId, task, projectId, lease: second!.lease, status: 'succeeded', receipt: 'stale tool result', checkpoint: { schemaVersion: 2, definitionId: 'writer', messages: [], nextTurn: 1, totalToolCalls: 1, pendingToolCalls: [] } }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(internals.finishTask(task, projectId, first!.agentId, 'stale worker output', true, first!.lease))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await db.one<{ status: string; output: string | null; assigned_agent_id: string }>('SELECT status, output, assigned_agent_id FROM tasks WHERE id = ?', [task.id]))
      .toMatchObject({ status: 'assigned', output: null, assigned_agent_id: third!.agentId });
    expect(await db.one<{ status: string }>('SELECT status FROM assignments WHERE id = ?', [third!.lease.assignmentId])).toMatchObject({ status: 'reserved' });
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [operationId])).toEqual({ status: 'dispatched' });
    expect(await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events')).toEqual(sequenceBefore);

    await internals.finishTask(task, projectId, third!.agentId, 'current worker failed safely', false, third!.lease);
    expect(await db.one<{ status: string; output: string }>('SELECT status, output FROM tasks WHERE id = ?', [task.id]))
      .toEqual({ status: 'failed', output: 'current worker failed safely' });
    const released = await db.one<{ status: string; lease_expires_at: string }>('SELECT status, lease_expires_at FROM assignments WHERE id = ?', [third!.lease.assignmentId]);
    expect(released?.status).toBe('released');
    expect(Date.parse(released!.lease_expires_at)).toBeLessThanOrEqual(Date.now());
  });

  it('rolls back task completion, lease release and event together when finalization fails', async () => {
    const internals = runtime as unknown as {
      reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null>;
      finishTask(task: Task, projectId: string, agentId: string | null, output: string, success: boolean, lease?: ReservedAgent['lease']): Promise<void>;
    };
    const reserved = await internals.reserveAgent(task, projectId);
    expect(reserved).not.toBeNull();
    const acknowledgedAt = new Date().toISOString();
    await db.batch([
      { mode: 'run', sql: "UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ?", params: [acknowledgedAt, reserved!.lease.assignmentId] },
      { mode: 'run', sql: "UPDATE tasks SET status = 'running' WHERE id = ?", params: [task.id] },
    ], true);

    const eventSequence = await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events');
    const workspaceRevision = await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'");
    const transact = events.transactConditional.bind(events);
    vi.spyOn(events, 'transactConditional').mockImplementationOnce((type, aggregateId, eventProjectId, payload, operations) =>
      transact(type, aggregateId, eventProjectId, payload, [
        ...operations,
        { mode: 'run', sql: 'INSERT INTO injected_task_finalization_failure VALUES (1)' },
      ]));

    await expect(internals.finishTask(task, projectId, reserved!.agentId, 'completed output', true, reserved!.lease)).rejects.toThrow();
    expect(await db.one<{ status: string; output: string | null }>('SELECT status, output FROM tasks WHERE id = ?', [task.id]))
      .toEqual({ status: 'running', output: null });
    expect(await db.one<{ status: string; lease_expires_at: string }>('SELECT status, lease_expires_at FROM assignments WHERE id = ?', [reserved!.lease.assignmentId]))
      .toMatchObject({ status: 'active' });
    expect(await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events')).toEqual(eventSequence);
    expect(await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'")).toEqual(workspaceRevision);

    await internals.finishTask(task, projectId, reserved!.agentId, 'completed output', true, reserved!.lease);
    expect(await db.one<{ status: string; output: string }>('SELECT status, output FROM tasks WHERE id = ?', [task.id]))
      .toEqual({ status: 'succeeded', output: 'completed output' });
    expect(await db.one<{ status: string }>('SELECT status FROM assignments WHERE id = ?', [reserved!.lease.assignmentId]))
      .toEqual({ status: 'released' });
    expect((await events.listSince(eventSequence!.sequence)).map((event) => event.type)).toEqual(['task.status_changed']);
  });

  it('commits a tool receipt and its checkpoint atomically', async () => {
    const internals = runtime as unknown as {
      reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null>;
      recordToolDispatch(input: { operationId: string; task: Task; projectId: string; toolId: string; argumentsHash: string; lease: ReservedAgent['lease'] }): Promise<void>;
      recordToolCompletionAndCheckpoint(input: { operationId: string; task: Task; projectId: string; lease: ReservedAgent['lease']; status: 'succeeded' | 'failed'; receipt: string; checkpoint: { schemaVersion: 2; definitionId: string; messages: Array<{ role: 'tool'; tool_call_id: string; content: string }>; nextTurn: number; totalToolCalls: number; pendingToolCalls: never[] } }): Promise<void>;
      checkpointOperation(executionId: string, state: unknown): { mode: 'run'; sql: string };
    };
    const reserved = await internals.reserveAgent(task, projectId);
    expect(reserved).not.toBeNull();
    const acknowledgedAt = new Date().toISOString();
    await db.batch([
      { mode: 'run', sql: "UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ?", params: [acknowledgedAt, reserved!.lease.assignmentId] },
      { mode: 'run', sql: "UPDATE tasks SET status = 'running' WHERE id = ?", params: [task.id] },
    ], true);
    const operationId = randomUUID();
    await internals.recordToolDispatch({ operationId, task, projectId, toolId: 'artifacts.create', argumentsHash: 'c'.repeat(64), lease: reserved!.lease });
    const checkpoint = {
      schemaVersion: 2 as const, definitionId: 'writer',
      messages: [{ role: 'tool' as const, tool_call_id: 'artifact-call', content: '{"created":true}' }],
      nextTurn: 1, totalToolCalls: 1, pendingToolCalls: [] as never[],
    };
    const sequenceBefore = await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events');
    const originalCheckpointOperation = internals.checkpointOperation.bind(runtime);
    internals.checkpointOperation = () => ({ mode: 'run', sql: 'INSERT INTO injected_checkpoint_failure VALUES (1)' });

    await expect(internals.recordToolCompletionAndCheckpoint({
      operationId, task, projectId, lease: reserved!.lease, status: 'succeeded', receipt: '{"created":true}', checkpoint,
    })).rejects.toThrow();
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [operationId])).toEqual({ status: 'dispatched' });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM checkpoints WHERE execution_id = ?', [task.id])).toEqual({ count: 0 });
    expect(await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events')).toEqual(sequenceBefore);

    internals.checkpointOperation = originalCheckpointOperation;
    await internals.recordToolCompletionAndCheckpoint({
      operationId, task, projectId, lease: reserved!.lease, status: 'succeeded', receipt: '{"created":true}', checkpoint,
    });
    expect(await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [operationId]))
      .toEqual({ status: 'succeeded', receipt_json: '{"created":true}' });
    const saved = await db.one<{ schema_version: number; state_json: string }>('SELECT schema_version, state_json FROM checkpoints WHERE execution_id = ?', [task.id]);
    expect(saved?.schema_version).toBe(2);
    expect(JSON.parse(saved!.state_json).messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'artifact-call' });
    expect((await events.listSince(sequenceBefore!.sequence)).map((event) => event.type)).toEqual(['tool.completed']);
  });

  it('rolls back the complete approval request when its checkpoint cannot be committed', async () => {
    const internals = runtime as unknown as {
      reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null>;
      requestWorkspaceApproval(input: {
        task: Task; projectId: string; agentId: string; operationId: string; toolCallId: string; toolId: string;
        argumentsRaw: string; argumentsHash: string; arguments: Record<string, unknown>; summary: string;
        checkpoint: { schemaVersion: 2; definitionId: string; messages: never[]; nextTurn: number; totalToolCalls: number };
        leaseSession: { lease: ReservedAgent['lease']; assertActive(): Promise<void> };
      }): Promise<void>;
      checkpointOperation(executionId: string, state: unknown): { mode: 'run'; sql: string };
    };
    const reserved = await internals.reserveAgent(task, projectId);
    expect(reserved).not.toBeNull();
    const now = new Date().toISOString();
    await db.batch([
      { mode: 'run', sql: "UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ?", params: [now, reserved!.lease.assignmentId] },
      { mode: 'run', sql: "UPDATE tasks SET status = 'running' WHERE id = ?", params: [task.id] },
    ], true);
    const operationId = randomUUID();
    const approvalArguments = { path: 'report.txt', content: 'approved content' };
    const argumentsRaw = JSON.stringify(approvalArguments);
    const checkpoint = { schemaVersion: 2 as const, definitionId: 'writer', messages: [] as never[], nextTurn: 1, totalToolCalls: 1 };
    const sequenceBefore = await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events');
    const originalCheckpointOperation = internals.checkpointOperation.bind(runtime);
    internals.checkpointOperation = () => ({ mode: 'run', sql: 'INSERT INTO injected_approval_checkpoint_failure VALUES (1)' });

    await expect(internals.requestWorkspaceApproval({
      task, projectId, agentId: reserved!.agentId, operationId, toolCallId: 'approval-call', toolId: 'workspace.write',
      argumentsRaw, argumentsHash: 'e'.repeat(64), arguments: approvalArguments, summary: 'Create report.txt', checkpoint,
      leaseSession: { lease: reserved!.lease, assertActive: async () => undefined },
    })).rejects.toThrow();
    expect(await db.one<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [task.id])).toEqual({ status: 'running' });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE id = ?', [operationId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM approvals WHERE operation_id = ?', [operationId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM checkpoints WHERE execution_id = ?', [task.id])).toEqual({ count: 0 });
    expect(await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events')).toEqual(sequenceBefore);

    internals.checkpointOperation = originalCheckpointOperation;
  });

  it('rejects a stale worker trying to create a workspace approval after reassignment', async () => {
    const internals = runtime as unknown as {
      reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null>;
      requestWorkspaceApproval(input: {
        task: Task; projectId: string; agentId: string; operationId: string; toolCallId: string; toolId: string;
        argumentsRaw: string; argumentsHash: string; arguments: Record<string, unknown>; summary: string;
        checkpoint: { schemaVersion: 2; definitionId: string; messages: never[]; nextTurn: number; totalToolCalls: number };
        leaseSession: { lease: ReservedAgent['lease']; assertActive(): Promise<void> };
      }): Promise<void>;
    };
    const stale = await internals.reserveAgent(task, projectId);
    expect(stale).not.toBeNull();
    const releasedAt = new Date().toISOString();
    await db.batch([
      { mode: 'run', sql: "UPDATE assignments SET status = 'released', released_at = ?, lease_expires_at = ? WHERE id = ?", params: [releasedAt, releasedAt, stale!.lease.assignmentId] },
      { mode: 'run', sql: "UPDATE tasks SET status = 'ready', assigned_agent_id = NULL WHERE id = ?", params: [task.id] },
    ], true);
    const current = await internals.reserveAgent(task, projectId);
    expect(current?.lease.fenceToken).toBe(stale!.lease.fenceToken + 1);
    const activeAt = new Date().toISOString();
    await db.batch([
      { mode: 'run', sql: "UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ?", params: [activeAt, current!.lease.assignmentId] },
      { mode: 'run', sql: "UPDATE tasks SET status = 'running' WHERE id = ?", params: [task.id] },
    ], true);

    const operationId = randomUUID();
    const sequenceBefore = await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events');
    await expect(internals.requestWorkspaceApproval({
      task, projectId, agentId: stale!.agentId, operationId, toolCallId: 'stale-approval-call', toolId: 'workspace.write',
      argumentsRaw: JSON.stringify({ path: 'stale.txt', content: 'must not be approved' }),
      argumentsHash: 'f'.repeat(64), arguments: { path: 'stale.txt', content: 'must not be approved' },
      summary: 'Create stale.txt',
      checkpoint: { schemaVersion: 2, definitionId: 'writer', messages: [], nextTurn: 1, totalToolCalls: 1 },
      leaseSession: { lease: stale!.lease, assertActive: async () => undefined },
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

    expect(await db.one<{ status: string; assigned_agent_id: string | null }>('SELECT status, assigned_agent_id FROM tasks WHERE id = ?', [task.id]))
      .toEqual({ status: 'running', assigned_agent_id: current!.agentId });
    expect(await db.one<{ status: string; fence_token: number }>('SELECT status, fence_token FROM assignments WHERE id = ?', [current!.lease.assignmentId]))
      .toEqual({ status: 'active', fence_token: current!.lease.fenceToken });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE id = ?', [operationId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM approvals WHERE operation_id = ?', [operationId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM checkpoints WHERE execution_id = ?', [task.id])).toEqual({ count: 0 });
    expect(await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events')).toEqual(sequenceBefore);
  });

  it('does not execute a specialist tool when its lease is replaced immediately before dispatch', async () => {
    const provider = await startArtifactToolProvider();
    const previous = { url: process.env.MODEL_PRIMARY_BASE_URL, key: process.env.MODEL_PRIMARY_API_KEY, name: process.env.MODEL_PRIMARY_NAME };
    const testRuntime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir,
      MODEL_PRIMARY_BASE_URL: provider.baseUrl,
      MODEL_PRIMARY_API_KEY: 'test-only-key',
      MODEL_PRIMARY_NAME: 'test-only-model',
    }));
    let leaseSession: ReturnType<typeof startAssignmentLeaseSession> | null = null;
    try {
      const internals = testRuntime as unknown as {
        reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null>;
        runSpecialist(task: Task, projectId: string, agentId: string, definition: NonNullable<ReturnType<typeof registry.definitions.get>>, leaseSession: ReturnType<typeof startAssignmentLeaseSession>): Promise<string>;
        recordToolDispatch(input: { operationId: string; task: Task; projectId: string; toolId: string; argumentsHash: string; lease: ReservedAgent['lease'] }): Promise<void>;
      };
      const stale = await internals.reserveAgent(task, projectId);
      expect(stale).not.toBeNull();
      const activatedAt = new Date().toISOString();
      await db.batch([
        { mode: 'run', sql: "UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ?", params: [activatedAt, stale!.lease.assignmentId] },
        { mode: 'run', sql: "UPDATE tasks SET status = 'running' WHERE id = ?", params: [task.id] },
      ], true);
      leaseSession = startAssignmentLeaseSession(db, stale!.lease, new AbortController().signal, { heartbeatMs: 1000 });
      const activeTask = (await projects.getTasks(task.runId)).find((candidate) => candidate.id === task.id)!;
      const definition = registry.definitions.get(stale!.definitionId)!;
      let replacement: ReservedAgent | null = null;
      const dispatch = internals.recordToolDispatch.bind(testRuntime);
      internals.recordToolDispatch = async (input) => {
        const releasedAt = new Date().toISOString();
        await db.batch([
          { mode: 'run', sql: "UPDATE assignments SET status = 'released', released_at = ?, lease_expires_at = ? WHERE id = ? AND status = 'active'", params: [releasedAt, releasedAt, stale!.lease.assignmentId] },
          { mode: 'run', sql: "UPDATE tasks SET status = 'ready', assigned_agent_id = NULL WHERE id = ? AND status = 'running'", params: [task.id] },
        ], true);
        replacement = await internals.reserveAgent(activeTask, projectId);
        return dispatch(input);
      };

      await expect(internals.runSpecialist(activeTask, projectId, stale!.agentId, definition, leaseSession))
        .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

      expect(provider.requestCount()).toBe(1);
      expect(replacement).toMatchObject({ agentId: stale!.agentId, lease: { fenceToken: stale!.lease.fenceToken + 1 } });
      expect(await db.one<{ status: string; assigned_agent_id: string | null; output: string | null }>('SELECT status, assigned_agent_id, output FROM tasks WHERE id = ?', [task.id]))
        .toMatchObject({ status: 'assigned', assigned_agent_id: replacement!.agentId, output: null });
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE task_id = ?', [task.id])).toEqual({ count: 0 });
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ?', [projectId])).toEqual({ count: 0 });
      expect(await db.one<{ schema_version: number; state_json: string }>('SELECT schema_version, state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [task.id]))
        .toMatchObject({ schema_version: 2 });
      const checkpoint = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [task.id]);
      expect(JSON.parse(checkpoint!.state_json).pendingToolCalls).toHaveLength(1);
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM model_usage WHERE task_id = ?', [task.id])).toEqual({ count: 1 });
    } finally {
      await leaseSession?.stop();
      await testRuntime.stop();
      await provider.close();
      if (previous.url === undefined) delete process.env.MODEL_PRIMARY_BASE_URL; else process.env.MODEL_PRIMARY_BASE_URL = previous.url;
      if (previous.key === undefined) delete process.env.MODEL_PRIMARY_API_KEY; else process.env.MODEL_PRIMARY_API_KEY = previous.key;
      if (previous.name === undefined) delete process.env.MODEL_PRIMARY_NAME; else process.env.MODEL_PRIMARY_NAME = previous.name;
    }
  });

  it('recovers a completed tool receipt into its checkpoint instead of dispatching it again', async () => {
    const operationId = randomUUID();
    const now = new Date().toISOString();
    const toolCallId = 'saved-artifact-call';
    await db.batch([
      { mode: 'run', sql: `INSERT INTO tool_operations(id, run_id, task_id, tool_id, arguments_hash, status, receipt_json, created_at, updated_at)
        VALUES (?, ?, ?, 'artifacts.create', ?, 'succeeded', ?, ?, ?)`, params: [operationId, task.runId, task.id, 'd'.repeat(64), '{"created":true}', now, now] },
      { mode: 'run', sql: `INSERT INTO checkpoints(id, execution_id, position, state_json, schema_version, created_at)
        VALUES (?, ?, 1, ?, 2, ?)`, params: [randomUUID(), task.id, JSON.stringify({
          schemaVersion: 2, definitionId: 'writer', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'create_artifact', arguments: '{}' } }] }],
          nextTurn: 1, totalToolCalls: 1, pendingToolCalls: [{ operationId, toolCallId, toolName: 'artifacts.create' }],
        }), now] },
    ], true);
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);

    await runtime.recover();

    const saved = await db.one<{ schema_version: number; state_json: string }>('SELECT schema_version, state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [task.id]);
    const state = JSON.parse(saved!.state_json);
    expect(saved?.schema_version).toBe(2);
    expect(state.pendingToolCalls).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: toolCallId });
    expect(JSON.parse(state.messages.at(-1).content).data).toBe('{"created":true}');
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE id = ?', [operationId])).toEqual({ count: 1 });
  });

  it('turns a checkpointed tool call without a dispatch receipt into a safe retry request after restart', async () => {
    const operationId = randomUUID();
    const now = new Date().toISOString();
    const toolCallId = 'not-dispatched-call';
    await db.run(`INSERT INTO checkpoints(id, execution_id, position, state_json, schema_version, created_at)
      VALUES (?, ?, 1, ?, 2, ?)`, [randomUUID(), task.id, JSON.stringify({
      schemaVersion: 2, definitionId: 'writer', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'search_web', arguments: '{"query":"example"}' } }] }],
      nextTurn: 1, totalToolCalls: 1, pendingToolCalls: [{ operationId, toolCallId, toolName: 'research.search' }],
    }), now]);
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);

    await runtime.recover();

    const saved = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [task.id]);
    const state = JSON.parse(saved!.state_json);
    expect(state.pendingToolCalls).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: toolCallId });
    expect(state.messages.at(-1).content).toContain('stopped before this tool was dispatched');
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE id = ?', [operationId])).toEqual({ count: 0 });
  });

  it('renews only a live matching fence and aborts when ownership changes', async () => {
    const internals = runtime as unknown as { reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null> };
    const reserved = await internals.reserveAgent(task, projectId);
    expect(reserved).not.toBeNull();
    const now = new Date().toISOString();
    await db.run("UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ?", [now, reserved!.lease.assignmentId]);
    await db.run("UPDATE tasks SET status = 'running' WHERE id = ?", [task.id]);

    await assertAssignmentLease(db, reserved!.lease);
    const before = await db.one<{ lease_expires_at: string }>('SELECT lease_expires_at FROM assignments WHERE id = ?', [reserved!.lease.assignmentId]);
    expect(await renewAssignmentLease(db, reserved!.lease, { ttlMs: ASSIGNMENT_LEASE_TTL_MS })).toBe(true);
    const after = await db.one<{ lease_expires_at: string }>('SELECT lease_expires_at FROM assignments WHERE id = ?', [reserved!.lease.assignmentId]);
    expect(Date.parse(after!.lease_expires_at)).toBeGreaterThan(Date.parse(before!.lease_expires_at));

    const session = startAssignmentLeaseSession(db, reserved!.lease, new AbortController().signal, { heartbeatMs: 10 });
    await db.run("UPDATE assignments SET lease_owner = 'replacement-worker' WHERE id = ?", [reserved!.lease.assignmentId]);
    await vi.waitFor(() => expect(session.signal.aborted).toBe(true), { timeout: 1000 });
    await expect(session.assertActive()).rejects.toMatchObject({ code: 'ASSIGNMENT_LEASE_LOST' });
    await session.stop();
  });

  it('does not resurrect an expired lease with the right token', async () => {
    const internals = runtime as unknown as { reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null> };
    const reserved = await internals.reserveAgent(task, projectId);
    expect(reserved).not.toBeNull();
    const expired = new Date(Date.now() - 1).toISOString();
    await db.run("UPDATE assignments SET status = 'active', lease_expires_at = ? WHERE id = ?", [expired, reserved!.lease.assignmentId]);
    expect(await renewAssignmentLease(db, reserved!.lease)).toBe(false);
    await expect(assertAssignmentLease(db, reserved!.lease)).rejects.toMatchObject({ code: 'ASSIGNMENT_LEASE_LOST' });
  });

  it('recovers a reserved lease after hard-kill before worker acknowledgement', async () => {
    const gateProvider = createServer();
    let firstRequestStarted!: () => void;
    const firstRequest = new Promise<void>((resolve) => { firstRequestStarted = resolve; });
    let releaseFirstResponse!: () => void;
    const firstResponseGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
    let providerRequests = 0;
    gateProvider.on('request', (request, response) => {
      request.resume();
      request.on('end', () => {
        providerRequests++;
        if (providerRequests === 1) firstRequestStarted();
        const sendResponse = () => {
          const chunks = [
            { id: `reservation-recovered-${providerRequests}`, choices: [{ delta: { content: 'The replacement worker completed the task.' }, finish_reason: null }] },
            { id: `reservation-recovered-${providerRequests}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
          ];
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
        };
        if (providerRequests === 1) void firstResponseGate.then(sendResponse);
        else sendResponse();
      });
    });
    await new Promise<void>((resolve, reject) => {
      gateProvider.once('error', reject);
      gateProvider.listen(0, '127.0.0.1', resolve);
    });
    const gateAddress = gateProvider.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${gateAddress.port}/v1`;
    const childPath = fileURLToPath(new URL('./assignment-reservation-crash-child.ts', import.meta.url));
    let child: ReturnType<typeof spawn> | undefined;
    let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let childKilled = false;
    let childOutput = '';
    let stdoutBuffer = '';
    let reservation: { event: string; agentId: string; lease: ReservedAgent['lease'] } | undefined;
    let resolveReservation!: () => void;
    const reservationReady = new Promise<void>((resolve) => { resolveReservation = resolve; });
    let requestTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await db.run("UPDATE tasks SET status = 'ready', assigned_agent_id = NULL WHERE id = ?", [task.id]);
      await db.close();
      child = spawn(process.execPath, ['--import', 'tsx', childPath, dataDir, task.runId, baseUrl], {
        cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        childOutput += chunk;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const record = JSON.parse(line) as typeof reservation;
            if (record?.event === 'reserved_before_ack') {
              reservation = record;
              resolveReservation();
            }
          } catch { /* Ignore non-JSON child output while retaining it for diagnostics. */ }
        }
      });
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { childOutput += chunk; });
      childExit = new Promise((resolve, reject) => {
        child!.once('error', reject);
        child!.once('exit', (code, signal) => resolve({ code, signal }));
      });

      await Promise.race([
        reservationReady,
        childExit.then(({ code, signal }) => { throw new Error(`Crash child exited before reserving the lease (${code ?? signal}): ${childOutput}`); }),
        delay(20_000).then(() => { throw new Error(`Timed out waiting for pre-ack reservation: ${childOutput}`); }),
      ]);
      expect(reservation).toMatchObject({ event: 'reserved_before_ack', lease: { fenceToken: 1, taskId: task.id } });

      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        expect(await observer.one<{ status: string; assigned_agent_id: string }>('SELECT status, assigned_agent_id FROM tasks WHERE id = ?', [task.id]))
          .toEqual({ status: 'assigned', assigned_agent_id: reservation!.agentId });
        expect(await observer.one<{ status: string; worker_acknowledged_at: string | null; fence_token: number; lease_owner: string }>(
          'SELECT status, worker_acknowledged_at, fence_token, lease_owner FROM assignments WHERE id = ?', [reservation!.lease.assignmentId],
        )).toEqual({ status: 'reserved', worker_acknowledged_at: null, fence_token: 1, lease_owner: reservation!.lease.ownerId });
        expect(await observer.one<{ count: number }>('SELECT COUNT(*) AS count FROM model_call_reservations WHERE run_id = ?', [task.runId]))
          .toEqual({ count: 0 });
      } finally {
        await observer.close();
      }

      expect(child.kill('SIGKILL')).toBe(true);
      childKilled = true;
      const exit = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error('Pre-ack runtime did not exit after SIGKILL.'); }),
      ]);
      expect(exit.signal).toBeTruthy();

      db = await DatabaseClient.open(dataDir, true);
      events = new EventHub(db);
      projects = new ProjectService(db, events, registry);
      runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
        OFFICE_DATA_DIR: dataDir,
        OFFICE_CONFIG_DIR: process.cwd(),
        OFFICE_EXECUTION_MODE: 'disabled',
        MODEL_PRIMARY_BASE_URL: baseUrl,
        MODEL_PRIMARY_API_KEY: 'test-only-key',
        MODEL_PRIMARY_NAME: 'test-only-model',
      }));
      const recoveryInternals = runtime as unknown as {
        recordToolDispatch(input: { operationId: string; task: Task; projectId: string; toolId: string; argumentsHash: string; lease: ReservedAgent['lease'] }): Promise<void>;
      };
      await runtime.recover();

      await Promise.race([
        firstRequest,
        new Promise<never>((_, reject) => {
          requestTimeout = setTimeout(() => reject(new Error('Replacement worker did not reach its model call.')), 10_000);
        }),
      ]);
      const assignments = await db.all<{ status: string; fence_token: number; lease_owner: string; worker_acknowledged_at: string | null; agent_instance_id: string }>(
        'SELECT status, fence_token, lease_owner, worker_acknowledged_at, agent_instance_id FROM assignments WHERE task_id = ? ORDER BY fence_token', [task.id],
      );
      expect(assignments).toHaveLength(2);
      expect(assignments[0]).toMatchObject({ status: 'released', fence_token: 1, worker_acknowledged_at: null, agent_instance_id: reservation!.agentId });
      expect(assignments[1]).toMatchObject({ status: 'active', fence_token: 2, agent_instance_id: reservation!.agentId });

      const staleOperationId = randomUUID();
      await expect(recoveryInternals.recordToolDispatch({
        operationId: staleOperationId, task, projectId, toolId: 'research.fetch', argumentsHash: 'b'.repeat(64), lease: reservation!.lease,
      })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE id = ?', [staleOperationId])).toEqual({ count: 0 });

      releaseFirstResponse();
      await vi.waitFor(async () => {
        expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [task.runId])).toEqual({ status: 'succeeded' });
      }, { timeout: 20_000 });
      expect(providerRequests).toBe(2);
      expect(await db.one<{ status: string; output: string }>('SELECT status, output FROM tasks WHERE id = ?', [task.id]))
        .toEqual({ status: 'succeeded', output: 'The replacement worker completed the task.' });
      expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('reserved','active','releasing')", [task.id]))
        .toEqual({ count: 0 });
      expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM model_call_reservations WHERE run_id = ? AND status = 'settled'", [task.runId]))
        .toEqual({ count: 2 });
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM model_call_reservations WHERE run_id = ? AND status = \'unknown\'', [task.runId]))
        .toEqual({ count: 0 });
    } finally {
      if (requestTimeout) clearTimeout(requestTimeout);
      releaseFirstResponse();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (childExit && !childKilled) await Promise.race([childExit.catch(() => undefined), delay(5_000)]);
      gateProvider.closeAllConnections();
      if (gateProvider.listening) await new Promise<void>((resolve) => gateProvider.close(() => resolve()));
    }
  });
  it('pauses recovery when a dispatched tool has no durable completion receipt', async () => {
    const internals = runtime as unknown as { reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null> };
    const reserved = await internals.reserveAgent(task, projectId);
    expect(reserved).not.toBeNull();
    const now = new Date().toISOString();
    await db.batch([
      { mode: 'run', sql: "UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ?", params: [now, reserved!.lease.assignmentId] },
      { mode: 'run', sql: "UPDATE tasks SET status = 'running' WHERE id = ?", params: [task.id] },
      { mode: 'run', sql: `INSERT INTO tool_operations(id, run_id, task_id, tool_id, arguments_hash, status, created_at, updated_at)
        VALUES ('interrupted-op', ?, ?, 'artifacts.create', ?, 'dispatched', ?, ?)`, params: [task.runId, task.id, 'b'.repeat(64), now, now] },
    ], true);

    await runtime.recover();
    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [task.runId]))
      .toEqual({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
    expect(await db.one<{ status: string; output: string }>('SELECT status, output FROM tasks WHERE id = ?', [task.id]))
      .toMatchObject({ status: 'failed', output: expect.stringContaining('marked unknown') });
    expect(await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', ['interrupted-op']))
      .toMatchObject({ status: 'outcome_unknown', receipt_json: expect.stringContaining('inspect the workspace') });
    expect(await db.one<{ status: string }>('SELECT status FROM assignments WHERE id = ?', [reserved!.lease.assignmentId])).toEqual({ status: 'released' });

    await runtime.recover();
    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [task.runId]))
      .toEqual({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
  });

  it('stops at the model-turn limit and keeps the completed attempt in usage history', async () => {
    const provider = await startArtifactToolProvider();
    const previous = { url: process.env.MODEL_PRIMARY_BASE_URL, key: process.env.MODEL_PRIMARY_API_KEY, name: process.env.MODEL_PRIMARY_NAME };
    process.env.MODEL_PRIMARY_BASE_URL = provider.baseUrl;
    process.env.MODEL_PRIMARY_API_KEY = 'test-only-key';
    process.env.MODEL_PRIMARY_NAME = 'test-only-model';
    const testRuntime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir, MODEL_PRIMARY_BASE_URL: provider.baseUrl, MODEL_PRIMARY_API_KEY: 'test-only-key', MODEL_PRIMARY_NAME: 'test-only-model',
    }));
    let leaseSession: ReturnType<typeof startAssignmentLeaseSession> | null = null;
    try {
      const internals = testRuntime as unknown as {
        reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null>;
        runSpecialist(task: Task, projectId: string, agentId: string, definition: NonNullable<ReturnType<typeof registry.definitions.get>>, leaseSession: ReturnType<typeof startAssignmentLeaseSession>): Promise<string>;
      };
      const reserved = await internals.reserveAgent(task, projectId);
      expect(reserved).not.toBeNull();
      const definition = registry.definitions.get(reserved!.definitionId)!;
      registry.policy.limits.maxModelTurnsPerExecution = 1;
      definition.manifest.limits.maxModelTurns = 8;
      const now = new Date().toISOString();
      await db.batch([
        { mode: 'run', sql: "UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'assigned'", params: [task.id] },
        { mode: 'run', sql: "UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ? AND status = 'reserved'", params: [now, reserved!.lease.assignmentId] },
      ], true);
      leaseSession = startAssignmentLeaseSession(db, reserved!.lease, new AbortController().signal, { heartbeatMs: 1000 });
      const activeTask = (await projects.getTasks(task.runId)).find((item) => item.id === task.id)!;

      await expect(internals.runSpecialist(activeTask, projectId, reserved!.agentId, definition, leaseSession))
        .rejects.toThrow('Agent vượt quá 1 lượt model.');

      expect(provider.requestCount()).toBe(1);
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ?', [projectId])).toEqual({ count: 1 });
      expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM model_usage WHERE task_id = ?", [task.id])).toEqual({ count: 1 });
      expect(await db.one<{ status: string; total_tokens: number }>('SELECT status, total_tokens FROM model_call_reservations WHERE task_id = ?', [task.id]))
        .toMatchObject({ status: 'settled', total_tokens: 25 });
    } finally {
      await leaseSession?.stop();
      await testRuntime.stop();
      await provider.close();
      if (previous.url === undefined) delete process.env.MODEL_PRIMARY_BASE_URL; else process.env.MODEL_PRIMARY_BASE_URL = previous.url;
      if (previous.key === undefined) delete process.env.MODEL_PRIMARY_API_KEY; else process.env.MODEL_PRIMARY_API_KEY = previous.key;
      if (previous.name === undefined) delete process.env.MODEL_PRIMARY_NAME; else process.env.MODEL_PRIMARY_NAME = previous.name;
    }
  });

  it('enforces the tool-call limit before executing the over-limit call and records model usage', async () => {
    const provider = await startArtifactToolProvider();
    const previous = { url: process.env.MODEL_PRIMARY_BASE_URL, key: process.env.MODEL_PRIMARY_API_KEY, name: process.env.MODEL_PRIMARY_NAME };
    process.env.MODEL_PRIMARY_BASE_URL = provider.baseUrl;
    process.env.MODEL_PRIMARY_API_KEY = 'test-only-key';
    process.env.MODEL_PRIMARY_NAME = 'test-only-model';
    const testRuntime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir, MODEL_PRIMARY_BASE_URL: provider.baseUrl, MODEL_PRIMARY_API_KEY: 'test-only-key', MODEL_PRIMARY_NAME: 'test-only-model',
    }));
    let leaseSession: ReturnType<typeof startAssignmentLeaseSession> | null = null;
    try {
      const internals = testRuntime as unknown as {
        reserveAgent(task: Task, projectId: string): Promise<ReservedAgent | null>;
        runSpecialist(task: Task, projectId: string, agentId: string, definition: NonNullable<ReturnType<typeof registry.definitions.get>>, leaseSession: ReturnType<typeof startAssignmentLeaseSession>): Promise<string>;
      };
      const reserved = await internals.reserveAgent(task, projectId);
      expect(reserved).not.toBeNull();
      const definition = registry.definitions.get(reserved!.definitionId)!;
      registry.policy.limits.maxToolCallsPerExecution = 0;
      definition.manifest.limits.maxToolCalls = 20;
      const now = new Date().toISOString();
      await db.batch([
        { mode: 'run', sql: "UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'assigned'", params: [task.id] },
        { mode: 'run', sql: "UPDATE assignments SET status = 'active', worker_acknowledged_at = ? WHERE id = ? AND status = 'reserved'", params: [now, reserved!.lease.assignmentId] },
      ], true);
      leaseSession = startAssignmentLeaseSession(db, reserved!.lease, new AbortController().signal, { heartbeatMs: 1000 });
      const activeTask = (await projects.getTasks(task.runId)).find((item) => item.id === task.id)!;

      await expect(internals.runSpecialist(activeTask, projectId, reserved!.agentId, definition, leaseSession))
        .rejects.toThrow('Agent vượt giới hạn số lần gọi tool.');

      expect(provider.requestCount()).toBe(1);
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ?', [projectId])).toEqual({ count: 0 });
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE task_id = ?', [task.id])).toEqual({ count: 0 });
      expect(await db.one<{ total_tokens: number }>('SELECT total_tokens FROM model_usage WHERE task_id = ?', [task.id])).toEqual({ total_tokens: 25 });
    } finally {
      await leaseSession?.stop();
      await testRuntime.stop();
      await provider.close();
      if (previous.url === undefined) delete process.env.MODEL_PRIMARY_BASE_URL; else process.env.MODEL_PRIMARY_BASE_URL = previous.url;
      if (previous.key === undefined) delete process.env.MODEL_PRIMARY_API_KEY; else process.env.MODEL_PRIMARY_API_KEY = previous.key;
      if (previous.name === undefined) delete process.env.MODEL_PRIMARY_NAME; else process.env.MODEL_PRIMARY_NAME = previous.name;
    }
  });

  it('delivers a live steering command at a safe boundary and suppresses a stale tool call', async () => {
    const requests: Array<{ toolNames: string[]; messages: Array<{ role?: string; content?: string | null }> }> = [];
    let callCount = 0;
    let signalSpecialistRequest!: () => void;
    const specialistRequest = new Promise<void>((resolve) => { signalSpecialistRequest = resolve; });
    let releaseSpecialistResponse!: () => void;
    const waitForSteering = new Promise<void>((resolve) => { releaseSpecialistResponse = resolve; });
    const writerCapability = registry.definitions.get('writer')!.manifest.capabilities[0]!;
    const server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        void (async () => {
          callCount++;
          const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string; content?: string | null }> };
          const toolNames = (payload.tools ?? []).map((item) => item.function?.name ?? '');
          requests.push({ toolNames, messages: payload.messages ?? [] });
          const chunks: unknown[] = [];
          if (toolNames.includes('submit_plan')) {
            const args = JSON.stringify({ goal: 'Exercise steering', successCriteria: ['No stale tool executes'], tasks: [{ key: 'write', title: 'Prepare the deliverable', objective: 'Create the requested artifact unless the owner changes the instruction.', capability: writerCapability, dependsOn: [] }] });
            chunks.push({ id: 'steering-plan', choices: [{ delta: { tool_calls: [{ index: 0, id: 'plan-steer', type: 'function', function: { name: 'submit_plan', arguments: args } }] }, finish_reason: null }] });
            chunks.push({ id: 'steering-plan', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
          } else if (toolNames.includes('create_artifact') && callCount === 2) {
            signalSpecialistRequest();
            await waitForSteering;
            const args = JSON.stringify({ name: 'should-not-exist.md', content: '# Stale plan', mimeType: 'text/markdown' });
            chunks.push({ id: 'stale-artifact', choices: [{ delta: { tool_calls: [{ index: 0, id: 'stale-artifact-call', type: 'function', function: { name: 'create_artifact', arguments: args } }] }, finish_reason: null }] });
            chunks.push({ id: 'stale-artifact', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } });
          } else {
            const content = toolNames.includes('create_artifact') ? 'I followed the owner instruction and did not create the artifact.' : 'The owner instruction was applied; the stale artifact call was skipped.';
            chunks.push({ id: `steering-text-${callCount}`, choices: [{ delta: { content }, finish_reason: null }] });
            chunks.push({ id: `steering-text-${callCount}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33 } });
          }
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
        })().catch((error: unknown) => {
          response.writeHead(500, { 'Content-Type': 'text/plain' });
          response.end(error instanceof Error ? error.message : 'Mock provider failed.');
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const previous = { url: process.env.MODEL_PRIMARY_BASE_URL, key: process.env.MODEL_PRIMARY_API_KEY, name: process.env.MODEL_PRIMARY_NAME };
    process.env.MODEL_PRIMARY_BASE_URL = baseUrl;
    process.env.MODEL_PRIMARY_API_KEY = 'test-only-key';
    process.env.MODEL_PRIMARY_NAME = 'test-only-model';
    const testRuntime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir, MODEL_PRIMARY_BASE_URL: baseUrl, MODEL_PRIMARY_API_KEY: 'test-only-key', MODEL_PRIMARY_NAME: 'test-only-model',
    }));
    try {
      const project = await projects.createProject({ name: 'Live steering', goal: 'Honor owner direction safely.' });
      const request = await projects.createUserMessage(project.id, project.conversationId, 'Create an artifact for this task.');
      testRuntime.enqueue(request.runId);
      await specialistRequest;
      const activeTask = (await projects.getTasks(request.runId)).find((item) => item.key === 'write')!;
      const steering = await projects.createSteeringMessage(project.id, project.conversationId, 'Do not create an artifact; return a short status instead.', { key: 'live-steering-0001', bodyHash: 'live-steering-body' }, activeTask.id, {
        attachments: [{ name: 'status.txt', mimeType: 'text/plain', content: 'The status should mention that the attachment was received.' }],
      });
      releaseSpecialistResponse();

      await vi.waitFor(async () => expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' }), { timeout: 10_000 });

      expect(callCount).toBe(4);
      expect(requests[2]!.messages.some((message) => message.role === 'user' && message.content?.includes(steering.message.content))).toBe(true);
      expect(requests[2]!.messages.some((message) => message.role === 'user' && message.content?.includes('The status should mention that the attachment was received.'))).toBe(true);
      expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ? AND logical_name = 'should-not-exist.md'", [project.id])).toEqual({ count: 0 });
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
      expect(await db.one<{ status: string; acknowledged_at: string | null }>('SELECT status, acknowledged_at FROM run_steering WHERE id = ?', [steering.steeringId]))
        .toMatchObject({ status: 'acknowledged', acknowledged_at: expect.any(String) });
    } finally {
      releaseSpecialistResponse();
      await testRuntime.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previous.url === undefined) delete process.env.MODEL_PRIMARY_BASE_URL; else process.env.MODEL_PRIMARY_BASE_URL = previous.url;
      if (previous.key === undefined) delete process.env.MODEL_PRIMARY_API_KEY; else process.env.MODEL_PRIMARY_API_KEY = previous.key;
      if (previous.name === undefined) delete process.env.MODEL_PRIMARY_NAME; else process.env.MODEL_PRIMARY_NAME = previous.name;
    }
  }, 20_000);

  it('runs coding, deterministic CSV analysis, and an explicitly blocked research workflow end to end', async () => {
    await runtime.stop();
    const workspaceRoot = join(dataDir, 'workflow-workspace');
    await mkdir(workspaceRoot);
    await mkdir(join(workspaceRoot, 'src'));
    const csv = 'region,revenue\nNorth,120\nSouth,80\n';
    const requests: Array<{ toolNames: string[]; messages: Array<{ role?: string; content?: string | null }> }> = [];
    let responseId = 0;
    let activeSpecialistCalls = 0;
    let maxConcurrentSpecialistCalls = 0;
    const plan = {
      goal: 'Complete three independent workflows and report connector limitations truthfully.',
      successCriteria: ['Approved code change is present in the workspace.', 'CSV report contains deterministic computed values.', 'Missing research connector is reported without inventing sources.'],
      tasks: [
        { key: 'coding', title: 'Implement the requested code change', objective: 'Create src/feature.txt with the requested feature description. Use the approval-gated workspace write tool.', capability: 'code.implement', dependsOn: [] },
        { key: 'research', title: 'Research the requested topic', objective: 'Search for current sources. If the search connector is missing, report the blocker and do not invent sources or a report.', capability: 'research.search', dependsOn: [] },
        { key: 'analysis', title: 'Analyze the attached CSV', objective: 'Compute a deterministic revenue summary from sales.csv and save the calculated output as an artifact.', capability: 'data.csv', dependsOn: [] },
      ],
    };
    const mockServer = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        void (async () => {
          const payload = JSON.parse(raw) as {
            tools?: Array<{ function?: { name?: string } }>;
            messages?: Array<{ role?: string; content?: string | null }>;
          };
          const toolNames = (payload.tools ?? []).map((item) => item.function?.name ?? '');
          const messages = payload.messages ?? [];
          requests.push({ toolNames, messages });
          const specialistCall = !toolNames.includes('submit_plan') && toolNames.length > 0;
          if (specialistCall) {
            activeSpecialistCalls++;
            maxConcurrentSpecialistCalls = Math.max(maxConcurrentSpecialistCalls, activeSpecialistCalls);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          const toolResult = (id: string) => messages.some((message) => message.role === 'tool' && message.content?.includes(`"toolId":"${id}"`));
          let chunks: unknown[];
          if (toolNames.includes('submit_plan')) {
            chunks = [{ id: 'workflow-plan', choices: [{ delta: { tool_calls: [{ index: 0, id: 'workflow-plan-call', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }] },
              { id: 'workflow-plan', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }];
          } else if (toolNames.includes('propose_workspace_file_write')) {
            chunks = toolResult('workspace.write')
              ? [{ id: `workflow-code-${++responseId}`, choices: [{ delta: { content: 'The requested workspace file was written after approval and its exact contents were verified.' }, finish_reason: null }] },
                { id: `workflow-code-${responseId}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 12, total_tokens: 37 } }]
              : [{ id: `workflow-code-${++responseId}`, choices: [{ delta: { tool_calls: [{ index: 0, id: 'workflow-write-call', type: 'function', function: { name: 'propose_workspace_file_write', arguments: JSON.stringify({ path: 'src/feature.txt', content: 'Feature delivered through approval-gated workspace write.\n' }) } }] }, finish_reason: null }] },
                { id: `workflow-code-${responseId}`, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33 } }];
          } else if (toolNames.includes('search_web')) {
            chunks = toolResult('research.search')
              ? [{ id: `workflow-research-${++responseId}`, choices: [{ delta: { content: 'Research is blocked because the configured Brave Search connector has no API key. No sources were retrieved, so no research report or sourced claims are provided.' }, finish_reason: null }] },
                { id: `workflow-research-${responseId}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 18, total_tokens: 43 } }]
              : [{ id: `workflow-research-${++responseId}`, choices: [{ delta: { tool_calls: [{ index: 0, id: 'workflow-search-call', type: 'function', function: { name: 'search_web', arguments: JSON.stringify({ query: 'current agent office research sources' }) } }] }, finish_reason: null }] },
                { id: `workflow-research-${responseId}`, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33 } }];
          } else if (toolNames.includes('summarize_csv')) {
            if (toolResult('artifacts.create')) {
              chunks = [{ id: `workflow-analysis-${++responseId}`, choices: [{ delta: { content: 'The CSV summary artifact contains the deterministic row and revenue calculations.' }, finish_reason: null }] },
                { id: `workflow-analysis-${responseId}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 } }];
            } else if (toolResult('analysis.csv_summary')) {
              const resultMessage = messages.findLast((message) => message.role === 'tool' && message.content?.includes('"toolId":"analysis.csv_summary"'));
              const envelope = JSON.parse(resultMessage!.content!) as { data: string };
              const computed = JSON.parse(envelope.data) as { rows: number; columns: string[]; missing: Record<string, number>; numeric: Record<string, { count: number; sum: number; average: number; min: number; max: number }> };
              const artifact = `# Revenue analysis\n\nRows: ${computed.rows}\nRevenue sum: ${computed.numeric.revenue?.sum}\nRevenue average: ${computed.numeric.revenue?.average}\nRevenue range: ${computed.numeric.revenue?.min}–${computed.numeric.revenue?.max}\nMissing values: ${JSON.stringify(computed.missing)}\n`;
              chunks = [{ id: `workflow-analysis-${++responseId}`, choices: [{ delta: { tool_calls: [{ index: 0, id: 'workflow-analysis-artifact-call', type: 'function', function: { name: 'create_artifact', arguments: JSON.stringify({ name: 'revenue-analysis.md', content: artifact, mimeType: 'text/markdown' }) } }] }, finish_reason: null }] },
                { id: `workflow-analysis-${responseId}`, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } }];
            } else {
              chunks = [{ id: `workflow-analysis-${++responseId}`, choices: [{ delta: { tool_calls: [{ index: 0, id: 'workflow-csv-call', type: 'function', function: { name: 'summarize_csv', arguments: JSON.stringify({ csvContent: csv }) } }] }, finish_reason: null }] },
                { id: `workflow-analysis-${responseId}`, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33 } }];
            }
          } else {
            chunks = [{ id: `workflow-summary-${++responseId}`, choices: [{ delta: { content: 'The code change and CSV analysis completed. Research remains blocked because the Brave Search connector is not configured; no research sources or report are claimed.' }, finish_reason: null }] },
              { id: `workflow-summary-${responseId}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 45, completion_tokens: 20, total_tokens: 65 } }];
          }
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
          if (specialistCall) activeSpecialistCalls--;
        })().catch((error: unknown) => {
          response.writeHead(500, { 'Content-Type': 'text/plain' });
          response.end(error instanceof Error ? error.message : 'Mock workflow provider failed.');
        });
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const address = mockServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const previous = { url: process.env.MODEL_PRIMARY_BASE_URL, key: process.env.MODEL_PRIMARY_API_KEY, name: process.env.MODEL_PRIMARY_NAME };
    process.env.MODEL_PRIMARY_BASE_URL = baseUrl;
    process.env.MODEL_PRIMARY_API_KEY = 'test-only-key';
    process.env.MODEL_PRIMARY_NAME = 'test-only-model';
    const testRuntime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir, OFFICE_CONFIG_DIR: process.cwd(), OFFICE_RESEARCH_PROVIDER: 'brave',
      MODEL_PRIMARY_BASE_URL: baseUrl, MODEL_PRIMARY_API_KEY: 'test-only-key', MODEL_PRIMARY_NAME: 'test-only-model', RESEARCH_BRAVE_API_KEY: '',
    }));
    runtime = testRuntime;
    const liveOfficeActivities: Array<Record<string, unknown>> = [];
    const stopLiveOfficeActivities = events.onTransient((name, data) => {
      if (name === 'office.activity') liveOfficeActivities.push(data);
    });
    try {
      const project = await projects.createProject({ name: 'Generalist workflow E2E', goal: 'Verify code, research and CSV analysis with honest connector status.', workspaceRoot });
      const request = await projects.createUserMessage(project.id, project.conversationId, 'Implement a small requested change, research current sources, and analyze the attached sales data.', undefined, 'new-run', [
        { name: 'sales.csv', mimeType: 'text/csv', content: csv },
      ]);
      testRuntime.enqueue(request.runId);
      try {
        await vi.waitFor(async () => {
          const approval = await db.one<{ id: string }>("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'", [request.runId]);
          expect(approval?.id).toBeTruthy();
        }, { timeout: 10_000 });
      } catch {
        const state = await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]);
        const taskState = await projects.getTasks(request.runId);
        throw new Error(`Coding approval was not created. Run=${JSON.stringify(state)}, tasks=${JSON.stringify(taskState.map(({ key, status, output }) => ({ key, status, output })))}, providerRequests=${JSON.stringify(requests.map(({ toolNames }) => toolNames))}.`);
      }
      const pendingApproval = await db.one<{ id: string; arguments_json: string }>("SELECT id, arguments_json FROM approvals WHERE run_id = ? AND status = 'pending'", [request.runId]);
      expect(JSON.parse(pendingApproval!.arguments_json)).toMatchObject({
        path: 'src/feature.txt', content: 'Feature delivered through approval-gated workspace write.\n',
        previewBaseContent: '', previewBaseAvailable: true,
      });
      expect(await testRuntime.decideApproval(pendingApproval!.id, 'approve')).toMatchObject({ status: 'approved', resumed: true });
      try {
        await vi.waitFor(async () => {
          const state = await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId]);
          expect(state?.status).toBe('succeeded');
        }, { timeout: 20_000 });
      } catch {
        const state = await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]);
        const taskState = await projects.getTasks(request.runId);
        const assignmentState = await db.all<{ task_id: string; agent_instance_id: string; status: string; draining: number }>(`SELECT a.task_id, a.agent_instance_id, a.status, i.draining FROM assignments a JOIN agent_instances i ON i.id = a.agent_instance_id WHERE a.project_id = (SELECT project_id FROM runs WHERE id = ?) ORDER BY a.reserved_at`, [request.runId]);
        throw new Error(`Generalist workflow did not finish. Run=${JSON.stringify(state)}, tasks=${JSON.stringify(taskState.map(({ key, status, output }) => ({ key, status, output })))}, assignments=${JSON.stringify(assignmentState)}, providerRequests=${JSON.stringify(requests.map(({ toolNames, messages }) => ({ toolNames, roles: messages.map((message) => message.role) })))}.`);
      }

      const finalTasks = await projects.getTasks(request.runId);
      expect(finalTasks).toHaveLength(3);
      expect(maxConcurrentSpecialistCalls).toBeGreaterThanOrEqual(2);
      expect(finalTasks.map((item) => [item.key, item.status])).toEqual(expect.arrayContaining([
        ['coding', 'succeeded'], ['research', 'succeeded'], ['analysis', 'succeeded'],
      ]));
      expect(await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8')).toBe('Feature delivered through approval-gated workspace write.\n');
      expect(finalTasks.find((item) => item.key === 'research')?.output).toContain('Research is blocked because the configured Brave Search connector has no API key.');
      expect(finalTasks.find((item) => item.key === 'research')?.output).toContain('No sources were retrieved');
      const artifacts = await new ArtifactService(db, events, dataDir).list(project.id);
      expect(artifacts.map((item) => item.logicalName)).toEqual(['revenue-analysis.md']);
      const analysisArtifact = await new ArtifactService(db, events, dataDir).content(artifacts[0]!.versionId);
      expect(analysisArtifact?.content.toString('utf8')).toContain('Rows: 2\nRevenue sum: 200\nRevenue average: 100\nRevenue range: 80–120');
      const summary = await db.one<{ content: string }>("SELECT content FROM messages WHERE run_id = ? AND speaker = 'coordinator' AND status = 'completed' ORDER BY sequence DESC LIMIT 1", [request.runId]);
      expect(summary?.content).toContain('Research remains blocked because the Brave Search connector is not configured');
      expect(requests.some((entry) => entry.toolNames.includes('search_web') && entry.messages.some((message) => message.content?.includes('sales.csv') && message.content.includes(JSON.stringify(csv))))).toBe(true);
      expect(requests.some((entry) => entry.toolNames.includes('summarize_csv') && entry.messages.some((message) => message.content?.includes('sales.csv') && message.content.includes(JSON.stringify(csv))))).toBe(true);
      const csvToolResult = requests.flatMap((entry) => entry.messages).find((message) => message.role === 'tool' && message.content?.includes('"toolId":"analysis.csv_summary"'));
      expect(csvToolResult).toBeTruthy();
      const csvEnvelope = JSON.parse(csvToolResult!.content!) as { data: string };
      expect(JSON.parse(csvEnvelope.data)).toMatchObject({ rows: 2, numeric: { revenue: { sum: 200, average: 100, min: 80, max: 120 } } });
      expect(requests.some((entry) => entry.toolNames.includes('propose_workspace_file_write'))).toBe(true);
      expect(requests.some((entry) => entry.toolNames.length === 0 && entry.messages.some((message) => message.content?.includes('Research is blocked because the configured Brave Search connector has no API key')))).toBe(true);
      expect(await db.one<{ status: string }>("SELECT status FROM approvals WHERE run_id = ?", [request.runId])).toEqual({ status: 'approved' });
      expect(liveOfficeActivities).toEqual(expect.arrayContaining([
        expect.objectContaining({ toolId: 'workspace.write', target: 'feature.txt' }),
        expect.objectContaining({ toolId: 'research.search', target: 'current agent office research sources' }),
        expect.objectContaining({ toolId: 'analysis.csv_summary' }),
        expect.objectContaining({ toolId: 'artifacts.create', target: 'revenue-analysis.md' }),
      ]));
      expect(JSON.stringify(liveOfficeActivities)).not.toContain('Feature delivered through approval-gated workspace write.');
      expect(JSON.stringify(liveOfficeActivities)).not.toContain(csv);
    } finally {
      stopLiveOfficeActivities();
      await testRuntime.stop();
      await new Promise<void>((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()));
      if (previous.url === undefined) delete process.env.MODEL_PRIMARY_BASE_URL; else process.env.MODEL_PRIMARY_BASE_URL = previous.url;
      if (previous.key === undefined) delete process.env.MODEL_PRIMARY_API_KEY; else process.env.MODEL_PRIMARY_API_KEY = previous.key;
      if (previous.name === undefined) delete process.env.MODEL_PRIMARY_NAME; else process.env.MODEL_PRIMARY_NAME = previous.name;
    }
  }, 35_000);

  it('routes a config-added Designer through the existing scheduler and artifact tool', async () => {
    const designerConfigDir = join(dataDir, 'designer-registry');
    await mkdir(designerConfigDir);
    await Promise.all(['agents', 'config', 'skills'].map((name) => cp(join(process.cwd(), name), join(designerConfigDir, name), { recursive: true })));
    const definitionsDir = join(designerConfigDir, 'agents', 'definitions');
    await cp(join(definitionsDir, 'writer'), join(definitionsDir, 'designer'), { recursive: true });
    const designerManifestPath = join(definitionsDir, 'designer', 'agent.yaml');
    const designerManifest = (await readFile(designerManifestPath, 'utf8'))
      .replace(/^id: writer$/m, 'id: designer')
      .replace(/^version: .+$/m, 'version: 1.0.0')
      .replace(/^displayName: Writer$/m, 'displayName: Designer')
      .replace(/^capabilities: .+$/m, 'capabilities: [design.layout]');
    await writeFile(designerManifestPath, designerManifest);
    await writeFile(join(definitionsDir, 'designer', 'system.md'), 'Create a clear design brief and deliver it as a reviewable artifact.');
    const rosterPath = join(designerConfigDir, 'agents', 'roster.yaml');
    const roster = await readFile(rosterPath, 'utf8');
    await writeFile(rosterPath, `${roster}\n  - id: designer-01\n    definition: designer\n    displayName: Designer\n    enabled: true\n    appearanceSeed: 74001\n`);
    const designerRegistry = await loadRegistry(designerConfigDir);
    projects.updateRegistry(designerRegistry);
    Object.assign(registry, designerRegistry);
    await projects.seedRegistry(designerRegistry);

    const requests: Array<{ toolNames: string[]; lastMessage: string; messages: string[] }> = [];
    const designer = registry.roster.find((entry) => entry.definition === 'designer' && entry.enabled)!;
    const capability = registry.definitions.get('designer')!.manifest.capabilities[0]!;
    const server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string; content?: string | null }> };
        const toolNames = (payload.tools ?? []).map((item) => item.function?.name ?? '');
        const lastMessage = payload.messages?.at(-1)?.content ?? '';
        const lastRole = payload.messages?.at(-1)?.role;
        const messages = (payload.messages ?? []).map((message) => message.content ?? '');
        requests.push({ toolNames, lastMessage, messages });
        const plan = toolNames.includes('submit_plan');
        const artifact = toolNames.includes('create_artifact');
        const chunks: unknown[] = [];
        if (plan) {
          const args = JSON.stringify({
            goal: 'Prepare a design brief for the project',
            successCriteria: ['A design brief artifact is stored'],
            tasks: [{ key: 'design', title: 'Prepare the design brief', objective: 'Create a concise design brief as a markdown artifact.', capability, dependsOn: [] }],
          });
          chunks.push({ id: 'mock-plan', choices: [{ delta: { tool_calls: [{ index: 0, id: 'plan-call', type: 'function', function: { name: 'submit_plan', arguments: args } }] }, finish_reason: null }] });
          chunks.push({ id: 'mock-plan', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
        } else if (artifact && lastRole !== 'tool') {
          const args = JSON.stringify({ name: 'design-brief.md', content: '# Design brief\n\nPrepared by the Designer.', mimeType: 'text/markdown' });
          chunks.push({ id: 'mock-artifact', choices: [{ delta: { tool_calls: [{ index: 0, id: 'artifact-call', type: 'function', function: { name: 'create_artifact', arguments: args } }] }, finish_reason: null }] });
          chunks.push({ id: 'mock-artifact', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } });
        } else {
          const content = lastMessage.includes('Tool results') ? 'The design artifact is ready.' : 'The Designer created and verified the markdown artifact.';
          chunks.push({ id: 'mock-text', choices: [{ delta: { content }, finish_reason: null }] });
          chunks.push({ id: 'mock-text', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 } });
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const previous = {
      url: process.env.MODEL_PRIMARY_BASE_URL,
      key: process.env.MODEL_PRIMARY_API_KEY,
      name: process.env.MODEL_PRIMARY_NAME,
    };
    process.env.MODEL_PRIMARY_BASE_URL = baseUrl;
    process.env.MODEL_PRIMARY_API_KEY = 'test-only-key';
    process.env.MODEL_PRIMARY_NAME = 'test-only-model';
    const testRuntime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir, OFFICE_CONFIG_DIR: designerConfigDir, MODEL_PRIMARY_BASE_URL: baseUrl, MODEL_PRIMARY_API_KEY: 'test-only-key', MODEL_PRIMARY_NAME: 'test-only-model',
    }));
    try {
      const project = await projects.createProject({ name: 'Config-added Designer', goal: 'Validate a new specialist without scheduler or canvas changes.' });
      const request = await projects.createUserMessage(project.id, project.conversationId, 'Ask the Designer to prepare a design brief and save it as a markdown artifact.', undefined, 'new-run', [
        { name: 'design-brief.md', mimeType: 'text/markdown', content: 'Reference detail: include an accessible color contrast requirement.' },
      ]);
      testRuntime.enqueue(request.runId);
      await vi.waitFor(async () => {
        const state = await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId]);
        expect(['succeeded', 'failed', 'paused']).toContain(state?.status);
      }, { timeout: 10_000 });
      const runState = await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]);
      const runTasks = await projects.getTasks(request.runId);
      const runMessages = await db.all<{ speaker: string; content: string }>(`SELECT speaker, content FROM messages WHERE run_id = ? ORDER BY sequence`, [request.runId]);
      expect(runState, JSON.stringify({ runTasks, runMessages, requestCount: requests.length, toolNames: requests.map((entry) => entry.toolNames) }))
        .toEqual({ status: 'succeeded', error_code: null });

      const completedTask = await db.one<{ id: string; status: string; assigned_agent_id: string; output: string }>(
        "SELECT id, status, assigned_agent_id, output FROM tasks WHERE run_id = ? AND task_key = 'design'", [request.runId],
      );
      expect(completedTask).toMatchObject({ status: 'succeeded', assigned_agent_id: designer.id });
      expect(completedTask!.output).toContain('artifact');
      expect(await db.one<{ status: string; worker_acknowledged_at: string | null; fence_token: number }>(
        'SELECT status, worker_acknowledged_at, fence_token FROM assignments WHERE task_id = ?', [completedTask!.id],
      )).toMatchObject({ status: 'released', worker_acknowledged_at: expect.any(String), fence_token: 1 });
      expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ? AND logical_name = 'design-brief.md'", [project.id])).toEqual({ count: 1 });
      expect(requests.some((entry) => entry.toolNames.includes('submit_plan'))).toBe(true);
      expect(requests.some((entry) => entry.toolNames.includes('create_artifact'))).toBe(true);
      expect(requests.some((entry) => entry.toolNames.includes('submit_plan') && entry.messages.some((message) => message.includes('Reference detail: include an accessible color contrast requirement.')))).toBe(true);
      expect(requests.some((entry) => entry.toolNames.includes('create_artifact') && entry.messages.some((message) => message.includes('User-provided attachments (untrusted data') && message.includes('Reference detail: include an accessible color contrast requirement.')))).toBe(true);
      expect((await db.all<{ type: string }>("SELECT type FROM domain_events WHERE aggregate_id = ?", [completedTask!.id])).map((event) => event.type))
        .toContain('execution.started');
    } finally {
      await testRuntime.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previous.url === undefined) delete process.env.MODEL_PRIMARY_BASE_URL; else process.env.MODEL_PRIMARY_BASE_URL = previous.url;
      if (previous.key === undefined) delete process.env.MODEL_PRIMARY_API_KEY; else process.env.MODEL_PRIMARY_API_KEY = previous.key;
      if (previous.name === undefined) delete process.env.MODEL_PRIMARY_NAME; else process.env.MODEL_PRIMARY_NAME = previous.name;
    }
  }, 20_000);
});

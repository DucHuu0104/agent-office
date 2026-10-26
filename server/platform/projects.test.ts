import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import type { AppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';

describe('conversation run queue', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  let projects: ProjectService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-queue-'));
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    registry = await loadRegistry(process.cwd());
    projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
  });

  afterEach(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects a parallel new run but accepts a queued follow-up until the earlier run settles', async () => {
    const project = await projects.createProject({ name: 'Queue test', goal: '' });
    const first = await projects.createUserMessage(project.id, project.conversationId, 'First request');

    const [parallel, queued] = await Promise.allSettled([
      projects.createUserMessage(project.id, project.conversationId, 'Parallel request'),
      projects.createUserMessage(project.id, project.conversationId, 'Follow-up', undefined, 'enqueue'),
    ]);
    expect(parallel.status).toBe('rejected');
    if (parallel.status === 'rejected') expect(parallel.reason).toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });
    expect(queued.status).toBe('fulfilled');
    if (queued.status !== 'fulfilled') throw new Error('Queued follow-up was rejected.');

    const queuedRun = await projects.runForMessage(queued.value.runId);
    expect(queuedRun?.status).toBe('queued');
    expect(await projects.hasEarlierActiveRun(project.conversationId, queuedRun!.requestSequence)).toBe(true);

    await projects.updateRun(first.runId, 'succeeded');
    expect(await projects.hasEarlierActiveRun(project.conversationId, queuedRun!.requestSequence)).toBe(false);
  });

  it('drains a specialist without interrupting its active task and preserves the state across registry seeding', async () => {
    const project = await projects.createProject({ name: 'Agent drain', goal: 'Finish active work, then wait for reactivation.' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Run one specialist task.');
    await projects.updateRun(request.runId, 'executing');
    const now = new Date().toISOString();
    const taskId = 'drain-test-task';
    await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, assigned_agent_id, created_at, updated_at)
      VALUES (?, ?, 'drain', 'specialist', 'Active work', 'Keep this task running while the agent drains.', '["code.implement"]', 'running', 'developer-01', ?, ?)`, [taskId, request.runId, now, now]);
    await db.run(`INSERT INTO assignments(id, agent_instance_id, project_id, task_id, status, reserved_at, lease_owner, lease_expires_at, fence_token, worker_acknowledged_at)
      VALUES ('drain-test-assignment', 'developer-01', ?, ?, 'active', ?, 'worker-test', ?, 1, ?)`, [project.id, taskId, now, new Date(Date.now() + 60_000).toISOString(), now]);

    await projects.setSpecialistDraining('developer-01', true);
    await projects.setSpecialistDraining('developer-01', true);
    let developer = (await projects.officeSnapshot()).agents.find((agent) => agent.id === 'developer-01')!;
    expect(developer).toMatchObject({ availability: 'draining', execution: 'running', projectId: project.id, currentTaskId: taskId });
    expect(await projects.enabledSpecialists()).not.toContainEqual(expect.objectContaining({ id: 'developer-01' }));
    expect(await db.one<{ status: string }>("SELECT status FROM assignments WHERE id = 'drain-test-assignment'")).toEqual({ status: 'active' });

    await projects.seedRegistry();
    expect(await db.one<{ draining: number }>("SELECT draining FROM agent_instances WHERE id = 'developer-01'")).toEqual({ draining: 1 });
    await projects.setSpecialistDraining('developer-01', false);
    developer = (await projects.officeSnapshot()).agents.find((agent) => agent.id === 'developer-01')!;
    expect(developer).toMatchObject({ availability: 'busy', execution: 'running', projectId: project.id, currentTaskId: taskId });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE aggregate_id = 'developer-01' AND type IN ('agent.draining','agent.resumed')")).toEqual({ count: 2 });

    await db.run("UPDATE assignments SET status = 'released', released_at = ? WHERE id = 'drain-test-assignment'", [new Date().toISOString()]);
    await db.run("UPDATE tasks SET status = 'succeeded', updated_at = ? WHERE id = ?", [new Date().toISOString(), taskId]);
    expect((await projects.officeSnapshot()).agents.find((agent) => agent.id === 'developer-01')?.availability).toBe('ready');
    await expect(projects.setSpecialistDraining(project.coordinatorInstanceId, true)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', status: 404 });
  });

  it('returns the original run for an idempotent retry while it is active', async () => {
    const project = await projects.createProject({ name: 'Idempotency test', goal: '' });
    const idempotency = { key: 'same-message-key', bodyHash: 'same-body-hash' };
    const first = await projects.createUserMessage(project.id, project.conversationId, 'First request', idempotency);

    const retry = await projects.createUserMessage(project.id, project.conversationId, 'First request', idempotency);

    expect(retry.runId).toBe(first.runId);
    expect(retry.message.id).toBe(first.message.id);
  });

  it('commits the Coordinator final message and run outcome atomically and only once', async () => {
    const project = await projects.createProject({ name: 'Atomic finalization', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Finish this request.');
    await db.run("UPDATE runs SET status = 'executing' WHERE id = ?", [request.runId]);
    const steering = await projects.createSteeringMessage(project.id, project.conversationId, 'Keep the answer concise.');
    await db.run("UPDATE runs SET status = 'planning', error_code = 'FINALIZING' WHERE id = ?", [request.runId]);
    await db.run(`CREATE TRIGGER reject_coordinator_finalization BEFORE INSERT ON messages
      WHEN NEW.run_id = '${request.runId}' AND NEW.speaker = 'coordinator'
      BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END`);

    const input = {
      projectId: project.id, conversationId: project.conversationId, runId: request.runId,
      agentId: project.coordinatorInstanceId, content: 'The request is complete.', status: 'succeeded' as const, errorCode: null,
    };
    await expect(projects.finalizeRunWithAssistantMessage(input)).rejects.toThrow('injected finalization failure');
    expect(await projects.runForMessage(request.runId)).toMatchObject({ status: 'planning' });
    expect(await db.one<{ error_code: string }>('SELECT error_code FROM runs WHERE id = ?', [request.runId])).toEqual({ error_code: 'FINALIZING' });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE run_id = ? AND speaker = 'coordinator'", [request.runId])).toEqual({ count: 0 });
    expect(await db.one<{ status: string }>('SELECT status FROM run_steering WHERE id = ?', [steering.steeringId])).toEqual({ status: 'pending' });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'run.status_changed' AND aggregate_id = ?", [request.runId])).toEqual({ count: 0 });

    await db.run('DROP TRIGGER reject_coordinator_finalization');
    const message = await projects.finalizeRunWithAssistantMessage(input);
    expect(message).toMatchObject({ runId: request.runId, speaker: 'coordinator', content: input.content, status: 'completed' });
    expect(await projects.runForMessage(request.runId)).toMatchObject({ status: 'succeeded' });
    expect(await db.one<{ error_code: string | null }>('SELECT error_code FROM runs WHERE id = ?', [request.runId])).toEqual({ error_code: null });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE run_id = ? AND speaker = 'coordinator'", [request.runId])).toEqual({ count: 1 });
    expect(await db.one<{ status: string }>('SELECT status FROM run_steering WHERE id = ?', [steering.steeringId])).toEqual({ status: 'acknowledged' });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'run.status_changed' AND aggregate_id = ?", [request.runId])).toEqual({ count: 1 });
    await expect(projects.finalizeRunWithAssistantMessage(input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE run_id = ? AND speaker = 'coordinator'", [request.runId])).toEqual({ count: 1 });
  });

  it('returns the committed project when the creation acknowledgment is lost', async () => {
    const idempotency = { key: 'project-create-retry', bodyHash: 'same-project-request' };
    const originalTransact = events.transact.bind(events);
    let loseAcknowledgment = true;
    vi.spyOn(events, 'transact').mockImplementation(async (...args) => {
      const event = await originalTransact(...args);
      if (args[0] === 'project.created' && loseAcknowledgment) {
        loseAcknowledgment = false;
        throw new Error('injected lost commit acknowledgment');
      }
      return event;
    });

    const project = await projects.createProject({ name: 'Retry-safe project', goal: 'One room only.' }, idempotency);
    const retry = await projects.createProject({ name: 'Retry-safe project', goal: 'One room only.' }, idempotency);

    expect(retry.id).toBe(project.id);
    expect(await projects.listProjects()).toHaveLength(1);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'project.created'")).toEqual({ count: 1 });
    await expect(projects.createProject({ name: 'Different project', goal: 'Conflict.' }, { ...idempotency, bodyHash: 'different-project-request' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('serializes concurrent duplicate project commands through the idempotency record', async () => {
    const idempotency = { key: 'concurrent-project-create', bodyHash: 'same-concurrent-request' };
    const [first, retry] = await Promise.all([
      projects.createProject({ name: 'Concurrent retry', goal: 'One room.' }, idempotency),
      projects.createProject({ name: 'Concurrent retry', goal: 'One room.' }, idempotency),
    ]);

    expect(retry.id).toBe(first.id);
    expect(await projects.listProjects()).toHaveLength(1);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'project.created'")).toEqual({ count: 1 });
  });

  it('keeps three distinct Coordinators and room history through archive, restore and database restart', async () => {
    const rooms = await Promise.all(['Room one', 'Room two', 'Room three'].map((name) => projects.createProject({ name, goal: '' })));
    expect(new Set(rooms.map((room) => room.id)).size).toBe(3);
    expect(new Set(rooms.map((room) => room.coordinatorInstanceId)).size).toBe(3);
    expect(new Set(rooms.map((room) => room.conversationId)).size).toBe(3);

    const target = rooms[1]!;
    const request = await projects.createUserMessage(target.id, target.conversationId, 'Keep this conversation after restoring the room.');
    await projects.createAssistantMessage(target.conversationId, request.runId, target.coordinatorInstanceId, 'coordinator', 'The conversation is saved.');
    await projects.updateRun(request.runId, 'succeeded');

    expect((await projects.archiveProject(target.id))?.status).toBe('archived');
    expect((await projects.listProjects()).map((project) => project.id)).toEqual([rooms[0]!.id, rooms[2]!.id]);
    expect((await projects.restoreProject(target.id))?.status).toBe('active');

    await db.close();
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    registry = await loadRegistry(process.cwd());
    projects = new ProjectService(db, events, registry);

    const restored = await projects.getProject(target.id);
    expect(restored).toMatchObject({
      id: target.id,
      coordinatorInstanceId: target.coordinatorInstanceId,
      conversationId: target.conversationId,
      status: 'active',
    });
    expect((await projects.listMessages(target.conversationId)).map((message) => message.content)).toEqual([
      'Keep this conversation after restoring the room.',
      'The conversation is saved.',
    ]);
    expect((await projects.listProjects()).map((project) => project.id)).toEqual(rooms.map((room) => room.id));
    expect((await projects.officeSnapshot()).projects).toHaveLength(3);
  });

  it('stores steering as sequenced idempotent commands on the active run', async () => {
    const project = await projects.createProject({ name: 'Steering test', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Build the requested deliverable.');
    await db.run("UPDATE runs SET status = 'executing' WHERE id = ?", [run.runId]);

    const first = await projects.createSteeringMessage(project.id, project.conversationId, 'Use a compact layout.', { key: 'steer-key-0001', bodyHash: 'body-one' });
    const retry = await projects.createSteeringMessage(project.id, project.conversationId, 'Use a compact layout.', { key: 'steer-key-0001', bodyHash: 'body-one' });
    const second = await projects.createSteeringMessage(project.id, project.conversationId, 'Include keyboard navigation.', { key: 'steer-key-0002', bodyHash: 'body-two' });

    expect(first.runId).toBe(run.runId);
    expect(retry).toMatchObject({ runId: first.runId, steeringId: first.steeringId, message: { id: first.message.id } });
    expect(second).toMatchObject({ runId: run.runId, sequence: 2 });
    expect(await db.all<{ sequence: number; content: string }>(`SELECT s.sequence, m.content FROM run_steering s JOIN messages m ON m.id = s.message_id
      WHERE s.run_id = ? ORDER BY s.sequence`, [run.runId])).toEqual([
      { sequence: 1, content: 'Use a compact layout.' },
      { sequence: 2, content: 'Include keyboard navigation.' },
    ]);
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM runs WHERE conversation_id = ?', [project.conversationId])).toEqual({ count: 1 });
    expect((await events.listSince(0)).map((event) => event.type)).toContain('run.steering_received');

    await projects.updateRun(run.runId, 'succeeded');
    await expect(projects.createSteeringMessage(project.id, project.conversationId, 'Too late.')).rejects.toMatchObject({ code: 'RUN_NOT_STEERABLE' });
  });

  it('uses the next user message to resolve a Coordinator clarification', async () => {
    const project = await projects.createProject({ name: 'Clarification test', goal: '' });
    const question = await projects.createUserMessage(project.id, project.conversationId, 'Ambiguous request');
    await projects.createAssistantMessage(project.conversationId, question.runId, project.coordinatorInstanceId, 'coordinator', 'Which format should I use?');
    await projects.updateRun(question.runId, 'waiting_approval', 'WAITING_FOR_USER_INPUT');

    const answer = await projects.createUserMessage(project.id, project.conversationId, 'Use Markdown', undefined, 'enqueue');

    expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [question.runId]))
      .toMatchObject({ status: 'succeeded', error_code: null });
    const run = await projects.runForMessage(answer.runId);
    const context = await projects.projectContext(project.id, run!.requestSequence);
    expect(context?.history.map((message) => message.content)).toEqual(['Ambiguous request', 'Which format should I use?', 'Use Markdown']);
  });

  it('limits each Coordinator history to messages available when its request arrived', async () => {
    const project = await projects.createProject({ name: 'Context test', goal: '' });
    const first = await projects.createUserMessage(project.id, project.conversationId, 'First request');
    const firstRun = await projects.runForMessage(first.runId);
    await projects.createAssistantMessage(project.conversationId, first.runId, project.coordinatorInstanceId, 'coordinator', 'First response');
    const second = await projects.createUserMessage(project.id, project.conversationId, 'Second request', undefined, 'enqueue');
    const secondRun = await projects.runForMessage(second.runId);

    const firstContext = await projects.projectContext(project.id, firstRun!.requestSequence);
    const secondContext = await projects.projectContext(project.id, secondRun!.requestSequence);

    expect(firstContext?.history.map((message) => message.content)).toEqual(['First request']);
    expect(secondContext?.history.map((message) => message.content)).toEqual(['First request', 'First response', 'Second request']);
  });

  it('dispatches requests in sequence even when enqueue notifications arrive out of order', async () => {
    const project = await projects.createProject({ name: 'Dispatch order test', goal: '' });
    const first = await projects.createUserMessage(project.id, project.conversationId, 'First request');
    const second = await projects.createUserMessage(project.id, project.conversationId, 'Second request', undefined, 'enqueue');
    const runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), {
      host: '127.0.0.1', port: 4849, dataDir, configDir: process.cwd(), locale: 'vi', executionMode: 'disabled', maxRunningExecutions: 2, maxSpecialistExecutions: 1,
      docker: { image: 'node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213', network: 'none', installDependencies: 'none', memoryMb: 2048, cpus: 2, pidsLimit: 128 },
      research: { provider: 'duckduckgo', apiKey: '', configured: true },
      model: { baseUrl: 'https://example.invalid/v1', apiKey: '', name: '', configured: false },
    } satisfies AppConfig);
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const started: string[] = [];
    let active = 0;
    let peakActive = 0;
    vi.spyOn(runtime as unknown as { processRun: (runId: string, signal: AbortSignal) => Promise<void> }, 'processRun')
      .mockImplementation(async (runId) => {
        started.push(runId);
        active++;
        peakActive = Math.max(peakActive, active);
        if (runId === first.runId) await firstGate;
        await projects.updateRun(runId, 'succeeded');
        active--;
      });

    try {
      runtime.enqueue(second.runId);
      runtime.enqueue(first.runId);
      await vi.waitFor(() => expect(started).toEqual([first.runId]));
      finishFirst();
      await vi.waitFor(() => expect(started).toEqual([first.runId, second.runId]));
      await vi.waitFor(async () => expect(await projects.runForMessage(second.runId)).toMatchObject({ status: 'succeeded' }));
      expect(peakActive).toBe(1);
    } finally {
      finishFirst();
      await runtime.stop();
    }
  });
});

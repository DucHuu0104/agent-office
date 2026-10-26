import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { HookRunner } from './hooks';
import { MemoryService } from './memory';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';

describe('agent lifecycle hooks', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;
  let memory: MemoryService;
  let hooks: HookRunner;
  let registry: Awaited<ReturnType<typeof loadRegistry>>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-hooks-'));
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    registry = await loadRegistry(process.cwd());
    projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    memory = new MemoryService(db, events);
    hooks = new HookRunner({ db, events, memory, projects });
  });

  afterEach(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('loads project context and proposes a reviewable, idempotent summary', async () => {
    const project = await projects.createProject({ name: 'Hook project', goal: 'Ship a local-first assistant.' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Build the first workflow.');
    await projects.updateRun(run.runId, 'executing');
    const coordinator = registry.definitions.get('coordinator')!;
    const context = { eventId: 'hook-event-1', executionId: run.runId, runId: run.runId, projectId: project.id, agentInstanceId: project.coordinatorInstanceId, data: { requestSequence: 1 } };

    const loaded = await hooks.dispatch(coordinator, 'before_run', context);
    expect(loaded[0]?.result).toMatchObject({ projectContext: { project: { name: 'Hook project', goal: 'Ship a local-first assistant.' } } });
    await projects.updateRun(run.runId, 'succeeded');
    const summaryContext = { ...context, eventId: 'hook-event-2', data: { outcome: 'succeeded', summary: 'The first workflow uses a persistent project room and one coordinator.' } };
    const first = await hooks.dispatch(coordinator, 'after_run', summaryContext);
    const second = await hooks.dispatch(coordinator, 'after_run', { ...summaryContext, eventId: 'hook-event-3' });
    const row = first[0]?.result as { memoryId: string; status: string };

    expect(row.status).toBe('proposed');
    expect(second[0]?.result).toMatchObject({ memoryId: row.memoryId, status: 'proposed' });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM memory_records WHERE source_type = 'hook_summary' AND source_ref = ?", [`run:${run.runId}`])).toEqual({ count: 1 });
    expect(await memory.searchProject(project.id, 'persistent coordinator')).toEqual([]);
    await memory.decideProposal(row.memoryId, 1, 'accept');
    expect(await memory.searchProject(project.id, 'persistent coordinator')).toHaveLength(1);
  });

  it('audits tool intent by hash without storing raw arguments', async () => {
    const project = await projects.createProject({ name: 'Hook audit', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Read a file.');
    const developer = registry.definitions.get('developer')!;
    const argumentsHash = 'a'.repeat(64);
    const result = await hooks.dispatch(developer, 'before_tool_call', {
      eventId: 'intent-event', executionId: 'task-1', runId: run.runId, projectId: project.id,
      taskId: 'task-1', agentInstanceId: 'developer-01', data: { toolId: 'workspace.read', argumentsHash },
    });
    const event = (await events.listSince(0)).find((item) => item.type === 'tool.intent_audited');

    expect(result[0]?.result).toEqual({ audited: true });
    expect(event?.payload).toMatchObject({ toolId: 'workspace.read', argumentsHash });
    expect(event?.payload).not.toHaveProperty('arguments');
  });

  it('records lifecycle checkpoints with allowlisted metadata and excludes prompts, results, and secret text', async () => {
    const project = await projects.createProject({ name: 'Lifecycle audit', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Call the configured model.');
    const developer = registry.definitions.get('developer')!;
    const audited = {
      ...developer,
      hooks: { ...developer.hooks, hooks: { ...developer.hooks.hooks, after_model_call: [{ handler: 'lifecycle.audit' as const, timeoutMs: 1000, onError: 'warn' as const }] } },
    };
    const context = {
      eventId: 'model-event-1', executionId: 'task-1', runId: run.runId, projectId: project.id, taskId: 'task-1', agentInstanceId: 'developer-01',
      data: { profileId: 'coding', attempt: 2, outcome: 'succeeded', promptTokens: 42, completionTokens: 11, toolCallCount: 1, prompt: 'do not persist', response: 'do not persist', apiKey: 'secret-value' },
    };
    const [result] = await Promise.all([
      hooks.dispatch(audited, 'after_model_call', context),
      hooks.dispatch(audited, 'after_model_call', context),
    ]);
    const restartedHooks = new HookRunner({ db, events, memory, projects });
    const replayed = await restartedHooks.dispatch(audited, 'after_model_call', context);
    const lifecycleEvents = (await events.listSince(0)).filter((item) => item.type === 'agent.lifecycle_hook');
    const event = lifecycleEvents[0];

    expect(result[0]?.result).toEqual({ recorded: true });
    expect(replayed[0]?.result).toEqual({ recorded: true });
    expect(lifecycleEvents).toHaveLength(1);
    expect(event?.payload).toMatchObject({
      event: 'after_model_call', runId: run.runId, taskId: 'task-1', agentInstanceId: 'developer-01',
      metadata: { hookEventId: 'model-event-1', profileId: 'coding', attempt: 2, promptTokens: 42, completionTokens: 11, toolCallCount: 1 },
    });
    expect(JSON.stringify(event?.payload)).not.toContain('do not persist');
    expect(JSON.stringify(event?.payload)).not.toContain('secret-value');
  });

  it('replays a pending lifecycle audit after reopening the database without duplicating it', async () => {
    const project = await projects.createProject({ name: 'Hook replay', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Resume a pending audit.');
    const coordinator = registry.definitions.get('coordinator')!;
    const context = {
      eventId: 'replay-lifecycle-event', executionId: run.runId, runId: run.runId, projectId: project.id,
      agentInstanceId: project.coordinatorInstanceId, data: { requestSequence: 1, prompt: 'never persist this text' },
    };
    const revisionBefore = await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'");
    const commitEvent = events.transactIdempotent.bind(events);
    vi.spyOn(events, 'transactIdempotent').mockImplementationOnce(async (...args) => {
      await commitEvent(...args);
      throw new Error('simulated interruption after event commit');
    });

    const first = await hooks.dispatch(coordinator, 'before_run', context);
    expect(first.at(-1)?.result).toBeNull();
    const pending = await db.one<{ status: string; payload_json: string | null }>(
      "SELECT status, payload_json FROM hook_outbox WHERE event_id = 'replay-lifecycle-event'",
    );
    expect(pending?.status).toBe('pending');
    expect(pending?.payload_json).not.toContain('never persist this text');
    const revisionAfterCommit = await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'");
    expect(revisionAfterCommit?.revision).toBe((revisionBefore?.revision ?? 0) + 1);

    await db.close();
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    memory = new MemoryService(db, events);
    hooks = new HookRunner({ db, events, memory, projects });
    await hooks.replayPending();
    await hooks.replayPending();

    expect((await events.listSince(0)).filter((item) => item.type === 'agent.lifecycle_hook')).toHaveLength(1);
    expect(await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'")).toEqual(revisionAfterCommit);
    expect(await db.one<{ status: string; payload_json: string | null; attempts: number }>(
      "SELECT status, payload_json, attempts FROM hook_outbox WHERE event_id = 'replay-lifecycle-event'",
    )).toMatchObject({ status: 'completed', payload_json: null, attempts: 2 });
  });

  it('replays a committed tool-intent audit before the fail-closed hook can be retried', async () => {
    const project = await projects.createProject({ name: 'Intent replay', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Inspect the tool audit recovery.');
    const developer = registry.definitions.get('developer')!;
    const argumentsHash = 'd'.repeat(64);
    const context = {
      eventId: 'replay-intent-event', executionId: 'task-intent-replay', runId: run.runId, projectId: project.id,
      taskId: 'task-intent-replay', agentInstanceId: 'developer-01', data: { toolId: 'workspace.read', argumentsHash, arguments: { path: 'private.txt' } },
    };
    const revisionBefore = await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'");
    const commitEvent = events.transactIdempotent.bind(events);
    vi.spyOn(events, 'transactIdempotent').mockImplementationOnce(async (...args) => {
      await commitEvent(...args);
      throw new Error('simulated interruption after intent audit commit');
    });

    await expect(hooks.dispatch(developer, 'before_tool_call', context)).rejects.toMatchObject({ code: 'HOOK_FAILED' });
    expect(await db.one<{ status: string; payload_json: string }>("SELECT status, payload_json FROM hook_outbox WHERE event_id = 'replay-intent-event'")).toMatchObject({
      status: 'pending', payload_json: JSON.stringify({ toolId: 'workspace.read', argumentsHash }),
    });
    expect((await events.listSince(0)).filter((item) => item.type === 'tool.intent_audited')).toHaveLength(1);
    const revisionAfterCommit = await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'");
    expect(revisionAfterCommit?.revision).toBe((revisionBefore?.revision ?? 0) + 1);

    await db.close();
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    memory = new MemoryService(db, events);
    hooks = new HookRunner({ db, events, memory, projects });
    await hooks.replayPending();

    expect((await events.listSince(0)).filter((item) => item.type === 'tool.intent_audited')).toHaveLength(1);
    expect(await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'")).toEqual(revisionAfterCommit);
    expect(await db.one<{ status: string; payload_json: string | null; attempts: number }>(
      "SELECT status, payload_json, attempts FROM hook_outbox WHERE event_id = 'replay-intent-event'",
    )).toMatchObject({ status: 'completed', payload_json: null, attempts: 2 });
  });

  it('replays a failed memory proposal after restart and clears its temporary payload', async () => {
    const project = await projects.createProject({ name: 'Summary replay', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Summarize this completed run.');
    await projects.updateRun(run.runId, 'succeeded');
    const coordinator = registry.definitions.get('coordinator')!;
    const summary = 'The run completed a local-first workflow and verified the output.';
    const persistSummary = memory.proposeRunSummary.bind(memory);
    vi.spyOn(memory, 'proposeRunSummary').mockImplementationOnce(async (...args) => {
      await persistSummary(...args);
      throw new Error('simulated interruption after proposal commit');
    });

    const first = await hooks.dispatch(coordinator, 'after_run', {
      eventId: 'replay-summary-event', executionId: run.runId, runId: run.runId, projectId: project.id,
      agentInstanceId: project.coordinatorInstanceId, data: { outcome: 'succeeded', summary },
    });
    expect(first[0]?.result).toBeNull();
    expect(await db.one<{ payload_json: string | null }>("SELECT payload_json FROM hook_outbox WHERE event_id = 'replay-summary-event'")).toMatchObject({ payload_json: expect.stringContaining(summary) });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM memory_records WHERE source_type = 'hook_summary' AND source_ref = ?", [`run:${run.runId}`])).toEqual({ count: 1 });

    await db.close();
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    memory = new MemoryService(db, events);
    hooks = new HookRunner({ db, events, memory, projects });
    await hooks.replayPending();

    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM memory_records WHERE source_type = 'hook_summary' AND source_ref = ?", [`run:${run.runId}`])).toEqual({ count: 1 });
    expect(await db.one<{ status: string; payload_json: string | null; attempts: number }>(
      "SELECT status, payload_json, attempts FROM hook_outbox WHERE event_id = 'replay-summary-event'",
    )).toMatchObject({ status: 'completed', payload_json: null, attempts: 2 });
  });

  it('does not persist credential-like run summaries in the hook outbox', async () => {
    const project = await projects.createProject({ name: 'Sensitive summary', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Reject a credential-like summary.');
    await projects.updateRun(run.runId, 'succeeded');
    const coordinator = registry.definitions.get('coordinator')!;

    const results = await hooks.dispatch(coordinator, 'after_run', {
      eventId: 'sensitive-summary-event', executionId: run.runId, runId: run.runId, projectId: project.id,
      agentInstanceId: project.coordinatorInstanceId, data: { outcome: 'succeeded', summary: 'api_key=supersecretcredential123456' },
    });

    expect(results[0]?.result).toBeNull();
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM hook_outbox WHERE handler = 'memory.propose_summary'")).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM memory_records WHERE source_type = 'hook_summary'")).toEqual({ count: 0 });
    expect(JSON.stringify(await db.all('SELECT payload_json FROM hook_outbox'))).not.toContain('supersecretcredential');
  });

  it('times out a slow built-in handler according to the package policy', async () => {
    const project = await projects.createProject({ name: 'Hook timeout', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Wait for project context.');
    const coordinator = registry.definitions.get('coordinator')!;
    const slow = {
      ...coordinator,
      hooks: { ...coordinator.hooks, hooks: { ...coordinator.hooks.hooks, before_run: [{ handler: 'context.load_project' as const, timeoutMs: 50, onError: 'fail' as const }] } },
    };
    vi.spyOn(projects, 'projectContext').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return null;
    });

    await expect(hooks.dispatch(slow, 'before_run', {
      eventId: 'slow-event', executionId: run.runId, runId: run.runId, projectId: project.id,
      agentInstanceId: project.coordinatorInstanceId, data: { requestSequence: 1 },
    })).rejects.toMatchObject({ code: 'HOOK_TIMEOUT' });
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect((await events.listSince(0)).some((event) => event.type === 'memory.proposed')).toBe(false);
  });
});

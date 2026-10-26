import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { createPlatformHandler } from './http';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { UsageLedger } from './usage';
import { MemoryService } from './memory';
import { RetentionService } from './retention';
import { agentSchema, eventEnvelopeSchema, messageSchema, officeSnapshotSchema, projectSchema } from '../../shared/platform/contracts';
import type { AgentRuntime } from './runtime';

describe('conversation message modes over HTTP', () => {
  let dataDir: string;
  let registryRoot: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;
  let server: http.Server;
  const enqueue = vi.fn();
  const secretSentinel = 'http-response-secret-sentinel-7f26d41';
  const updateRegistry = vi.fn();
  const pauseRun = vi.fn(async (_runId: string, version: number) => ({ status: 'pausing' as const, version: version + 1 }));
  const resumeRun = vi.fn(async (_runId: string, version: number) => ({ status: 'queued' as const, version: version + 1 }));
  const previewInfo = {
    id: '0123456789abcdefghijklmnopqrstuv', projectId: 'project-fixture', script: 'preview',
    url: 'http://127.0.0.2:43123/', createdAt: '2026-10-25T00:00:00.000Z', expiresAt: '2026-10-25T00:30:00.000Z',
    executionMode: 'local-trusted' as const, networkAccess: true,
  };
  const workspacePreviews = {
    describe: vi.fn(async () => ({ executionMode: 'local-trusted' as const, scripts: [{ name: 'preview', command: 'node server.mjs', lifecycle: [] }], packageChecksum: 'a'.repeat(64), active: null })),
    start: vi.fn(async () => previewInfo),
    stop: vi.fn(async (id: string) => id === previewInfo.id),
    list: vi.fn(() => []),
  };
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-http-'));
    registryRoot = join(dataDir, 'registry');
    await mkdir(registryRoot);
    await cp(join(process.cwd(), 'agents'), join(registryRoot, 'agents'), { recursive: true });
    await cp(join(process.cwd(), 'config'), join(registryRoot, 'config'), { recursive: true });
    await cp(join(process.cwd(), 'skills'), join(registryRoot, 'skills'), { recursive: true });
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, await loadRegistry(process.cwd()));
    await projects.seedRegistry();
    enqueue.mockReset();
    updateRegistry.mockReset();
    pauseRun.mockClear();
    resumeRun.mockClear();
    workspacePreviews.describe.mockClear();
    workspacePreviews.start.mockClear();
    workspacePreviews.stop.mockClear();
    workspacePreviews.list.mockClear();
    const handler = createPlatformHandler({
      config: loadAppConfig({ OFFICE_DATA_DIR: dataDir, MODEL_PRIMARY_API_KEY: secretSentinel, MODEL_PRIMARY_NAME: 'http-test-model' }),
      db,
      events,
      projects,
      runtime: { enqueue, updateRegistry, pause: pauseRun, resume: resumeRun } as unknown as AgentRuntime,
      artifacts: new ArtifactService(db, events, dataDir),
      memory: new MemoryService(db, events),
      registry: await loadRegistry(process.cwd()),
      registryRoot,
      workspacePreviews: workspacePreviews as never,
    });
    server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports the execution grant without enabling local checks by default', async () => {
    const response = await fetch(`${baseUrl}/platform/v1/health`);
    const body = await response.json() as { runtime: { ready: boolean; executionMode: string; localChecksEnabled: boolean; dockerChecksEnabled: boolean } };

    expect(response.status).toBe(200);
    expect(body.runtime).toEqual({ ready: true, executionMode: 'disabled', localChecksEnabled: false, dockerChecksEnabled: false });
  });

  it('does not expose configured provider credentials in public HTTP responses', async () => {
    for (const path of ['/platform/v1/health', '/platform/v1/office', '/platform/v1/agents']) {
      const response = await fetch(`${baseUrl}${path}`);
      const body = await response.text();
      const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n');

      expect(response.status).toBe(200);
      expect(`${body}\n${headers}`).not.toContain(secretSentinel);
    }
  });

  it('does not mount Habblaud World routes in the standalone Agent Office API', async () => {
    for (const [method, path] of [
      ['GET', '/api/world/status'],
      ['GET', '/api/world/last-uplink'],
      ['POST', '/api/world/cmd'],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json(), `${method} ${path}`).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('drains and resumes a specialist through the owner API', async () => {
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };

    const drained = await fetch(`${baseUrl}/platform/v1/agents/developer-01/drain`, {
      method: 'POST', headers, body: JSON.stringify({ draining: true }),
    });
    expect(drained.status).toBe(200);
    expect((await drained.json() as { agent: { id: string; availability: string } }).agent).toMatchObject({ id: 'developer-01', availability: 'draining' });

    const resumed = await fetch(`${baseUrl}/platform/v1/agents/developer-01/drain`, {
      method: 'POST', headers, body: JSON.stringify({ draining: false }),
    });
    expect(resumed.status).toBe(200);
    expect((await resumed.json() as { agent: { id: string; availability: string } }).agent).toMatchObject({ id: 'developer-01', availability: 'ready' });

    const invalid = await fetch(`${baseUrl}/platform/v1/agents/missing-agent/drain`, {
      method: 'POST', headers, body: JSON.stringify({ draining: true }),
    });
    expect(invalid.status).toBe(404);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type IN ('agent.draining','agent.resumed')")).toEqual({ count: 2 });
  });

  it('protects pause and resume routes with CSRF and requires a run version', async () => {
    const project = await projects.createProject({ name: 'Pause API room', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'A queued run');
    const version = await db.one<{ version: number }>('SELECT version FROM runs WHERE id = ?', [request.runId]);
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };

    const rejected = await fetch(`${baseUrl}/platform/v1/runs/${request.runId}/pause`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie! }, body: JSON.stringify({ expectedVersion: version!.version }),
    });
    expect(rejected.status).toBe(403);
    expect(pauseRun).not.toHaveBeenCalled();

    const invalid = await fetch(`${baseUrl}/platform/v1/runs/${request.runId}/pause`, {
      method: 'POST', headers, body: '{}',
    });
    expect(invalid.status).toBe(400);
    expect(pauseRun).not.toHaveBeenCalled();

    const paused = await fetch(`${baseUrl}/platform/v1/runs/${request.runId}/pause`, {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: version!.version }),
    });
    expect(paused.status).toBe(202);
    expect(await paused.json()).toEqual({ status: 'pausing', version: version!.version + 1 });
    expect(pauseRun).toHaveBeenCalledWith(request.runId, version!.version);

    const resumed = await fetch(`${baseUrl}/platform/v1/runs/${request.runId}/resume`, {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: version!.version + 1 }),
    });
    expect(resumed.status).toBe(202);
    expect(await resumed.json()).toEqual({ status: 'queued', version: version!.version + 2 });
    expect(resumeRun).toHaveBeenCalledWith(request.runId, version!.version + 1, undefined);
  });

  it('scopes website previews to an attached project and protects starting or stopping with CSRF', async () => {
    const workspaceRoot = join(dataDir, 'preview-workspace');
    await mkdir(workspaceRoot);
    const project = await projects.createProject({ name: 'Preview route room', goal: '', workspaceRoot });
    const setupResponse = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/workspace-preview`);
    expect(setupResponse.status).toBe(200);
    expect((await setupResponse.json() as { scripts: Array<{ name: string }> }).scripts.map((script) => script.name)).toEqual(['preview']);
    expect(workspacePreviews.describe).toHaveBeenCalledWith(project.id, workspaceRoot);

    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const body = JSON.stringify({ script: 'preview', packageChecksum: 'a'.repeat(64), allowNetworkAccess: true });
    const rejected = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/workspace-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie! }, body,
    });
    expect(rejected.status).toBe(403);
    expect(workspacePreviews.start).not.toHaveBeenCalled();

    const started = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/workspace-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken }, body,
    });
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual({ preview: previewInfo });
    expect(workspacePreviews.start).toHaveBeenCalledWith({ projectId: project.id, root: workspaceRoot, script: 'preview', packageChecksum: 'a'.repeat(64), allowNetworkAccess: true });

    const stopPath = `/platform/v1/workspace-previews/${previewInfo.id}`;
    const rejectedStop = await fetch(`${baseUrl}${stopPath}`, { method: 'DELETE', headers: { Cookie: cookie! } });
    expect(rejectedStop.status).toBe(403);
    const stopped = await fetch(`${baseUrl}${stopPath}`, { method: 'DELETE', headers: { Cookie: cookie!, 'X-CSRF-Token': session.csrfToken } });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ stopped: true });
  });

  it('keeps project, office, agent, message and event API payloads aligned with shared contracts', async () => {
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };

    const createdResponse = await fetch(`${baseUrl}/platform/v1/projects`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'contract-project-create' },
      body: JSON.stringify({ name: 'Contract fixture room', goal: 'Check the public payload shape.' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { project: unknown };
    const project = projectSchema.parse(created.project);

    const projectList = await fetch(`${baseUrl}/platform/v1/projects`).then((response) => response.json()) as { projects: unknown[] };
    expect(projectList.projects.map((candidate) => projectSchema.parse(candidate).id)).toContain(project.id);

    const office = await fetch(`${baseUrl}/platform/v1/office`).then((response) => response.json()) as { snapshot: unknown };
    const snapshot = officeSnapshotSchema.parse(office.snapshot);
    expect(snapshot.projects.map((candidate) => candidate.id)).toContain(project.id);
    expect(snapshot.agents.map((candidate) => agentSchema.parse(candidate).id)).toContain(project.coordinatorInstanceId);

    const sentResponse = await fetch(`${baseUrl}/platform/v1/conversations/${encodeURIComponent(project.conversationId)}/messages`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'contract-message-create' },
      body: JSON.stringify({ text: 'Check the stored message shape.' }),
    });
    expect(sentResponse.status).toBe(202);
    const sent = await sentResponse.json() as { message: unknown };
    messageSchema.parse(sent.message);

    const history = await fetch(`${baseUrl}/platform/v1/conversations/${encodeURIComponent(project.conversationId)}/messages`)
      .then((response) => response.json()) as { messages: unknown[] };
    expect(history.messages.map((message) => messageSchema.parse(message).content)).toContain('Check the stored message shape.');

    for (const event of await events.listSince(0)) eventEnvelopeSchema.parse(event);
  });

  it('returns an office cursor that leaves events created during snapshot loading available for replay', async () => {
    const originalSnapshot = projects.officeSnapshot.bind(projects);
    let createdProjectId = '';
    vi.spyOn(projects, 'officeSnapshot').mockImplementation(async () => {
      const created = await projects.createProject({ name: 'Snapshot race room', goal: '' });
      createdProjectId = created.id;
      return originalSnapshot();
    });

    const response = await fetch(`${baseUrl}/platform/v1/office`);
    const body = await response.json() as { cursor: number; snapshot: { projects: Array<{ id: string }> } };
    expect(response.status).toBe(200);
    expect(body.snapshot.projects.map((project) => project.id)).toContain(createdProjectId);
    expect((await events.listSince(body.cursor)).some((event) => event.type === 'project.created' && event.payload.projectId === createdProjectId)).toBe(true);
  });

  it('resumes SSE from Last-Event-ID and replays an event created during the replay handshake exactly once', async () => {
    const firstRoom = await projects.createProject({ name: 'SSE first room', goal: '' });
    const secondRoom = await projects.createProject({ name: 'SSE second room', goal: '' });
    const existingEvents = await events.listSince(0);
    const firstEvent = existingEvents.find((event) => event.payload.projectId === firstRoom.id)!;
    const secondEvent = existingEvents.find((event) => event.payload.projectId === secondRoom.id)!;

    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();

    const originalListSince = events.listSince.bind(events);
    let beginReplay!: () => void;
    let releaseReplay!: () => void;
    const replayStarted = new Promise<void>((resolve) => { beginReplay = resolve; });
    const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve; });
    vi.spyOn(events, 'listSince').mockImplementation(async (sequence, limit) => {
      const replay = await originalListSince(sequence, limit);
      beginReplay();
      await replayGate;
      return replay;
    });

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${baseUrl}/platform/v1/events?since=0`, {
        headers: { Cookie: cookie!, 'Last-Event-ID': String(firstEvent.sequence) },
      });
      expect(response.status).toBe(200);
      await replayStarted;
      const thirdRoom = await projects.createProject({ name: 'SSE third room', goal: '' });
      const thirdEvent = (await originalListSince(secondEvent.sequence)).find((event) => event.payload.projectId === thirdRoom.id)!;
      releaseReplay();
      reader = response.body!.getReader();

      const decoder = new TextDecoder();
      let wire = '';
      let ids: number[] = [];
      while (ids.length < 2) {
        const chunk = await reader.read();
        if (chunk.done) break;
        wire += decoder.decode(chunk.value, { stream: true });
        ids = [...wire.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
      }
      expect(ids).toEqual([secondEvent.sequence, thirdEvent.sequence]);
    } finally {
      releaseReplay();
      await reader?.cancel();
    }
  });

  it('asks SSE clients to refresh the snapshot when the durable replay window is exceeded', async () => {
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    await db.run(`WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 5001
    ) INSERT INTO domain_events(event_id, workspace_id, type, aggregate_id, payload_json, occurred_at)
      SELECT 'replay-gap-' || value, 'local-workspace', 'test.event', 'aggregate-' || value, '{}', '2026-10-25T00:00:00.000Z'
      FROM sequence`);
    const latest = await db.one<{ sequence: number }>('SELECT MAX(sequence) AS sequence FROM domain_events WHERE workspace_id = ?', ['local-workspace']);

    const response = await fetch(`${baseUrl}/platform/v1/events?since=0`, { headers: { Cookie: cookie! } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let wire = '';
    try {
      while (!wire.includes('event: snapshot.required')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        wire += decoder.decode(chunk.value, { stream: true });
      }
      expect(wire).toContain(`id: ${latest!.sequence}\nevent: snapshot.required\ndata: {"cursor":${latest!.sequence}}`);
      expect(wire).not.toContain('event: office.event');
    } finally {
      await reader.cancel();
    }
  });

  it('asks stale SSE cursors to reload after retention removes old event history', async () => {
    await projects.createProject({ name: 'Retention gap one', goal: '' });
    await projects.createProject({ name: 'Retention gap two', goal: '' });
    await db.run('UPDATE domain_events SET occurred_at = ?', ['2000-01-01T00:00:00.000Z']);
    const pruned = await new RetentionService(db).prune(new Date('2026-10-25T00:00:00.000Z'));
    expect(pruned.eventsDeleted).toBeGreaterThan(0);
    const latest = await db.one<{ sequence: number }>('SELECT MAX(sequence) AS sequence FROM domain_events WHERE workspace_id = ?', ['local-workspace']);
    expect(latest!.sequence).toBeGreaterThan(1);

    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const response = await fetch(`${baseUrl}/platform/v1/events?since=0`, { headers: { Cookie: cookie! } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let wire = '';
    try {
      while (!wire.includes('event: snapshot.required')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        wire += decoder.decode(chunk.value, { stream: true });
      }
      expect(wire).toContain(`id: ${latest!.sequence}\nevent: snapshot.required\ndata: {"cursor":${latest!.sequence}}`);
      expect(wire).not.toContain('event: office.event');
    } finally {
      await reader.cancel();
    }
  });

  it('closes a backpressured SSE stream and replays durable events after reconnect', async () => {
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    const latest = await db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM domain_events WHERE workspace_id = ?', ['local-workspace']);
    const cursor = latest!.sequence;
    const hub = events as unknown as { listeners: Set<unknown>; transientListeners: Set<unknown> };
    const eventListenerCount = hub.listeners.size;
    const transientListenerCount = hub.transientListeners.size;

    let slowRequest: http.ClientRequest | undefined;
    let slowResponse: http.IncomingMessage | undefined;
    let reconnectRequest: http.ClientRequest | undefined;
    let reconnectResponse: http.IncomingMessage | undefined;
    try {
      slowRequest = http.get(`${baseUrl}/platform/v1/events?since=${cursor}`, { headers: { Cookie: cookie! } }, (response) => {
        slowResponse = response;
        response.pause();
      });
      slowRequest.on('error', () => undefined);
      await vi.waitFor(() => expect(slowResponse).toBeDefined());
      await vi.waitFor(() => expect(hub.transientListeners.size).toBe(transientListenerCount + 1));

      events.transient('task.delta', { runId: 'slow-client', taskId: 'slow-client', delta: 'x'.repeat(256_000) });

      expect(hub.listeners.size).toBe(eventListenerCount);
      expect(hub.transientListeners.size).toBe(transientListenerCount);
      const room = await projects.createProject({ name: 'Reconnect after slow client', goal: '' });
      const replayedEvent = (await events.listSince(cursor)).find((event) => event.type === 'project.created' && event.payload.projectId === room.id);
      expect(replayedEvent).toBeDefined();

      let wire = '';
      const connected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE reconnect did not finish replay.')), 5000);
        reconnectRequest = http.get(`${baseUrl}/platform/v1/events`, {
          headers: { Cookie: cookie!, 'Last-Event-ID': String(cursor) },
        }, (response) => {
          reconnectResponse = response;
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            wire += chunk;
            if (wire.includes('event: connected')) { clearTimeout(timer); resolve(); }
          });
        });
        reconnectRequest.on('error', (error) => { clearTimeout(timer); reject(error); });
      });
      await connected;
      expect(wire).toContain(`id: ${replayedEvent!.sequence}\nevent: office.event`);
      expect(wire).toContain(`"type":"project.created"`);
    } finally {
      slowResponse?.destroy();
      slowRequest?.destroy();
      reconnectResponse?.destroy();
      reconnectRequest?.destroy();
    }
  });

  it('previews registry additions and refuses a no-op reload', async () => {
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const response = await fetch(`${baseUrl}/platform/v1/registry/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken },
      body: '{}',
    });
    const body = await response.json() as { canApply: boolean; blockers: string[]; previewToken?: string };

    expect(response.status).toBe(200);
    expect(body.canApply).toBe(false);
    expect(body.blockers).toContain('Không tìm thấy agent roster mới để nạp.');
    expect(body.previewToken).toBeUndefined();
  });

  it('applies an approved append-only specialist and adds its roster instance live', async () => {
    const definitionDir = join(registryRoot, 'agents', 'definitions');
    await cp(join(definitionDir, 'writer'), join(definitionDir, 'designer'), { recursive: true });
    const definitionPath = join(definitionDir, 'designer', 'agent.yaml');
    const definition = (await readFile(definitionPath, 'utf8'))
      .replace(/^id: writer$/m, 'id: designer')
      .replace(/^version: .+$/m, 'version: 1.0.0')
      .replace(/^displayName: Writer$/m, 'displayName: Designer');
    await writeFile(definitionPath, definition);
    await appendFile(join(registryRoot, 'agents', 'roster.yaml'), '\n  - id: designer-01\n    definition: designer\n    displayName: Designer\n    enabled: true\n    appearanceSeed: 74001\n');

    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };
    const previewResponse = await fetch(`${baseUrl}/platform/v1/registry/preview`, { method: 'POST', headers, body: '{}' });
    const preview = await previewResponse.json() as { canApply: boolean; previewToken: string; addedAgents: Array<{ id: string }> };
    expect(previewResponse.status).toBe(200);
    expect(preview.canApply).toBe(true);
    expect(preview.addedAgents.map((agent) => agent.id)).toEqual(['designer-01']);

    const applyResponse = await fetch(`${baseUrl}/platform/v1/registry/apply`, {
      method: 'POST', headers, body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(applyResponse.status).toBe(200);
    expect(await applyResponse.json()).toMatchObject({ applied: true, addedAgents: [{ id: 'designer-01' }] });
    expect(updateRegistry).toHaveBeenCalledOnce();

    const agents = await fetch(`${baseUrl}/platform/v1/agents`).then((response) => response.json()) as { agents: Array<{ id: string }>; definitions: Array<{ id: string }> };
    expect(agents.definitions.some((definition) => definition.id === 'designer')).toBe(true);
    expect(agents.agents.some((agent) => agent.id === 'designer-01')).toBe(true);
  });

  it('accepts explicit follow-ups, rejects overlapping new runs, and stores run steering without enqueuing a new run', async () => {
    const project = await projects.createProject({ name: 'HTTP queue test', goal: '' });
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    expect(cookie).toBeTruthy();

    const postMessage = (text: string, mode: 'new-run' | 'enqueue' | 'steer', key: string) => fetch(
      `${baseUrl}/platform/v1/conversations/${encodeURIComponent(project.conversationId)}/messages`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, Cookie: cookie!, 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ text, mode }) },
    );

    const firstResponse = await postMessage('First request', 'new-run', 'http-key-0001');
    expect(firstResponse.status).toBe(202);
    const first = await firstResponse.json() as { runId: string };

    const overlap = await postMessage('Parallel request', 'new-run', 'http-key-0002');
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toMatchObject({ error: { code: 'RUN_ALREADY_ACTIVE' } });

    const followUp = await postMessage('Queued follow-up', 'enqueue', 'http-key-0003');
    expect(followUp.status).toBe(202);
    const queued = await followUp.json() as { runId: string };
    expect(enqueue.mock.calls).toEqual([[first.runId], [queued.runId]]);
    const projectView = await fetch(`${baseUrl}/platform/v1/projects/${project.id}`).then((response) => response.json()) as { activeRuns: Array<{ id: string; status: string }> };
    expect(projectView.activeRuns.map((run) => run.id)).toEqual([first.runId, queued.runId]);

    await db.run("UPDATE runs SET status = 'executing' WHERE id = ?", [first.runId]);
    const steer = await postMessage('Steering request', 'steer', 'http-key-0004');
    expect(steer.status).toBe(202);
    const steered = await steer.json() as { runId: string; steeringId: string; sequence: number; message: { id: string; runId: string; content: string } };
    expect(steered).toMatchObject({ runId: first.runId, sequence: 1, message: { runId: first.runId, content: 'Steering request' } });
    expect(await db.one<{ status: string; sequence: number }>('SELECT status, sequence FROM run_steering WHERE id = ?', [steered.steeringId])).toEqual({ status: 'pending', sequence: 1 });
    expect(enqueue.mock.calls).toEqual([[first.runId], [queued.runId]]);

    const retry = await postMessage('Steering request', 'steer', 'http-key-0004');
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ steeringId: steered.steeringId, message: { id: steered.message.id } });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM run_steering WHERE run_id = ?', [first.runId])).toEqual({ count: 1 });

    const version = await db.one<{ version: number }>('SELECT version FROM runs WHERE id = ?', [first.runId]);
    const directHeaders = { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-direct-steer-01', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };
    const directSteer = await fetch(`${baseUrl}/platform/v1/runs/${first.runId}/steer`, {
      method: 'POST', headers: directHeaders, body: JSON.stringify({ text: 'Keep the implementation small', expectedVersion: version!.version }),
    });
    expect(directSteer.status).toBe(202);
    const direct = await directSteer.json() as { steeringId: string; runId: string };
    expect(direct.runId).toBe(first.runId);

    const staleSteer = await fetch(`${baseUrl}/platform/v1/runs/${first.runId}/steer`, {
      method: 'POST', headers: { ...directHeaders, 'Idempotency-Key': 'http-direct-steer-02' },
      body: JSON.stringify({ text: 'Use stale version', expectedVersion: version!.version }),
    });
    expect(staleSteer.status).toBe(409);
    expect(await staleSteer.json()).toMatchObject({ error: { code: 'RUN_VERSION_CONFLICT' } });

    const detailResponse = await fetch(`${baseUrl}/platform/v1/runs/${first.runId}`);
    const detail = await detailResponse.json() as { run: { id: string; version: number }; tasks: unknown[]; budget: { runId: string } | null; artifacts: unknown[] };
    expect(detailResponse.status).toBe(200);
    expect(detail).toMatchObject({ run: { id: first.runId, version: version!.version + 1 }, budget: { runId: first.runId }, artifacts: [] });
  });

  it('returns project token totals and the configured per-run ceiling', async () => {
    const project = await projects.createProject({ name: 'Usage HTTP test', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Create a run budget reservation');
    const registry = await loadRegistry(process.cwd());
    const ledger = new UsageLedger(db, registry.policy.limits.maxTokensPerRun);
    await ledger.reserve({ runId: run.runId, taskId: null, agentInstanceId: project.coordinatorInstanceId, promptTokens: 500, outputTokens: 100 });

    const response = await fetch(`${baseUrl}/platform/v1/usage?projectId=${encodeURIComponent(project.id)}`);
    const body = await response.json() as { usage: unknown[]; budget: { limitTokensPerRun: number; measuredTokens: number; reservedTokens: number; runs: Array<Record<string, unknown>> } };

    expect(response.status).toBe(200);
    expect(body.usage).toEqual([]);
    expect(body.budget).toMatchObject({
      limitTokensPerRun: 120000,
      measuredTokens: 0,
      reservedTokens: 600,
      measuredCostMicrousd: 0,
      reservedCostMicrousd: 0,
      unpricedRequests: 1,
      runs: [{ runId: run.runId, status: 'queued', limitTokens: 120000, measuredTokens: 0, reservedTokens: 600, remainingTokens: 119400, pendingRequests: 1, unknownRequests: 0, moneyBudgetMicrousd: null, measuredCostMicrousd: 0, reservedCostMicrousd: 0, unpricedRequests: 1 }],
    });
  });

  it('validates, stores and redacts supported text attachments on conversation messages', async () => {
    const project = await projects.createProject({ name: 'Attachment HTTP test', goal: '' });
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-attachment-0001', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };
    const content = 'region,total\nNorth,42\n';
    const response = await fetch(`${baseUrl}/platform/v1/conversations/${encodeURIComponent(project.conversationId)}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ text: 'Summarize this CSV.', attachments: [{ name: 'sales.csv', mimeType: 'text/csv', content }] }),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { runId: string; message: { id: string; attachments?: Array<{ id: string; name: string; mimeType: string; sizeBytes: number; checksum: string }> } };
    expect(body.message.attachments).toMatchObject([{ name: 'sales.csv', mimeType: 'text/csv', sizeBytes: Buffer.byteLength(content), checksum: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(await db.one<{ content: string; size_bytes: number }>('SELECT content, size_bytes FROM message_attachments WHERE message_id = ?', [body.message.id])).toEqual({ content, size_bytes: Buffer.byteLength(content) });

    const history = await fetch(`${baseUrl}/platform/v1/conversations/${encodeURIComponent(project.conversationId)}/messages`);
    const historyBody = await history.text();
    expect(historyBody).toContain('sales.csv');
    expect(historyBody).not.toContain(content);
    expect(enqueue).toHaveBeenCalledWith(body.runId);

    const unsupported = await fetch(`${baseUrl}/platform/v1/conversations/${encodeURIComponent(project.conversationId)}/messages`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'http-attachment-0002' },
      body: JSON.stringify({ text: 'Try to upload an executable.', mode: 'enqueue', attachments: [{ name: 'payload.exe', mimeType: 'text/plain', content: 'not executable data' }] }),
    });
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({ error: { code: 'ATTACHMENT_TYPE_UNSUPPORTED' } });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM message_attachments')).toEqual({ count: 1 });
  });

  it('supports project memory CRUD with revision checks and server events', async () => {
    const project = await projects.createProject({ name: 'HTTP memory project', goal: '' });
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };

    const createdResponse = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/memory`, {
      method: 'POST', headers, body: JSON.stringify({ content: 'Keep the user interface in Vietnamese.' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { memory: { id: string; revision: number; status: string } };
    expect(created.memory).toMatchObject({ revision: 1, status: 'accepted' });

    const userMemoryResponse = await fetch(`${baseUrl}/platform/v1/memory`, {
      method: 'POST', headers, body: JSON.stringify({ scopeType: 'user', scopeId: 'local-user', content: 'The user prefers Vietnamese responses.' }),
    });
    expect(userMemoryResponse.status).toBe(201);
    const userMemory = await userMemoryResponse.json() as { memory: { id: string; scopeType: string; scopeId: string; projectId: string | null } };
    expect(userMemory.memory).toMatchObject({ scopeType: 'user', scopeId: 'local-user', projectId: null });

    const agentMemoryResponse = await fetch(`${baseUrl}/platform/v1/memory`, {
      method: 'POST', headers, body: JSON.stringify({ scopeType: 'agent', scopeId: 'writer', content: 'Keep reports concise and sourced.' }),
    });
    expect(agentMemoryResponse.status).toBe(201);
    const agentMemory = await agentMemoryResponse.json() as { memory: { id: string; scopeType: string; scopeId: string; projectId: string | null } };
    expect(agentMemory.memory).toMatchObject({ scopeType: 'agent', scopeId: 'writer', projectId: null });
    const invalidScope = await fetch(`${baseUrl}/platform/v1/memory`, {
      method: 'POST', headers, body: JSON.stringify({ scopeType: 'agent', scopeId: 'not-installed', content: 'Should be rejected.' }),
    });
    expect(invalidScope.status).toBe(404);

    const detail = await fetch(`${baseUrl}/platform/v1/projects/${project.id}`).then((response) => response.json()) as { memory: Array<{ id: string }> };
    expect(detail.memory.map((item) => item.id)).toEqual(expect.arrayContaining([created.memory.id, userMemory.memory.id, agentMemory.memory.id]));
    const secondProject = await projects.createProject({ name: 'Memory isolation project', goal: '' });
    const secondDetail = await fetch(`${baseUrl}/platform/v1/projects/${secondProject.id}`).then((response) => response.json()) as { memory: Array<{ id: string }> };
    expect(secondDetail.memory.map((item) => item.id)).toEqual(expect.arrayContaining([userMemory.memory.id, agentMemory.memory.id]));
    expect(secondDetail.memory.map((item) => item.id)).not.toContain(created.memory.id);

    const updatedAgentMemoryResponse = await fetch(`${baseUrl}/platform/v1/memory/${agentMemory.memory.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: 1, content: 'Keep sourced reports concise.' }),
    });
    expect(updatedAgentMemoryResponse.status).toBe(200);
    expect(await updatedAgentMemoryResponse.json()).toMatchObject({ memory: { scopeType: 'agent', revision: 2 } });

    const updatedResponse = await fetch(`${baseUrl}/platform/v1/memory/${created.memory.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: 1, content: 'Keep the product interface in Vietnamese.' }),
    });
    expect(updatedResponse.status).toBe(200);
    const staleResponse = await fetch(`${baseUrl}/platform/v1/memory/${created.memory.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: 1, content: 'Stale write.' }),
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });

    const run = await projects.createUserMessage(project.id, project.conversationId, 'Implement the agreed language preference.');
    const taskId = randomUUID();
    const now = new Date().toISOString();
    await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
      VALUES (?, ?, 'language', 'specialist', 'Set language', 'Use confirmed language preference', '[]', 'succeeded', ?, ?)`, [taskId, run.runId, now, now]);
    const proposal = await new MemoryService(db, events).proposeProjectMemory({
      projectId: project.id, runId: run.runId, taskId, agentInstanceId: 'writer-01', content: 'The user confirmed Vietnamese as the default language for this project.',
    });
    const decisionResponse = await fetch(`${baseUrl}/platform/v1/memory/${proposal.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: 1, decision: 'accept' }),
    });
    expect(decisionResponse.status).toBe(200);
    expect(await decisionResponse.json()).toMatchObject({ memory: { id: proposal.id, status: 'accepted', revision: 2 } });

    const deletedResponse = await fetch(`${baseUrl}/platform/v1/memory/${created.memory.id}`, {
      method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(deletedResponse.status).toBe(200);
    const afterDelete = await fetch(`${baseUrl}/platform/v1/projects/${project.id}`).then((response) => response.json()) as { memory: unknown[] };
    expect(afterDelete.memory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: proposal.id, status: 'accepted', content: 'The user confirmed Vietnamese as the default language for this project.' }),
      expect.objectContaining({ id: userMemory.memory.id, scopeType: 'user' }),
      expect.objectContaining({ id: agentMemory.memory.id, scopeType: 'agent', revision: 2 }),
    ]));
  });

  it('downloads project memory.md, previews edits, and requires its expected revision to import', async () => {
    const project = await projects.createProject({ name: 'Project memory markdown HTTP', goal: '' });
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };
    const createdResponse = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/memory`, {
      method: 'POST', headers, body: JSON.stringify({ content: 'Keep the HTTP flow version checked.' }),
    });
    expect(createdResponse.status).toBe(201);

    const exportResponse = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/memory.md`);
    const markdown = await exportResponse.text();
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get('content-type')).toContain('text/markdown');
    expect(exportResponse.headers.get('content-disposition')).toContain('memory.md');
    expect(markdown).toContain('Keep the HTTP flow version checked.');

    const edited = markdown.replace('HTTP flow', 'HTTP import flow');
    const previewResponse = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/memory.md/preview`, {
      method: 'POST', headers, body: JSON.stringify({ markdown: edited }),
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { expectedRevision: string; changedCount: number };
    expect(preview.changedCount).toBe(1);

    const missingCsrf = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/memory.md`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: preview.expectedRevision, markdown: edited }),
    });
    expect(missingCsrf.status).toBe(403);

    const imported = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/memory.md`, {
      method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: preview.expectedRevision, markdown: edited }),
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ changedCount: 1, expectedRevision: preview.expectedRevision });
    expect((await fetch(`${baseUrl}/platform/v1/projects/${project.id}/memory`)).status).toBe(200);
    expect(await db.one<{ content: string; revision: number }>('SELECT content, revision FROM memory_records WHERE project_id = ?', [project.id]))
      .toEqual({ content: 'Keep the HTTP import flow version checked.', revision: 2 });

    const stale = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/memory.md`, {
      method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: preview.expectedRevision, markdown: edited }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'MEMORY_MARKDOWN_CONFLICT' } });
  });

  it('serves project-scoped artifact previews with a sandbox and expires a closed token', async () => {
    const project = await projects.createProject({ name: 'Preview project', goal: '' });
    const otherProject = await projects.createProject({ name: 'Other preview project', goal: '' });
    const artifacts = new ArtifactService(db, events, dataDir);
    const htmlArtifact = await artifacts.create({ projectId: project.id, taskId: null, name: 'page.html', mimeType: 'text/html', content: '<h1>Preview</h1><script>window.previewExecuted = true</script>' });
    const textArtifact = await artifacts.create({ projectId: project.id, taskId: null, name: 'report.md', mimeType: 'text/markdown', content: '<script>unsafe text</script>' });
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };

    const denied = await fetch(`${baseUrl}/platform/v1/artifacts/${htmlArtifact.versionId}/preview`, {
      method: 'POST', headers, body: JSON.stringify({ projectId: otherProject.id }),
    });
    expect(denied.status).toBe(404);

    const htmlOpened = await fetch(`${baseUrl}/platform/v1/artifacts/${htmlArtifact.versionId}/preview`, {
      method: 'POST', headers, body: JSON.stringify({ projectId: project.id }),
    });
    const htmlPreview = await htmlOpened.json() as { url: string; expiresAt: string };
    expect(htmlOpened.status).toBe(201);
    expect(Date.parse(htmlPreview.expiresAt)).toBeGreaterThan(Date.now());
    const htmlResponse = await fetch(new URL(htmlPreview.url, baseUrl));
    expect(htmlResponse.headers.get('content-type')).toContain('text/html');
    expect(htmlResponse.headers.get('content-security-policy')).toContain('sandbox');
    expect(htmlResponse.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(htmlResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await htmlResponse.text()).toContain('<script>window.previewExecuted = true</script>');

    const textOpened = await fetch(`${baseUrl}/platform/v1/artifacts/${textArtifact.versionId}/preview`, {
      method: 'POST', headers, body: JSON.stringify({ projectId: project.id }),
    });
    const textPreview = await textOpened.json() as { url: string };
    const textResponse = await fetch(new URL(textPreview.url, baseUrl));
    const textHtml = await textResponse.text();
    expect(textHtml).toContain('&lt;script&gt;unsafe text&lt;/script&gt;');
    expect(textHtml).not.toContain('<script>unsafe text</script>');

    const closed = await fetch(new URL(htmlPreview.url, baseUrl), { method: 'DELETE', headers });
    expect(closed.status).toBe(204);
    expect((await fetch(new URL(htmlPreview.url, baseUrl))).status).toBe(404);
  });

  it('exports and imports a memory archive through the local API', async () => {
    const project = await projects.createProject({ name: 'Memory archive HTTP', goal: '' });
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    const headers = { 'Content-Type': 'application/json', Cookie: cookie!, 'X-CSRF-Token': session.csrfToken };
    const createdResponse = await fetch(`${baseUrl}/platform/v1/projects/${project.id}/memory`, {
      method: 'POST', headers, body: JSON.stringify({ content: 'Keep archive imports scoped to existing projects.' }),
    });
    const created = await createdResponse.json() as { memory: { id: string } };
    expect(createdResponse.status).toBe(201);

    const exportResponse = await fetch(`${baseUrl}/platform/v1/memory/export`);
    const bundle = await exportResponse.json() as { format: string; records: Array<{ id: string; projectId: string }> };
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get('content-disposition')).toContain('agent-office-memory-');
    expect(bundle).toMatchObject({ format: 'agent-office.memory-export', records: [{ id: created.memory.id, projectId: project.id }] });

    await db.batch([
      { mode: 'run', sql: 'DELETE FROM memory_record_revisions WHERE memory_id = ?', params: [created.memory.id] },
      { mode: 'run', sql: 'DELETE FROM memory_records WHERE id = ?', params: [created.memory.id] },
    ], true);
    const importResponse = await fetch(`${baseUrl}/platform/v1/memory/import`, {
      method: 'POST', headers, body: JSON.stringify(bundle),
    });
    expect(importResponse.status).toBe(200);
    expect(await importResponse.json()).toMatchObject({ imported: 1, skipped: 0 });
    const repeatedImport = await fetch(`${baseUrl}/platform/v1/memory/import`, {
      method: 'POST', headers, body: JSON.stringify(bundle),
    });
    expect(await repeatedImport.json()).toMatchObject({ imported: 0, skipped: 1 });
    expect(await db.one<{ content: string }>('SELECT content FROM memory_records WHERE id = ?', [created.memory.id])).toEqual({ content: 'Keep archive imports scoped to existing projects.' });
  });
});

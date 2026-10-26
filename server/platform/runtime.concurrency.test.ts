import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';
import type { ChatMessage } from './models/chat-completions';

interface GatewayResponse { content: string }
interface RuntimeCalls {
  completeModelCall(runId: string, taskId: string | null, agentId: string, profileId: string, input: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<GatewayResponse>;
}

describe('runtime model request concurrency', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  let runtime: AgentRuntime;
  let runId: string;
  let coordinatorId: string;
  let server: ReturnType<typeof createServer> | undefined;
  let restoreEnv: Array<() => void> = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-concurrency-'));
    db = await DatabaseClient.open(dataDir, true);
    registry = await loadRegistry(process.cwd());
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    const project = await projects.createProject({ name: 'Concurrency test', goal: '' });
    runId = (await projects.createUserMessage(project.id, project.conversationId, 'Test request slots')).runId;
    coordinatorId = project.coordinatorInstanceId;
  });

  afterEach(async () => {
    await runtime?.stop();
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    for (const restore of restoreEnv.reverse()) restore();
    restoreEnv = [];
    await db?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('enforces the provider request cap even when workspace capacity is higher', async () => {
    const endpoint = await configureModelServer();
    registry.policy.limits.maxConcurrentModelRequests = 4;
    registry.policy.limits.maxConcurrentRequestsPerProvider = 1;
    runtime = createRuntime(endpoint);
    const calls = runtime as unknown as RuntimeCalls;

    const first = calls.completeModelCall(runId, null, coordinatorId, 'primary', { messages: [{ role: 'user', content: 'first' }] });
    const second = calls.completeModelCall(runId, null, coordinatorId, 'primary', { messages: [{ role: 'user', content: 'second' }] });
    await vi.waitFor(() => expect(serverStats.requests).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(serverStats.requests).toBe(1);
    expect(serverStats.maxConcurrent).toBe(1);

    openModelGate();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(serverStats.requests).toBe(2);
    expect(serverStats.maxConcurrent).toBe(1);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM model_call_reservations WHERE run_id = ? AND status = 'settled'", [runId]))
      .toEqual({ count: 2 });
    const lifecycleEvents = (await events.listSince(0)).filter((event) => event.type === 'agent.lifecycle_hook');
    expect(lifecycleEvents).toHaveLength(4);
    expect(lifecycleEvents.map((event) => event.payload.event).sort()).toEqual(['after_model_call', 'after_model_call', 'before_model_call', 'before_model_call']);
    expect(lifecycleEvents.every((event) => (event.payload.metadata as Record<string, unknown>).profileId === 'primary')).toBe(true);
    expect(JSON.stringify(lifecycleEvents)).not.toContain('first');
    expect(JSON.stringify(lifecycleEvents)).not.toContain('second');
  });

  it('enforces the workspace model request cap across separate provider endpoints', async () => {
    const endpoint = await configureModelServer();
    const coding = registry.profiles.get('coding')!;
    coding.baseUrlEnv = 'MODEL_CODING_BASE_URL';
    coding.apiKeyEnv = 'MODEL_CODING_API_KEY';
    coding.modelEnv = 'MODEL_CODING_NAME';
    setEnv('MODEL_CODING_BASE_URL', `${endpoint}/coding`);
    setEnv('MODEL_CODING_API_KEY', 'test-only-key');
    setEnv('MODEL_CODING_NAME', 'test-only-model');
    registry.policy.limits.maxConcurrentModelRequests = 1;
    registry.policy.limits.maxConcurrentRequestsPerProvider = 4;
    runtime = createRuntime(endpoint);
    const calls = runtime as unknown as RuntimeCalls;

    const first = calls.completeModelCall(runId, null, coordinatorId, 'primary', { messages: [{ role: 'user', content: 'primary provider' }] });
    const second = calls.completeModelCall(runId, null, coordinatorId, 'coding', { messages: [{ role: 'user', content: 'coding provider' }] });
    await vi.waitFor(() => expect(serverStats.requests).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(serverStats.requests).toBe(1);
    expect(serverStats.maxConcurrent).toBe(1);

    openModelGate();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(serverStats.requests).toBe(2);
    expect(serverStats.maxConcurrent).toBe(1);
    expect(serverStats.endpoints.sort()).toEqual(['/v1/chat/completions', '/v1/coding/chat/completions']);
  });

  it('does not borrow the primary provider credentials for an unconfigured specialist profile', async () => {
    const endpoint = await configureModelServer();
    const coding = registry.profiles.get('coding')!;
    coding.baseUrlEnv = 'MODEL_CODING_BASE_URL';
    coding.apiKeyEnv = 'MODEL_CODING_API_KEY';
    coding.modelEnv = 'MODEL_CODING_NAME';
    setEnv('MODEL_CODING_BASE_URL', '');
    setEnv('MODEL_CODING_API_KEY', '');
    setEnv('MODEL_CODING_NAME', '');
    runtime = createRuntime(endpoint);
    const calls = runtime as unknown as RuntimeCalls;

    await expect(calls.completeModelCall(runId, null, coordinatorId, 'coding', { messages: [{ role: 'user', content: 'Do not use the primary profile.' }] }))
      .rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    expect(serverStats.requests).toBe(0);
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM model_call_reservations WHERE run_id = ?', [runId])).toEqual({ count: 0 });
  });

  it('retries a 429 within the attempt limit and keeps usage for every attempt', async () => {
    let requests = 0;
    server = createServer((request, response) => {
      requests++;
      request.resume();
      if (requests === 1) {
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        response.end('{"error":"provider-body-secret"}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end([
        `data: ${JSON.stringify({ id: 'retry-success', choices: [{ delta: { content: 'recovered' }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'retry-success', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    runtime = createRuntime(endpoint);
    const calls = runtime as unknown as RuntimeCalls;

    await expect(calls.completeModelCall(runId, null, coordinatorId, 'primary', { messages: [{ role: 'user', content: 'Retry safely.' }] }))
      .resolves.toMatchObject({ content: 'recovered' });

    expect(requests).toBe(2);
    expect(await db.all<{ status: string }>('SELECT status FROM model_call_reservations WHERE run_id = ? ORDER BY rowid', [runId]))
      .toEqual([{ status: 'unknown' }, { status: 'settled' }]);
    expect(await db.one<{ prompt_tokens: number; completion_tokens: number; total_tokens: number }>('SELECT prompt_tokens, completion_tokens, total_tokens FROM model_usage WHERE run_id = ?', [runId]))
      .toEqual(expect.objectContaining({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }));
    const modelEvents = (await events.listSince(0)).filter((event) => event.type === 'agent.lifecycle_hook' && ['before_model_call', 'after_model_call'].includes(String(event.payload.event)));
    expect(modelEvents).toHaveLength(4);
    expect(modelEvents.filter((event) => event.payload.event === 'after_model_call').map((event) => (event.payload.metadata as Record<string, unknown>).outcome).sort())
      .toEqual(['failed', 'succeeded']);
    expect(JSON.stringify(modelEvents)).not.toContain('provider-body-secret');
  });

  it('does not retry authentication failures and redacts provider response bodies', async () => {
    let requests = 0;
    server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end('{"error":"provider-body-secret"}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    runtime = createRuntime(endpoint);
    const calls = runtime as unknown as RuntimeCalls;

    await expect(calls.completeModelCall(runId, null, coordinatorId, 'primary', { messages: [{ role: 'user', content: 'Do not retry auth.' }] }))
      .rejects.toMatchObject({ code: 'MODEL_HTTP_ERROR', status: 401 });

    expect(requests).toBe(1);
    expect(await db.all<{ status: string }>('SELECT status FROM model_call_reservations WHERE run_id = ? ORDER BY rowid', [runId]))
      .toEqual([{ status: 'unknown' }]);
  });

  it('stops after three attempts for repeated transient provider failures', async () => {
    let requests = 0;
    server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      response.end('{"error":"temporary provider error"}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    runtime = createRuntime(endpoint);
    const calls = runtime as unknown as RuntimeCalls;

    await expect(calls.completeModelCall(runId, null, coordinatorId, 'primary', { messages: [{ role: 'user', content: 'Bound retries.' }] }))
      .rejects.toMatchObject({ code: 'MODEL_HTTP_ERROR', status: 503 });

    expect(requests).toBe(3);
    expect(await db.all<{ status: string }>('SELECT status FROM model_call_reservations WHERE run_id = ? ORDER BY rowid', [runId]))
      .toEqual([{ status: 'unknown' }, { status: 'unknown' }, { status: 'unknown' }]);
  });

  it('releases a failing specialist while an independent agent and the run continue to completion', async () => {
    const now = new Date().toISOString();
    const writerTaskId = randomUUID();
    const researcherTaskId = randomUUID();
    await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
      VALUES (?, ?, 'write', 'specialist', 'Draft a short introduction', 'Write one short project introduction.', '["writing.draft"]', 'ready', ?, ?),
             (?, ?, 'research', 'specialist', 'Find public background', 'Research a supporting public fact.', '["research.search"]', 'ready', ?, ?)`,
    [writerTaskId, runId, now, now, researcherTaskId, runId, now, now]);
    let researchAttempts = 0;
    let writerRequests = 0;
    let summaryRequests = 0;
    const requestToolNames: string[][] = [];
    server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
        const toolNames = payload.tools?.map((tool) => tool.function?.name ?? '(unnamed)') ?? [];
        requestToolNames.push(toolNames);
        if (toolNames.includes('search_web')) {
          researchAttempts++;
          response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
          response.end('{"error":"private-provider-body-sentinel"}');
          return;
        }

        const content = toolNames.includes('create_artifact')
          ? (writerRequests++, 'The Writer completed the project introduction.')
          : (summaryRequests++, 'The project introduction is ready; research failed safely.');
        const chunks = [
          { id: `multi-failure-${requestToolNames.length}`, choices: [{ delta: { content }, finish_reason: null }] },
          { id: `multi-failure-${requestToolNames.length}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 } },
        ];
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    runtime = createRuntime(endpoint);
    runtime.enqueue(runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [runId]))
        .toEqual({ status: 'failed', error_code: 'TASKS_FAILED' });
    }, { timeout: 30_000 });

    expect(researchAttempts).toBe(3);
    expect(writerRequests).toBe(1);
    expect(summaryRequests).toBe(1);
    expect(requestToolNames.some((names) => names.includes('submit_plan'))).toBe(false);
    expect(requestToolNames.some((names) => names.includes('search_web'))).toBe(true);
    expect(await db.all<{ task_key: string; status: string; output: string | null }>('SELECT task_key, status, output FROM tasks WHERE run_id = ? ORDER BY task_key', [runId]))
      .toEqual([
        { task_key: 'research', status: 'failed', output: expect.stringContaining('503') },
        { task_key: 'write', status: 'succeeded', output: 'The Writer completed the project introduction.' },
      ]);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE status IN ('reserved','active','releasing') AND task_id IN (SELECT id FROM tasks WHERE run_id = ?)", [runId]))
      .toEqual({ count: 0 });
    expect(await db.all<{ status: string; count: number }>('SELECT status, COUNT(*) AS count FROM model_call_reservations WHERE run_id = ? GROUP BY status ORDER BY status', [runId]))
      .toEqual([{ status: 'settled', count: 2 }, { status: 'unknown', count: 3 }]);
    const taskOutputs = await db.all<{ output: string | null }>('SELECT output FROM tasks WHERE run_id = ?', [runId]);
    expect(JSON.stringify(taskOutputs)).not.toContain('private-provider-body-sentinel');
  });

  it('keeps a provider failure isolated to its project while another project completes concurrently', async () => {
    const now = new Date().toISOString();
    const independentProject = await projects.createProject({ name: 'Independent project', goal: '' });
    const independentRunId = (await projects.createUserMessage(independentProject.id, independentProject.conversationId, 'Independent project request')).runId;
    const researchTaskId = randomUUID();
    const writerTaskId = randomUUID();
    await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
      VALUES (?, ?, 'research', 'specialist', 'Research project-specific facts', 'Research public facts for the first project.', '["research.search"]', 'ready', ?, ?),
             (?, ?, 'write', 'specialist', 'Draft independent introduction', 'Write an introduction for the second project.', '["writing.draft"]', 'ready', ?, ?)`,
    [researchTaskId, runId, now, now, writerTaskId, independentRunId, now, now]);

    let researchAttempts = 0;
    let writerRequests = 0;
    let researchWaiting = false;
    let concurrentIndependentCalls = false;
    let releasePair!: () => void;
    const pairGate = new Promise<void>((resolve) => { releasePair = resolve; });
    const releasePairWhenBothArrive = () => {
      if (researchWaiting && writerRequests > 0) {
        concurrentIndependentCalls = true;
        releasePair();
      }
    };
    const requestToolNames: string[][] = [];
    server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
        const toolNames = payload.tools?.map((tool) => tool.function?.name ?? '(unnamed)') ?? [];
        requestToolNames.push(toolNames);

        if (toolNames.includes('search_web')) {
          researchAttempts++;
          researchWaiting = true;
          releasePairWhenBothArrive();
          void pairGate.then(() => {
            response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
            response.end('{"error":"isolated-provider-failure-sentinel"}');
          });
          return;
        }

        if (toolNames.includes('create_artifact')) {
          writerRequests++;
          releasePairWhenBothArrive();
        }
        const content = toolNames.includes('create_artifact')
          ? 'The second project was completed independently.'
          : 'This project is complete; a different project encountered a provider error.';
        const chunks = [
          { id: `cross-project-${requestToolNames.length}`, choices: [{ delta: { content }, finish_reason: null }] },
          { id: `cross-project-${requestToolNames.length}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } },
        ];
        const sendResponse = () => {
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
        };
        if (toolNames.includes('create_artifact')) void pairGate.then(sendResponse);
        else sendResponse();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    runtime = createRuntime(endpoint);
    runtime.enqueue(runId);
    runtime.enqueue(independentRunId);

    await vi.waitFor(async () => {
      expect(await db.all<{ id: string; status: string }>('SELECT id, status FROM runs WHERE id IN (?, ?) ORDER BY id', [runId, independentRunId]))
        .toEqual(expect.arrayContaining([
          { id: runId, status: 'failed' },
          { id: independentRunId, status: 'succeeded' },
        ]));
    }, { timeout: 30_000 });

    expect(concurrentIndependentCalls).toBe(true);
    expect(researchAttempts).toBe(3);
    expect(writerRequests).toBe(1);
    expect(await db.one<{ status: string; output: string | null }>('SELECT status, output FROM tasks WHERE id = ?', [researchTaskId]))
      .toEqual({ status: 'failed', output: expect.stringContaining('503') });
    expect(await db.one<{ status: string; output: string | null }>('SELECT status, output FROM tasks WHERE id = ?', [writerTaskId]))
      .toEqual({ status: 'succeeded', output: 'The second project was completed independently.' });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE status IN ('reserved','active','releasing') AND task_id IN (?, ?)", [researchTaskId, writerTaskId]))
      .toEqual({ count: 0 });
    expect(await db.all<{ run_id: string; status: string; count: number }>('SELECT run_id, status, COUNT(*) AS count FROM model_call_reservations WHERE run_id IN (?, ?) GROUP BY run_id, status ORDER BY run_id, status', [runId, independentRunId]))
      .toEqual(expect.arrayContaining([
        { run_id: runId, status: 'unknown', count: 3 },
        { run_id: independentRunId, status: 'settled', count: 2 },
      ]));
    expect(JSON.stringify(await db.all<{ output: string | null }>('SELECT output FROM tasks WHERE id IN (?, ?)', [researchTaskId, writerTaskId])))
      .not.toContain('isolated-provider-failure-sentinel');
  });

  it('sustains queued multi-project provider failures without leaking leases, usage, or response bodies', async () => {
    const now = new Date().toISOString();
    const workload: Array<{ runId: string; researchTaskId: string; writerTaskId: string }> = [{
      runId,
      researchTaskId: randomUUID(),
      writerTaskId: randomUUID(),
    }];

    for (let index = 1; index < 6; index++) {
      const project = await projects.createProject({ name: `Stress project ${index}`, goal: '' });
      const nextRunId = (await projects.createUserMessage(project.id, project.conversationId, `Stress request ${index}`)).runId;
      workload.push({ runId: nextRunId, researchTaskId: randomUUID(), writerTaskId: randomUUID() });
    }

    for (const [index, item] of workload.entries()) {
      await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
        VALUES (?, ?, 'research', 'specialist', 'Research public facts', ?, '["research.search"]', 'ready', ?, ?),
               (?, ?, 'write', 'specialist', 'Write an independent draft', ?, '["writing.draft"]', 'ready', ?, ?)`,
      [
        item.researchTaskId, item.runId, `Research a public fact for stress project ${index}.`, now, now,
        item.writerTaskId, item.runId, `Write an independent result for stress project ${index}.`, now, now,
      ]);
    }

    registry.policy.limits.maxRunningExecutions = 8;
    registry.policy.limits.maxSpecialistExecutions = 12;
    registry.policy.limits.maxConcurrentModelRequests = 4;
    registry.policy.limits.maxConcurrentRequestsPerProvider = 4;

    let requests = 0;
    let inFlight = 0;
    let maxConcurrent = 0;
    let researchAttempts = 0;
    let writerRequests = 0;
    let summaryRequests = 0;
    const requestToolNames: string[][] = [];
    const providerBodySentinel = 'stress-provider-body-secret';
    server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
        const toolNames = payload.tools?.map((tool) => tool.function?.name ?? '(unnamed)') ?? [];
        requestToolNames.push(toolNames);
        requests++;
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);

        let released = false;
        const releaseRequest = () => {
          if (released) return;
          released = true;
          inFlight--;
        };
        response.once('close', releaseRequest);

        const researchFailed = toolNames.includes('search_web');
        if (researchFailed) researchAttempts++;
        else if (toolNames.includes('create_artifact')) writerRequests++;
        else summaryRequests++;

        setTimeout(() => {
          if (researchFailed) {
            response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
            response.end(JSON.stringify({ error: providerBodySentinel }), releaseRequest);
            return;
          }

          const content = toolNames.includes('create_artifact')
            ? 'Writer completed an independent stress draft.'
            : 'The stress project was summarized; its Researcher failed safely.';
          const chunks = [
            { id: `stress-${requests}`, choices: [{ delta: { content }, finish_reason: null }] },
            { id: `stress-${requests}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
          ];
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, releaseRequest);
        }, 5);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    runtime = createRuntime(endpoint);
    for (const item of workload) runtime.enqueue(item.runId);

    const runPlaceholders = workload.map(() => '?').join(', ');
    await vi.waitFor(async () => {
      expect(await db.one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runs WHERE id IN (${runPlaceholders}) AND status = 'failed'`,
        workload.map((item) => item.runId),
      )).toEqual({ count: workload.length });
    }, { timeout: 60_000 });

    expect(requests).toBe(30);
    expect(researchAttempts).toBe(18);
    expect(writerRequests).toBe(6);
    expect(summaryRequests).toBe(6);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
    expect(requestToolNames.some((names) => names.includes('submit_plan'))).toBe(false);

    for (const item of workload) {
      expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [item.runId]))
        .toEqual({ status: 'failed', error_code: 'TASKS_FAILED' });
      expect(await db.one<{ status: string; output: string | null }>('SELECT status, output FROM tasks WHERE id = ?', [item.researchTaskId]))
        .toEqual({ status: 'failed', output: expect.stringContaining('503') });
      expect(await db.one<{ status: string; output: string | null }>('SELECT status, output FROM tasks WHERE id = ?', [item.writerTaskId]))
        .toEqual({ status: 'succeeded', output: 'Writer completed an independent stress draft.' });
      expect(await db.all<{ status: string; count: number }>(
        'SELECT status, COUNT(*) AS count FROM model_call_reservations WHERE run_id = ? GROUP BY status ORDER BY status',
        [item.runId],
      )).toEqual([{ status: 'settled', count: 2 }, { status: 'unknown', count: 3 }]);
      expect(await db.one<{ prompt_tokens: number; completion_tokens: number; total_tokens: number }>(
        'SELECT SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens, SUM(total_tokens) AS total_tokens FROM model_usage WHERE run_id = ?',
        [item.runId],
      )).toEqual({ prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 });
    }

    const taskIds = workload.flatMap((item) => [item.researchTaskId, item.writerTaskId]);
    const activeAssignments = await db.one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM assignments WHERE status IN ('reserved','active','releasing') AND task_id IN (${taskIds.map(() => '?').join(', ')})`,
      taskIds,
    );
    expect(activeAssignments).toEqual({ count: 0 });
    const persistedOutputs = await db.all<{ output: string | null }>(
      `SELECT output FROM tasks WHERE id IN (${taskIds.map(() => '?').join(', ')})`,
      taskIds,
    );
    expect(JSON.stringify(persistedOutputs)).not.toContain(providerBodySentinel);
    expect(JSON.stringify(await events.listSince(0))).not.toContain(providerBodySentinel);
  });

  it('does not let retries exceed the run token budget', async () => {
    let requests = 0;
    server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      response.end('{}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    await db.run('UPDATE runs SET token_budget = 5000 WHERE id = ?', [runId]);
    runtime = createRuntime(endpoint);
    const calls = runtime as unknown as RuntimeCalls;

    await expect(calls.completeModelCall(runId, null, coordinatorId, 'primary', { messages: [{ role: 'user', content: 'Stay within budget.' }] }))
      .rejects.toMatchObject({ code: 'RUN_TOKEN_BUDGET_EXCEEDED' });

    expect(requests).toBe(1);
    expect(await db.all<{ status: string }>('SELECT status FROM model_call_reservations WHERE run_id = ? ORDER BY rowid', [runId]))
      .toEqual([{ status: 'unknown' }]);
  });

  it('honors cancellation while waiting before a scheduled retry', async () => {
    let requests = 0;
    server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      response.end('{}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    runtime = createRuntime(endpoint);
    const calls = runtime as unknown as RuntimeCalls;
    const controller = new AbortController();

    const pending = calls.completeModelCall(runId, null, coordinatorId, 'primary', { messages: [{ role: 'user', content: 'Cancel retry wait.' }], signal: controller.signal });
    await vi.waitFor(() => expect(requests).toBe(1));
    controller.abort();

    await expect(pending).rejects.toThrow('Run cancelled.');
    expect(requests).toBe(1);
    expect(await db.all<{ status: string }>('SELECT status FROM model_call_reservations WHERE run_id = ? ORDER BY rowid', [runId]))
      .toEqual([{ status: 'unknown' }]);
  });

  it('stops an in-flight model request and releases run, queue, and network resources on shutdown', async () => {
    let requests = 0;
    let closedResponses = 0;
    server = createServer((request, response) => {
      requests++;
      request.resume();
      response.on('close', () => { closedResponses++; });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    runtime = createRuntime(endpoint);
    runtime.enqueue(runId);
    await vi.waitFor(() => expect(requests).toBe(1));

    await runtime.stop();

    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [runId]))
      .toEqual({ status: 'interrupted', error_code: 'SERVER_SHUTDOWN' });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM model_call_reservations WHERE run_id = ? AND status = 'in_flight'", [runId]))
      .toEqual({ count: 0 });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE status IN ('reserved','active','releasing') AND task_id IN (SELECT id FROM tasks WHERE run_id = ?)", [runId]))
      .toEqual({ count: 0 });
    expect((runtime as unknown as { activeRuns: Set<string>; controllers: Map<string, AbortController>; runExecutions: Map<string, Promise<void>> }).activeRuns.size).toBe(0);
    expect((runtime as unknown as { activeRuns: Set<string>; controllers: Map<string, AbortController>; runExecutions: Map<string, Promise<void>> }).controllers.size).toBe(0);
    expect((runtime as unknown as { activeRuns: Set<string>; controllers: Map<string, AbortController>; runExecutions: Map<string, Promise<void>> }).runExecutions.size).toBe(0);
    await vi.waitFor(() => expect(closedResponses).toBe(1));
  });

  it('blocks a USD-budgeted run before dispatch when the configured model has no matching price', async () => {
    const endpoint = await configureModelServer();
    await db.run('UPDATE runs SET money_budget_microusd = 1000000 WHERE id = ?', [runId]);
    registry.profiles.get('primary')!.pricing = {
      modelName: 'different-model', version: 'owner-price-v1', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2,
    };
    runtime = createRuntime(endpoint);
    const calls = runtime as unknown as RuntimeCalls;

    await expect(calls.completeModelCall(runId, null, coordinatorId, 'primary', { messages: [{ role: 'user', content: 'Do not send an unpriced request.' }] }))
      .rejects.toMatchObject({ code: 'MODEL_PRICING_REQUIRED' });

    expect(serverStats.requests).toBe(0);
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM model_call_reservations WHERE run_id = ?', [runId])).toEqual({ count: 0 });
  });

  const serverStats = { requests: 0, active: 0, maxConcurrent: 0, endpoints: [] as string[] };
  let openModelGate: () => void = () => {};

  async function configureModelServer(): Promise<string> {
    serverStats.requests = 0;
    serverStats.active = 0;
    serverStats.maxConcurrent = 0;
    serverStats.endpoints = [];
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    openModelGate = resolveGate;
    server = createServer((request, response) => {
      request.resume();
      serverStats.requests++;
      serverStats.active++;
      serverStats.maxConcurrent = Math.max(serverStats.maxConcurrent, serverStats.active);
      serverStats.endpoints.push(new URL(request.url ?? '/', 'http://localhost').pathname);
      void gate.then(() => {
        const chunks = [
          { id: 'mock-concurrency', choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
          { id: 'mock-concurrency', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        ];
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, () => { serverStats.active--; });
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    setEnv('MODEL_PRIMARY_BASE_URL', endpoint);
    setEnv('MODEL_PRIMARY_API_KEY', 'test-only-key');
    setEnv('MODEL_PRIMARY_NAME', 'test-only-model');
    return endpoint;
  }

  function createRuntime(endpoint: string): AgentRuntime {
    return new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir,
      MODEL_PRIMARY_BASE_URL: endpoint,
      MODEL_PRIMARY_API_KEY: 'test-only-key',
      MODEL_PRIMARY_NAME: 'test-only-model',
      MODEL_CODING_BASE_URL: process.env.MODEL_CODING_BASE_URL,
      MODEL_CODING_API_KEY: process.env.MODEL_CODING_API_KEY,
      MODEL_CODING_NAME: process.env.MODEL_CODING_NAME,
    }));
  }

  function setEnv(name: string, value: string): void {
    const previous = process.env[name];
    restoreEnv.push(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    process.env[name] = value;
  }
});

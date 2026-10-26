import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';

describe('hard process termination after durable tool dispatch', () => {
  let dataDir: string;
  let workspaceRoot: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  let runtime: AgentRuntime | undefined;
  let fakeModel: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-dispatch-crash-'));
    workspaceRoot = join(dataDir, 'workspace');
    await mkdir(workspaceRoot);
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    registry = await loadRegistry(process.cwd());
    projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
  });

  afterEach(async () => {
    await runtime?.stop().catch(() => undefined);
    if (fakeModel?.listening) {
      fakeModel.closeAllConnections();
      await new Promise<void>((resolve, reject) => fakeModel!.close((error) => error ? reject(error) : resolve()));
    }
    await db?.close().catch(() => undefined);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('resumes a committed Coordinator plan after a hard process kill without duplicating tasks', async () => {
    const project = await projects.createProject({ name: 'Coordinator plan crash', goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Write a short introduction for this project.');
    const markerPath = join(dataDir, 'plan-commit-marker.json');
    const requestToolNames: string[][] = [];
    let requestCount = 0;
    fakeModel = createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { raw += chunk; });
      incoming.on('end', () => {
        requestCount++;
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
        const toolNames = payload.tools?.map((tool) => tool.function?.name ?? '(unnamed)') ?? [];
        requestToolNames.push(toolNames);
        let chunks: Array<Record<string, unknown>>;
        if (toolNames.includes('submit_plan')) {
          const plan = {
            goal: 'Write a concise introduction.',
            successCriteria: ['The Writer drafts one short introduction.'],
            tasks: [{ key: 'intro', title: 'Draft project introduction', objective: 'Write a short introduction for the project.', capability: 'writing.draft', dependsOn: [] }],
          };
          chunks = [
            { id: 'plan-crash-coordinator', choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit-plan-before-crash', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }] },
            { id: 'plan-crash-coordinator', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 14, completion_tokens: 20, total_tokens: 34 } },
          ];
        } else {
          const text = toolNames.length
            ? 'The Writer completed the project introduction.'
            : 'The project introduction is ready.';
          chunks = [
            { id: `plan-crash-follow-up-${requestCount}`, choices: [{ delta: { content: text }, finish_reason: null }] },
            { id: `plan-crash-follow-up-${requestCount}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
          ];
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel!.once('error', reject);
      fakeModel!.listen(0, '127.0.0.1', resolve);
    });
    const address = fakeModel.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await db.close();

    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./coordinator-plan-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl, markerPath,
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const childExit = new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code }));
    });
    let killed = false;
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try { await access(markerPath); break; } catch { /* marker is written only after the plan transaction commits */ }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Coordinator runtime exited before plan commit: ${output}`);
        await delay(20);
      }
      await expect(access(markerPath)).resolves.toBeUndefined();
      expect(requestCount).toBe(1);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        expect(await observer.one<{ status: string; plan_revision: number }>('SELECT status, plan_revision FROM runs WHERE id = ?', [request.runId]))
          .toEqual({ status: 'executing', plan_revision: 1 });
        expect(await observer.all<{ task_key: string; status: string }>('SELECT task_key, status FROM tasks WHERE run_id = ?', [request.runId]))
          .toEqual([{ task_key: 'intro', status: 'ready' }]);
        expect(await observer.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'run.plan_revised' AND aggregate_id = ?", [request.runId]))
          .toEqual({ count: 1 });
        expect(await observer.one<{ count: number }>('SELECT COUNT(*) AS count FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)', [request.runId]))
          .toEqual({ count: 0 });
      } finally {
        await observer.close();
      }
      expect(child.kill('SIGKILL')).toBe(true);
      killed = true;
      const exit = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error('Coordinator runtime did not exit after SIGKILL.'); }),
      ]);
      expect(exit.code).not.toBe(0);
    } finally {
      if (!killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (!killed) await Promise.race([childExit.catch(() => undefined), delay(5_000)]);
    }

    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir,
      OFFICE_CONFIG_DIR: process.cwd(),
      OFFICE_EXECUTION_MODE: 'disabled',
      MODEL_PRIMARY_BASE_URL: baseUrl,
      MODEL_PRIMARY_API_KEY: 'plan-crash-test-key',
      MODEL_PRIMARY_NAME: 'plan-crash-test-model',
    }));
    await runtime.recover();

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
        .toEqual({ status: 'succeeded', error_code: null });
      expect(await db.all<{ task_key: string; status: string; output: string | null }>('SELECT task_key, status, output FROM tasks WHERE run_id = ?', [request.runId]))
        .toMatchObject([{ task_key: 'intro', status: 'succeeded', output: 'The Writer completed the project introduction.' }]);
    }, { timeout: 25_000 });

    expect(requestCount).toBe(3);
    expect(requestToolNames[0]).toContain('submit_plan');
    expect(requestToolNames.slice(1).some((names) => names.includes('submit_plan'))).toBe(false);
    expect(await db.one<{ plan_revision: number }>('SELECT plan_revision FROM runs WHERE id = ?', [request.runId])).toEqual({ plan_revision: 1 });
    expect(await db.all<{ task_key: string; count: number }>('SELECT task_key, COUNT(*) AS count FROM tasks WHERE run_id = ? GROUP BY task_key', [request.runId]))
      .toEqual([{ task_key: 'intro', count: 1 }]);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'run.plan_revised' AND aggregate_id = ?", [request.runId]))
      .toEqual({ count: 1 });
    expect(await db.one<{ settled: number; unknown: number }>(`SELECT
      SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END) AS settled,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown
      FROM model_call_reservations WHERE run_id = ?`, [request.runId]))
      .toEqual({ settled: 3, unknown: 0 });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?) AND status IN ('reserved','active','releasing')", [request.runId]))
      .toEqual({ count: 0 });
  }, 60_000);

  it('quarantines a dispatched public-page fetch after a hard process kill without retrying the network call', async () => {
    const project = await projects.createProject({ name: 'Research fetch crash', goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Fetch and summarize the example page.');
    let requestCount = 0;
    fakeModel = createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { raw += chunk; });
      incoming.on('end', () => {
        requestCount++;
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
        const toolNames = payload.tools?.map((tool) => tool.function?.name ?? '(unnamed)') ?? [];
        let chunks: Array<Record<string, unknown>>;
        if (toolNames.includes('submit_plan')) {
          const plan = {
            goal: 'Fetch a public page and summarize its content.',
            successCriteria: ['The Researcher fetches the requested page and reports its content.'],
            tasks: [{ key: 'fetch-page', title: 'Fetch the example page', objective: 'Fetch https://example.com/ and summarize the result.', capability: 'research.search', dependsOn: [] }],
          };
          chunks = [
            { id: 'fetch-crash-coordinator', choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit-fetch-crash-plan', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }] },
            { id: 'fetch-crash-coordinator', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 } },
          ];
        } else if (toolNames.includes('fetch_web_page')) {
          chunks = [
            { id: 'fetch-crash-researcher', choices: [{ delta: { tool_calls: [{ index: 0, id: 'fetch-example-before-crash', type: 'function', function: { name: 'fetch_web_page', arguments: JSON.stringify({ url: 'https://example.com/' }) } }] }, finish_reason: null }] },
            { id: 'fetch-crash-researcher', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 } },
          ];
        } else {
          response.writeHead(500).end('Unexpected model request.');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel!.once('error', reject);
      fakeModel!.listen(0, '127.0.0.1', resolve);
    });
    const address = fakeModel.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await db.close();

    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./dispatch-tool-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl, 'after-dispatch',
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const childExit = new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code }));
    });
    let killed = false;
    try {
      await Promise.race([
        vi.waitFor(() => expect(output).toContain('TOOL_DISPATCH_COMMITTED'), { timeout: 20_000 }),
        childExit.then(({ code }) => { throw new Error(`Research runtime exited before dispatch commit (code ${code}): ${output}`); }),
      ]);
      expect(requestCount).toBe(2);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        const operation = await observer.one<{ id: string; task_id: string; status: string; tool_id: string }>(
          'SELECT id, task_id, status, tool_id FROM tool_operations WHERE run_id = ?', [request.runId],
        );
        expect(operation).toMatchObject({ status: 'dispatched', tool_id: 'research.fetch' });
        const latest = await observer.one<{ state_json: string }>(
          'SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [operation!.task_id],
        );
        const checkpoint = JSON.parse(latest!.state_json) as { pendingToolCalls: Array<{ operationId: string; toolCallId: string; toolName: string }> };
        expect(checkpoint.pendingToolCalls).toEqual([{ operationId: operation!.id, toolCallId: 'fetch-example-before-crash', toolName: 'research.fetch' }]);
      } finally {
        await observer.close();
      }
      expect(child.kill('SIGKILL')).toBe(true);
      killed = true;
      const exit = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error('Research runtime did not exit after SIGKILL.'); }),
      ]);
      expect(exit.code).not.toBe(0);
    } finally {
      if (!killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (!killed) await Promise.race([childExit.catch(() => undefined), delay(5_000)]);
    }

    fakeModel.closeAllConnections();
    await new Promise<void>((resolve, reject) => fakeModel!.close((error) => error ? reject(error) : resolve()));
    fakeModel = undefined;
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'disabled',
    }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    await runtime.recover();

    expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
      .toEqual({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
    expect(await db.one<{ status: string; tool_id: string }>('SELECT status, tool_id FROM tool_operations WHERE run_id = ?', [request.runId]))
      .toEqual({ status: 'outcome_unknown', tool_id: 'research.fetch' });
    expect(await db.one<{ status: string }>('SELECT status FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ status: 'failed' });
    expect(await db.one<{ status: string }>('SELECT status FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)', [request.runId]))
      .toEqual({ status: 'released' });
    await runtime.recover();
    expect(requestCount).toBe(2);
  }, 45_000);

  it.each([
    {
      toolId: 'workspace.read', toolName: 'read_workspace_file', toolCallId: 'read-file-before-crash',
      toolArguments: { path: 'facts.txt' }, postCrashPath: 'facts.txt', postCrashContent: 'changed after interrupted read',
      capability: 'code.explain', userMessage: 'Read facts.txt and report its contents.',
    },
    {
      toolId: 'workspace.list', toolName: 'list_workspace_files', toolCallId: 'list-files-before-crash',
      toolArguments: { path: '' }, postCrashPath: 'late.txt', postCrashContent: 'created after interrupted list',
      capability: 'code.explain', userMessage: 'List the files in the workspace.',
    },
    {
      toolId: 'analysis.csv_summary', toolName: 'summarize_csv', toolCallId: 'summarize-csv-before-crash',
      toolArguments: { csvContent: 'name,score\nA,0\nB,8\n' }, postCrashPath: 'facts.txt', postCrashContent: 'changed after interrupted csv summary',
      capability: 'data.analyze', userMessage: 'Summarize the provided score CSV.',
    },
    {
      toolId: 'memory.search', toolName: 'search_accessible_memory', toolCallId: 'search-memory-before-crash',
      toolArguments: { query: 'recovery decision', maxResults: 3 }, postCrashPath: 'facts.txt', postCrashContent: 'changed after interrupted memory search',
      capability: 'data.explain', userMessage: 'Search accessible memory for the recovery decision.',
    },
  ] as const)('quarantines dispatched $toolId after a hard process kill without replaying the tool call', async (scenario) => {
    const project = await projects.createProject({ name: `Workspace ${scenario.toolId} crash`, goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, scenario.userMessage);
    const filePath = join(workspaceRoot, 'facts.txt');
    await writeFile(filePath, 'original facts', 'utf8');
    let requestCount = 0;
    fakeModel = createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { raw += chunk; });
      incoming.on('end', () => {
        requestCount++;
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
        const toolNames = payload.tools?.map((tool) => tool.function?.name ?? '(unnamed)') ?? [];
        let chunks: Array<Record<string, unknown>>;
        if (toolNames.includes('submit_plan')) {
          const plan = {
            goal: 'Inspect the workspace and report the requested information.',
            successCriteria: ['The Developer reports only the workspace information it actually observed.'],
            tasks: [{ key: 'inspect-workspace', title: `Use ${scenario.toolId}`, objective: scenario.userMessage, capability: scenario.capability, dependsOn: [] }],
          };
          chunks = [
            { id: 'read-crash-coordinator', choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit-read-crash-plan', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }] },
            { id: 'read-crash-coordinator', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 13, completion_tokens: 15, total_tokens: 28 } },
          ];
        } else if (toolNames.includes(scenario.toolName)) {
          chunks = [
            { id: 'read-crash-developer', choices: [{ delta: { tool_calls: [{ index: 0, id: scenario.toolCallId, type: 'function', function: { name: scenario.toolName, arguments: JSON.stringify(scenario.toolArguments) } }] }, finish_reason: null }] },
            { id: 'read-crash-developer', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24 } },
          ];
        } else {
          response.writeHead(500).end('Unexpected model request.');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel!.once('error', reject);
      fakeModel!.listen(0, '127.0.0.1', resolve);
    });
    const address = fakeModel.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await db.close();

    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./dispatch-tool-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl, 'after-dispatch',
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const childExit = new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code }));
    });
    let killed = false;
    try {
      await Promise.race([
        vi.waitFor(() => expect(output).toContain('TOOL_DISPATCH_COMMITTED'), { timeout: 20_000 }),
        childExit.then(({ code }) => { throw new Error(`${scenario.toolId} runtime exited before dispatch commit (code ${code}): ${output}`); }),
      ]);
      expect(requestCount).toBe(2);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        const operation = await observer.one<{ id: string; task_id: string; status: string; tool_id: string }>(
          'SELECT id, task_id, status, tool_id FROM tool_operations WHERE run_id = ?', [request.runId],
        );
        expect(operation).toMatchObject({ status: 'dispatched', tool_id: scenario.toolId });
        const checkpoint = await observer.one<{ state_json: string }>(
          'SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [operation!.task_id],
        );
        expect(JSON.parse(checkpoint!.state_json)).toMatchObject({
          pendingToolCalls: [{ operationId: operation!.id, toolCallId: scenario.toolCallId, toolName: scenario.toolId }],
        });
      } finally {
        await observer.close();
      }
      expect(child.kill('SIGKILL')).toBe(true);
      killed = true;
      const exit = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error(`${scenario.toolId} runtime did not exit after SIGKILL.`); }),
      ]);
      expect(exit.code).not.toBe(0);
    } finally {
      if (!killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (!killed) await Promise.race([childExit.catch(() => undefined), delay(5_000)]);
    }

    fakeModel.closeAllConnections();
    await new Promise<void>((resolve, reject) => fakeModel!.close((error) => error ? reject(error) : resolve()));
    fakeModel = undefined;
    await writeFile(join(workspaceRoot, scenario.postCrashPath), scenario.postCrashContent, 'utf8');
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'disabled',
    }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    await runtime.recover();

    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
      .toEqual({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
    expect(await db.one<{ status: string; tool_id: string }>('SELECT status, tool_id FROM tool_operations WHERE run_id = ?', [request.runId]))
      .toEqual({ status: 'outcome_unknown', tool_id: scenario.toolId });
    expect(await db.one<{ status: string }>('SELECT status FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ status: 'failed' });
    expect(await db.one<{ status: string }>('SELECT status FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)', [request.runId]))
      .toEqual({ status: 'released' });
    expect(await readFile(join(workspaceRoot, scenario.postCrashPath), 'utf8')).toBe(scenario.postCrashContent);
    await runtime.recover();
    expect(requestCount).toBe(2);
  }, 45_000);

  it('quarantines a dispatched public search after a hard process kill without making another network request', async () => {
    const project = await projects.createProject({ name: 'Research search crash', goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Search for the official Node.js documentation.');
    let requestCount = 0;
    fakeModel = createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { raw += chunk; });
      incoming.on('end', () => {
        requestCount++;
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
        const toolNames = payload.tools?.map((tool) => tool.function?.name ?? '(unnamed)') ?? [];
        let chunks: Array<Record<string, unknown>>;
        if (toolNames.includes('submit_plan')) {
          const plan = {
            goal: 'Find the official Node.js documentation.',
            successCriteria: ['The Researcher reports results from the public search tool.'],
            tasks: [{ key: 'search-docs', title: 'Search official docs', objective: 'Search for official Node.js documentation.', capability: 'research.search', dependsOn: [] }],
          };
          chunks = [
            { id: 'search-crash-coordinator', choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit-search-crash-plan', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }] },
            { id: 'search-crash-coordinator', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 15, completion_tokens: 14, total_tokens: 29 } },
          ];
        } else if (toolNames.includes('search_web')) {
          chunks = [
            { id: 'search-crash-researcher', choices: [{ delta: { tool_calls: [{ index: 0, id: 'search-before-crash', type: 'function', function: { name: 'search_web', arguments: JSON.stringify({ query: 'official Node.js documentation' }) } }] }, finish_reason: null }] },
            { id: 'search-crash-researcher', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 } },
          ];
        } else {
          response.writeHead(500).end('Unexpected model request.');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel!.once('error', reject);
      fakeModel!.listen(0, '127.0.0.1', resolve);
    });
    const address = fakeModel.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await db.close();

    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./dispatch-tool-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl, 'after-dispatch',
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const childExit = new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code }));
    });
    let killed = false;
    try {
      await Promise.race([
        vi.waitFor(() => expect(output).toContain('TOOL_DISPATCH_COMMITTED'), { timeout: 20_000 }),
        childExit.then(({ code }) => { throw new Error(`Research-search runtime exited before dispatch commit (code ${code}): ${output}`); }),
      ]);
      expect(requestCount).toBe(2);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        const operation = await observer.one<{ id: string; task_id: string; status: string; tool_id: string }>(
          'SELECT id, task_id, status, tool_id FROM tool_operations WHERE run_id = ?', [request.runId],
        );
        expect(operation).toMatchObject({ status: 'dispatched', tool_id: 'research.search' });
        const checkpoint = await observer.one<{ state_json: string }>(
          'SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [operation!.task_id],
        );
        expect(JSON.parse(checkpoint!.state_json)).toMatchObject({
          pendingToolCalls: [{ operationId: operation!.id, toolCallId: 'search-before-crash', toolName: 'research.search' }],
        });
      } finally {
        await observer.close();
      }
      expect(child.kill('SIGKILL')).toBe(true);
      killed = true;
      const exit = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error('Research-search runtime did not exit after SIGKILL.'); }),
      ]);
      expect(exit.code).not.toBe(0);
    } finally {
      if (!killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (!killed) await Promise.race([childExit.catch(() => undefined), delay(5_000)]);
    }

    fakeModel.closeAllConnections();
    await new Promise<void>((resolve, reject) => fakeModel!.close((error) => error ? reject(error) : resolve()));
    fakeModel = undefined;
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'disabled',
    }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    let recoveryNetworkCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
      recoveryNetworkCalls++;
      throw new Error('Unexpected external fetch during recovery.');
    }) as typeof fetch;
    try {
      await runtime.recover();
      await runtime.recover();
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
      .toEqual({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
    expect(await db.one<{ status: string; tool_id: string }>('SELECT status, tool_id FROM tool_operations WHERE run_id = ?', [request.runId]))
      .toEqual({ status: 'outcome_unknown', tool_id: 'research.search' });
    expect(await db.one<{ status: string }>('SELECT status FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ status: 'failed' });
    expect(await db.one<{ status: string }>('SELECT status FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)', [request.runId]))
      .toEqual({ status: 'released' });
    expect(recoveryNetworkCalls).toBe(0);
    expect(requestCount).toBe(2);
  }, 45_000);

  it.each([
    { crashPhase: 'after-dispatch', marker: 'TOOL_DISPATCH_COMMITTED', expectedMemoryRecords: 0 },
    { crashPhase: 'after-effect', marker: 'TOOL_EFFECT_BEFORE_RECEIPT', expectedMemoryRecords: 1 },
  ] as const)('quarantines a run-memory proposal after a process kill at $crashPhase', async ({ crashPhase, marker, expectedMemoryRecords }) => {
    const project = await projects.createProject({ name: 'Dispatched tool crash', goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Save this decision in run memory.');
    let requestCount = 0;
    fakeModel = createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { raw += chunk; });
      incoming.on('end', () => {
        requestCount++;
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
        const toolNames = payload.tools?.map((tool) => tool.function?.name) ?? [];
        let chunks: Array<Record<string, unknown>>;
        if (toolNames.includes('submit_plan')) {
          const plan = {
            goal: 'Save a short decision in run memory.',
            successCriteria: ['The Writer saves the decision in this run only.'],
            tasks: [{ key: 'decision', title: 'Save run decision', objective: 'Save the decision using run-scoped memory.', capability: 'writing.draft', dependsOn: [] }],
          };
          chunks = [
            { id: 'dispatch-crash-plan', choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit-dispatch-crash-plan', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }] },
            { id: 'dispatch-crash-plan', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
          ];
        } else if (toolNames.includes('propose_memory')) {
          const args = JSON.stringify({ content: 'Decision sentinel: must not be saved before the interrupted tool runs.', scopeType: 'run' });
          chunks = [
            { id: 'dispatch-crash-memory', choices: [{ delta: { tool_calls: [{ index: 0, id: 'propose-memory-before-crash', type: 'function', function: { name: 'propose_memory', arguments: args } }] }, finish_reason: null }] },
            { id: 'dispatch-crash-memory', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } },
          ];
        } else {
          response.writeHead(500).end('Unexpected model request.');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel!.once('error', reject);
      fakeModel!.listen(0, '127.0.0.1', resolve);
    });
    const address = fakeModel.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await db.close();

    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./dispatch-tool-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl, crashPhase,
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const childExit = new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code }));
    });
    let killed = false;
    try {
      await Promise.race([
        vi.waitFor(() => expect(output).toContain(marker), { timeout: 20_000 }),
        childExit.then(({ code }) => { throw new Error(`Runtime exited before ${crashPhase} (code ${code}): ${output}`); }),
      ]);
      expect(requestCount).toBe(2);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        const operation = await observer.one<{ id: string; task_id: string; status: string; tool_id: string }>(
          'SELECT id, task_id, status, tool_id FROM tool_operations WHERE run_id = ?', [request.runId],
        );
        expect(operation).toMatchObject({ status: 'dispatched', tool_id: 'memory.propose' });
        const latest = await observer.one<{ state_json: string }>(
          'SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [operation!.task_id],
        );
        const checkpoint = JSON.parse(latest!.state_json) as { pendingToolCalls: Array<{ operationId: string; toolCallId: string; toolName: string }> };
        expect(checkpoint.pendingToolCalls).toEqual([{ operationId: operation!.id, toolCallId: 'propose-memory-before-crash', toolName: 'memory.propose' }]);
        expect(await observer.one<{ count: number }>("SELECT COUNT(*) AS count FROM memory_records WHERE project_id = ? AND scope_type = 'run'", [project.id]))
          .toEqual({ count: expectedMemoryRecords });
      } finally {
        await observer.close();
      }
      expect(child.kill('SIGKILL')).toBe(true);
      killed = true;
      const exit = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error('Runtime process did not exit after SIGKILL.'); }),
      ]);
      expect(exit.code).not.toBe(0);
    } finally {
      if (!killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (!killed) await Promise.race([childExit.catch(() => undefined), delay(5_000)]);
    }

    fakeModel.closeAllConnections();
    await new Promise<void>((resolve, reject) => fakeModel!.close((error) => error ? reject(error) : resolve()));
    fakeModel = undefined;

    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({ OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'disabled' }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    await runtime.recover();

    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
      .toEqual({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
    expect(await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE run_id = ?', [request.runId]))
      .toMatchObject({ status: 'outcome_unknown', receipt_json: expect.stringContaining('inspect the workspace or artifact history') });
    expect(await db.one<{ status: string }>('SELECT status FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ status: 'failed' });
    expect(await db.one<{ status: string }>('SELECT status FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)', [request.runId]))
      .toEqual({ status: 'released' });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM memory_records WHERE project_id = ? AND scope_type = 'run'", [project.id]))
      .toEqual({ count: expectedMemoryRecords });

    await runtime.recover();
    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
      .toEqual({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
    expect(requestCount).toBe(2);
  }, 45_000);
});

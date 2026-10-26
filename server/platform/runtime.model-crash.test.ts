import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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

describe('hard process termination during a model stream', () => {
  let dataDir: string;
  let workspaceRoot: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  let runtime: AgentRuntime | undefined;
  let fakeModel: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-model-crash-'));
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

  it('does not replay or duplicate a run after hard-kill immediately following terminal commit', async () => {
    const project = await projects.createProject({ name: 'Finalized run recovery', goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Reply with the word Ready.');
    let requestCount = 0;
    fakeModel = createServer((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => {
        requestCount++;
        const id = `finalized-answer-${requestCount}`;
        const chunks = [
          { id, choices: [{ delta: { content: 'Ready.' }, finish_reason: null }] },
          { id, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        ];
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel!.once('error', reject);
      fakeModel!.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${(fakeModel.address() as AddressInfo).port}/v1`;
    await db.close();

    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./run-finalization-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl,
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let signalFinalized!: () => void;
    const finalized = new Promise<void>((resolve) => { signalFinalized = resolve; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('RUN_FINALIZATION_COMMITTED')) signalFinalized();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const childExit = new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code }));
    });
    let killed = false;
    try {
      await Promise.race([
        finalized,
        childExit.then(({ code }) => { throw new Error(`Runtime exited before terminal commit (code ${code}): ${output}`); }),
        delay(20_000).then(() => { throw new Error(`Timed out waiting for terminal commit: ${output}`); }),
      ]);
      expect(requestCount).toBe(1);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        expect(await observer.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
          .toEqual({ status: 'succeeded', error_code: null });
        expect(await observer.all<{ content: string; status: string }>("SELECT content, status FROM messages WHERE run_id = ? AND speaker = 'coordinator'", [request.runId]))
          .toEqual([{ content: 'Ready.', status: 'completed' }]);
        expect(await observer.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'run.status_changed' AND aggregate_id = ? AND json_extract(payload_json, '$.status') = 'succeeded'", [request.runId]))
          .toEqual({ count: 1 });
      } finally {
        await observer.close();
      }
      expect(child.kill('SIGKILL')).toBe(true);
      killed = true;
      const exit = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error('Finalized runtime did not exit after SIGKILL.'); }),
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
      MODEL_PRIMARY_API_KEY: 'run-finalization-crash-test-key',
      MODEL_PRIMARY_NAME: 'run-finalization-crash-test-model',
    }));
    await runtime.recover();
    await delay(100);

    expect(requestCount).toBe(1);
    expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
      .toEqual({ status: 'succeeded', error_code: null });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE run_id = ? AND speaker = 'coordinator'", [request.runId]))
      .toEqual({ count: 1 });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'run.status_changed' AND aggregate_id = ? AND json_extract(payload_json, '$.status') = 'succeeded'", [request.runId]))
      .toEqual({ count: 1 });
    expect(await db.all<{ status: string }>('SELECT status FROM model_call_reservations WHERE run_id = ?', [request.runId]))
      .toEqual([{ status: 'settled' }]);
  }, 35_000);

  it('retries an interrupted Coordinator stream after restart without persisting partial text or duplicate work', async () => {
    const project = await projects.createProject({ name: 'Coordinator stream recovery', goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Acknowledge that this test workspace is ready with a short reply.');
    let signalFirstRequestStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => { signalFirstRequestStarted = resolve; });
    let requestCount = 0;
    fakeModel = createServer((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => {
        requestCount++;
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        if (requestCount === 1) {
          response.write(`data: ${JSON.stringify({ id: 'interrupted-coordinator-stream', choices: [{ delta: { content: 'Partial text must not become a saved answer.' }, finish_reason: null }] })}\n\n`);
          response.flushHeaders();
          signalFirstRequestStarted();
          return;
        }
        const chunks = [
          { id: 'recovered-coordinator-answer', choices: [{ delta: { content: 'The test workspace is ready.' }, finish_reason: null }] },
          { id: 'recovered-coordinator-answer', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
        ];
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel!.once('error', reject);
      fakeModel!.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${(fakeModel.address() as AddressInfo).port}/v1`;
    await db.close();

    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./model-stream-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl,
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
        firstRequestStarted,
        childExit.then(({ code }) => { throw new Error(`Runtime exited before opening the Coordinator stream (code ${code}): ${output}`); }),
        delay(20_000).then(() => { throw new Error(`Timed out waiting for the Coordinator stream: ${output}`); }),
      ]);
      expect(requestCount).toBe(1);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        await vi.waitFor(async () => {
          expect(await observer.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId]))
            .toMatchObject({ status: expect.stringMatching(/^(planning|executing)$/) });
          expect(await observer.one<{ count: number }>('SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
          expect(await observer.one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE run_id = ? AND speaker = 'coordinator'", [request.runId])).toEqual({ count: 0 });
        }, { timeout: 5_000 });
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
      MODEL_PRIMARY_API_KEY: 'coordinator-crash-test-key',
      MODEL_PRIMARY_NAME: 'coordinator-crash-test-model',
    }));
    await runtime.recover();

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
        .toEqual({ status: 'succeeded', error_code: null });
    }, { timeout: 20_000 });
    expect(requestCount).toBe(2);
    expect(await db.one<{ plan_revision: number }>('SELECT plan_revision FROM runs WHERE id = ?', [request.runId])).toEqual({ plan_revision: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
    expect(await db.all<{ status: string; count: number }>('SELECT status, COUNT(*) AS count FROM model_call_reservations WHERE run_id = ? GROUP BY status ORDER BY status', [request.runId]))
      .toEqual([{ status: 'settled', count: 1 }, { status: 'unknown', count: 1 }]);
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM model_usage WHERE run_id = ?', [request.runId])).toEqual({ count: 1 });
    const messages = await db.all<{ speaker: string; status: string; content: string }>('SELECT speaker, status, content FROM messages WHERE run_id = ?', [request.runId]);
    expect(messages.filter((message) => message.speaker === 'coordinator')).toEqual([
      { speaker: 'coordinator', status: 'completed', content: 'The test workspace is ready.' },
    ]);
    expect(messages.some((message) => message.content.includes('Partial text must not become a saved answer.'))).toBe(false);
  }, 55_000);

  it('marks a leased specialist stream unknown and releases its assignment for restart', async () => {
    const project = await projects.createProject({ name: 'Model crash recovery', goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Write a short introduction for this project.');
    let signalRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => { signalRequestStarted = resolve; });
    let signalSecondRequestStarted!: () => void;
    const secondRequestStarted = new Promise<void>((resolve) => { signalSecondRequestStarted = resolve; });
    let requestCount = 0;
    let firstAgentInstanceId = '';
    let firstFenceToken = 0;
    fakeModel = createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { raw += chunk; });
      incoming.on('end', () => {
        requestCount++;
        if (requestCount === 1) {
          const plan = {
            goal: 'Write a concise project introduction.',
            successCriteria: ['The Writer creates a short, reviewable introduction.'],
            tasks: [{ key: 'intro', title: 'Draft project introduction', objective: 'Write a short introduction for the project.', capability: 'writing.draft', dependsOn: [] }],
          };
          const chunks = [
            { id: 'accepted-plan', choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit-plan', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }] },
            { id: 'accepted-plan', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
          ];
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
          return;
        }
        if (requestCount === 2 || requestCount === 3) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          response.write(`data: ${JSON.stringify({ id: `interrupted-specialist-stream-${requestCount}`, choices: [{ delta: { content: `Partial Writer response ${requestCount}` }, finish_reason: null }] })}\n\n`);
          response.flushHeaders();
          if (requestCount === 2) signalRequestStarted();
          else signalSecondRequestStarted();
          // Keep the specialist response open while its durable assignment lease is active.
          return;
        }
        const id = `recovered-response-${requestCount}`;
        const chunks = [
          { id, choices: [{ delta: { content: 'The Writer completed the introduction after recovery.' }, finish_reason: null }] },
          { id, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
        ];
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
      '--import', 'tsx', fileURLToPath(new URL('./model-stream-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl,
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
        requestStarted,
        childExit.then(({ code }) => { throw new Error(`Runtime exited before opening the specialist model stream (code ${code}): ${output}`); }),
        delay(20_000).then(() => { throw new Error(`Timed out waiting for the model stream: ${output}`); }),
      ]);
      expect(requestCount).toBe(2);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        await vi.waitFor(async () => {
          expect(await observer.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'executing' });
          expect(await observer.one<{ status: string; assigned_agent_id: string }>('SELECT status, assigned_agent_id FROM tasks WHERE run_id = ?', [request.runId])).toMatchObject({ status: 'running', assigned_agent_id: expect.any(String) });
          const assignment = await observer.one<{ status: string; lease_owner: string; agent_instance_id: string; fence_token: number }>("SELECT status, lease_owner, agent_instance_id, fence_token FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)", [request.runId]);
          expect(assignment).toMatchObject({ status: 'active', lease_owner: expect.any(String), agent_instance_id: expect.any(String), fence_token: expect.any(Number) });
          firstAgentInstanceId = assignment!.agent_instance_id;
          firstFenceToken = assignment!.fence_token;
        }, { timeout: 5_000 });
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

    const secondChild = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./model-stream-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl,
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let secondOutput = '';
    secondChild.stdout.setEncoding('utf8').on('data', (chunk: string) => { secondOutput += chunk; });
    secondChild.stderr.setEncoding('utf8').on('data', (chunk: string) => { secondOutput += chunk; });
    const secondChildExit = new Promise<{ code: number | null }>((resolve, reject) => {
      secondChild.once('error', reject);
      secondChild.once('exit', (code) => resolve({ code }));
    });
    let secondKilled = false;
    try {
      await Promise.race([
        secondRequestStarted,
        secondChildExit.then(({ code }) => { throw new Error(`Restarted runtime exited before the second specialist stream (code ${code}): ${secondOutput}`); }),
        delay(20_000).then(() => { throw new Error(`Timed out waiting for the second specialist stream: ${secondOutput}`); }),
      ]);
      expect(requestCount).toBe(3);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        await vi.waitFor(async () => {
          expect(await observer.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'executing' });
          expect(await observer.one<{ status: string; assigned_agent_id: string }>('SELECT status, assigned_agent_id FROM tasks WHERE run_id = ?', [request.runId]))
            .toMatchObject({ status: 'running', assigned_agent_id: firstAgentInstanceId });
          expect(await observer.one<{ status: string; agent_instance_id: string; fence_token: number }>("SELECT status, agent_instance_id, fence_token FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?) AND status = 'active'", [request.runId]))
            .toEqual({ status: 'active', agent_instance_id: firstAgentInstanceId, fence_token: firstFenceToken + 1 });
        }, { timeout: 5_000 });
      } finally {
        await observer.close();
      }
      expect(secondChild.kill('SIGKILL')).toBe(true);
      secondKilled = true;
      const exit = await Promise.race([
        secondChildExit,
        delay(5_000).then(() => { throw new Error('Restarted runtime process did not exit after SIGKILL.'); }),
      ]);
      expect(exit.code).not.toBe(0);
    } finally {
      if (!secondKilled && secondChild.exitCode === null && secondChild.signalCode === null) secondChild.kill('SIGKILL');
      if (!secondKilled) await Promise.race([secondChildExit.catch(() => undefined), delay(5_000)]);
    }

    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir,
      OFFICE_CONFIG_DIR: process.cwd(),
      OFFICE_EXECUTION_MODE: 'disabled',
      MODEL_PRIMARY_BASE_URL: baseUrl,
      MODEL_PRIMARY_API_KEY: 'hard-crash-test-key',
      MODEL_PRIMARY_NAME: 'hard-crash-test-model',
    }));
    await runtime.recover();

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
        .toEqual({ status: 'succeeded', error_code: null });
      expect(await db.one<{ status: string }>('SELECT status FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 25_000 });
    expect(requestCount).toBe(5);
    expect(await db.all<{ status: string; count: number }>('SELECT status, COUNT(*) AS count FROM model_call_reservations WHERE run_id = ? GROUP BY status ORDER BY status', [request.runId]))
      .toEqual([{ status: 'settled', count: 3 }, { status: 'unknown', count: 2 }]);
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM model_usage WHERE run_id = ?', [request.runId])).toEqual({ count: 3 });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?) AND status IN ('reserved','active','releasing')", [request.runId])).toEqual({ count: 0 });
    expect(await db.all<{ agent_instance_id: string; fence_token: number; status: string }>("SELECT agent_instance_id, fence_token, status FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?) ORDER BY fence_token", [request.runId]))
      .toEqual([
        { agent_instance_id: firstAgentInstanceId, fence_token: firstFenceToken, status: 'released' },
        { agent_instance_id: firstAgentInstanceId, fence_token: firstFenceToken + 1, status: 'released' },
        { agent_instance_id: firstAgentInstanceId, fence_token: firstFenceToken + 2, status: 'released' },
      ]);
    expect(await db.one<{ output: string; assigned_agent_id: string }>('SELECT output, assigned_agent_id FROM tasks WHERE run_id = ?', [request.runId]))
      .toMatchObject({ output: 'The Writer completed the introduction after recovery.', assigned_agent_id: firstAgentInstanceId });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ?', [project.id])).toEqual({ count: 0 });
  }, 75_000);

  it('restarts safely when the process dies after checkpointing a tool call but before dispatch', async () => {
    const project = await projects.createProject({ name: 'Pending tool crash recovery', goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Create a short introduction for this project.');
    let requestCount = 0;
    const requests: Array<{ messages?: Array<{ role?: string; tool_call_id?: string; content?: string | null }> }> = [];
    fakeModel = createServer((incoming, response) => {
      let raw = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => { raw += chunk; });
      incoming.on('end', () => {
        requestCount++;
        const payload = JSON.parse(raw) as typeof requests[number] & { tools?: Array<{ function?: { name?: string } }> };
        requests.push(payload);
        const toolNames = payload.tools?.map((tool) => tool.function?.name) ?? [];
        let chunks: Array<Record<string, unknown>>;
        if (toolNames.includes('submit_plan')) {
          const plan = {
            goal: 'Write a concise project introduction.',
            successCriteria: ['The Writer creates a short, reviewable introduction.'],
            tasks: [{ key: 'intro', title: 'Draft project introduction', objective: 'Write a short introduction for the project.', capability: 'writing.draft', dependsOn: [] }],
          };
          chunks = [
            { id: 'pending-tool-plan', choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit-pending-tool-plan', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }] },
            { id: 'pending-tool-plan', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
          ];
        } else if (toolNames.includes('create_artifact') && requestCount === 2) {
          const args = JSON.stringify({ name: 'must-not-exist.txt', content: 'This tool call must not run before recovery.' });
          chunks = [
            { id: 'pending-tool-specialist', choices: [{ delta: { tool_calls: [{ index: 0, id: 'create-before-crash', type: 'function', function: { name: 'create_artifact', arguments: args } }] }, finish_reason: null }] },
            { id: 'pending-tool-specialist', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 } },
          ];
        } else {
          chunks = [
            { id: `pending-tool-result-${requestCount}`, choices: [{ delta: { content: 'The introduction is ready after safe restart.' }, finish_reason: null }] },
            { id: `pending-tool-result-${requestCount}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 } },
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
      '--import', 'tsx', fileURLToPath(new URL('./pending-tool-crash-child.ts', import.meta.url)),
      dataDir, request.runId, baseUrl,
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
        vi.waitFor(() => expect(output).toContain('PENDING_TOOL_CHECKPOINT_SAVED'), { timeout: 20_000 }),
        childExit.then(({ code }) => { throw new Error(`Runtime exited before checkpointing the pending tool call (code ${code}): ${output}`); }),
      ]);
      expect(requestCount).toBe(2);
      const observer = await DatabaseClient.openReadOnly(dataDir, true);
      try {
        const latest = await observer.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id IN (SELECT id FROM tasks WHERE run_id = ?) ORDER BY position DESC LIMIT 1', [request.runId]);
        const checkpoint = JSON.parse(latest!.state_json) as { pendingToolCalls: Array<{ operationId: string; toolCallId: string }> };
        expect(checkpoint.pendingToolCalls).toHaveLength(1);
        expect(checkpoint.pendingToolCalls[0]).toMatchObject({ operationId: expect.any(String), toolCallId: 'create-before-crash' });
        expect(await observer.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
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

    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir,
      OFFICE_CONFIG_DIR: process.cwd(),
      OFFICE_EXECUTION_MODE: 'disabled',
      MODEL_PRIMARY_BASE_URL: baseUrl,
      MODEL_PRIMARY_API_KEY: 'hard-crash-test-key',
      MODEL_PRIMARY_NAME: 'hard-crash-test-model',
    }));
    await runtime.recover();

    await vi.waitFor(async () => {
      const run = await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId]);
      expect(['succeeded', 'failed']).toContain(run?.status);
    }, { timeout: 20_000 });
    const finalRun = await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]);
    expect(finalRun, `Runtime failed after recovery; requests=${requestCount}; tasks=${JSON.stringify(await db.all('SELECT id, status FROM tasks WHERE run_id = ?', [request.runId]))}`)
      .toEqual({ status: 'succeeded', error_code: null });
    expect(requestCount).toBe(4);
    const resumedSpecialist = requests[2];
    expect(resumedSpecialist?.messages?.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'create-before-crash' });
    expect(resumedSpecialist?.messages?.at(-1)?.content).toContain('stopped before this tool was dispatched');
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ?', [project.id])).toEqual({ count: 0 });
  }, 45_000);
});

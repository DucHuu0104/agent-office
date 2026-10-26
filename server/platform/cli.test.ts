import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseClient } from './database';
import { runCli } from './cli';

async function initializeDatabase(dataDir: string): Promise<void> {
  const database = await DatabaseClient.open(dataDir, true);
  await database.close();
}

async function runDoctor(dataDir: string, args: string[] = [], configDir = process.cwd(), modelEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {};
  Object.assign(env, {
    OFFICE_DATA_DIR: dataDir,
    OFFICE_CONFIG_DIR: configDir,
    MODEL_PRIMARY_API_KEY: 'doctor-test-secret-sentinel',
    ...modelEnv,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(['doctor', ...args], env, {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { code, stdout: stdout.join('\n') + (stdout.length ? '\n' : ''), stderr: stderr.join('\n') + (stderr.length ? '\n' : '') };
}

async function withFakeProvider<T>(protocol: 'chat-completions' | 'responses', run: (baseUrl: string, requests: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }>) => Promise<T>): Promise<T> {
  const requests: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk.toString();
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization, body: JSON.parse(rawBody) as Record<string, unknown> });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (protocol === 'chat-completions') {
      const toolCall = Boolean((requests.at(-1)!.body.tools as unknown[] | undefined)?.length);
      const chunks = toolCall ? [
        { id: 'chat-probe', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'ping', arguments: '{"value":"READY"}' } }] }, finish_reason: 'tool_calls' }] },
      ] : [
        { id: 'chat-probe', choices: [{ delta: { content: 'READY' }, finish_reason: 'stop' }] },
      ];
      response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      return;
    }

    const events = (requests.at(-1)!.body.tools as unknown[] | undefined)?.length ? [
      { type: 'response.created', response: { id: 'response-probe' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: 'ping', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_probe', delta: '{"value":"READY"}' },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_probe', arguments: '{"value":"READY"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: 'ping', arguments: '{"value":"READY"}' } },
      { type: 'response.completed', response: { id: 'response-probe', status: 'completed', output: [{ type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: 'ping', arguments: '{"value":"READY"}' }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
    ] : [
      { type: 'response.created', response: { id: 'response-probe' } },
      { type: 'response.output_text.delta', item_id: 'msg_probe', delta: 'READY' },
      { type: 'response.completed', response: { id: 'response-probe', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'READY', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ];
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the fake local model provider.');
  try { return await run(`http://127.0.0.1:${address.port}/v1`, requests); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe('office doctor', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('checks migrated storage and registry without making a model request or exposing credentials', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-doctor-'));
    const dataDir = join(root, 'data');
    await initializeDatabase(dataDir);
    const databasePath = join(dataDir, 'agent-office.sqlite');
    const originalBytes = await readFile(databasePath);
    const result = await runDoctor(dataDir);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      ok: true,
      storage: { integrity: 'ok', requiredTables: 'ok', foreignKeyViolations: 0 },
      readiness: { registryReady: true, chatConfigured: false, executionMode: 'disabled' },
    });
    expect(JSON.stringify(report)).not.toContain('doctor-test-secret-sentinel');
    expect(await readFile(databasePath)).toEqual(originalBytes);
    expect(result.stderr).toBe('');
  });

  it('reports a missing database without creating or migrating a data directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-doctor-missing-'));
    const dataDir = join(root, 'not-initialized');
    const result = await runDoctor(dataDir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('database was not found');
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires explicit model configuration before an opt-in live probe', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-doctor-live-'));
    const result = await runDoctor(join(root, 'data'), ['--live']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Model chưa được cấu hình');
    expect(result.stderr).not.toContain('doctor-test-secret-sentinel');
  });

  it('sends the explicit text probe through the Coordinator Chat Completions profile', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-doctor-chat-'));
    const dataDir = join(root, 'data');
    await initializeDatabase(dataDir);
    await withFakeProvider('chat-completions', async (baseUrl, requests) => {
      const result = await runDoctor(dataDir, ['--live'], process.cwd(), { MODEL_PRIMARY_BASE_URL: baseUrl, MODEL_PRIMARY_NAME: 'fake-model' });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, modelProfile: 'primary', responseReceived: true, toolCalling: 'not checked' });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ url: '/v1/chat/completions', authorization: 'Bearer doctor-test-secret-sentinel', body: { model: 'fake-model', stream: true } });
      expect(result.stdout).not.toContain('doctor-test-secret-sentinel');
    });
  });

  it('uses the configured Responses profile and validates its function-call probe', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-doctor-responses-'));
    const configDir = join(root, 'configuration');
    for (const section of ['agents', 'skills', 'config']) await cp(join(process.cwd(), section), join(configDir, section), { recursive: true });
    const coordinatorPath = join(configDir, 'agents', 'definitions', 'coordinator', 'agent.yaml');
    await writeFile(coordinatorPath, (await readFile(coordinatorPath, 'utf8')).replace('modelProfile: primary\n', 'modelProfile: primary-responses\n'));
    const dataDir = join(root, 'data');
    await initializeDatabase(dataDir);

    await withFakeProvider('responses', async (baseUrl, requests) => {
      const result = await runDoctor(dataDir, ['--live', '--tools'], configDir, {
        MODEL_RESPONSES_BASE_URL: baseUrl,
        MODEL_RESPONSES_API_KEY: 'responses-doctor-test-secret',
        MODEL_RESPONSES_NAME: 'fake-model',
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, modelProfile: 'primary-responses', responseReceived: true, toolCalling: [{ name: 'ping', arguments: '{"value":"READY"}' }] });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ url: '/v1/responses', authorization: 'Bearer responses-doctor-test-secret', body: { model: 'fake-model', stream: true, max_output_tokens: 128, tool_choice: 'required' } });
      expect(result.stdout).not.toContain('responses-doctor-test-secret');
    });
  });

  it('lets the owner explicitly probe another registered model profile without changing the Coordinator', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-doctor-profile-'));
    const dataDir = join(root, 'data');
    const configDir = join(root, 'configuration');
    for (const section of ['agents', 'skills', 'config']) await cp(join(process.cwd(), section), join(configDir, section), { recursive: true });
    const modelConfigPath = join(configDir, 'config', 'models.yaml');
    const modelConfig = await readFile(modelConfigPath, 'utf8');
    const profileOffset = modelConfig.indexOf('  primary-responses:');
    expect(profileOffset).toBeGreaterThanOrEqual(0);
    const profilePrefix = modelConfig.slice(0, profileOffset);
    const profileBlock = modelConfig.slice(profileOffset)
      .replace('MODEL_PRIMARY_BASE_URL', 'MODEL_RESPONSES_BASE_URL')
      .replace('MODEL_PRIMARY_API_KEY', 'MODEL_RESPONSES_API_KEY')
      .replace('MODEL_PRIMARY_NAME', 'MODEL_RESPONSES_NAME');
    await writeFile(modelConfigPath, profilePrefix + profileBlock);
    await initializeDatabase(dataDir);

    await withFakeProvider('responses', async (baseUrl, requests) => {
      const missing = await runDoctor(dataDir, ['--live', '--profile', 'primary-responses'], configDir);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('MODEL_RESPONSES_BASE_URL');
      expect(requests).toHaveLength(0);

      const result = await runDoctor(dataDir, ['--live', '--tools', '--profile', 'primary-responses'], configDir, {
        MODEL_RESPONSES_BASE_URL: baseUrl,
        MODEL_RESPONSES_API_KEY: 'responses-test-key',
        MODEL_RESPONSES_NAME: 'fake-responses-model',
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, modelProfile: 'primary-responses', responseReceived: true });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ url: '/v1/responses', authorization: 'Bearer responses-test-key', body: { model: 'fake-responses-model', stream: true, max_output_tokens: 128, tool_choice: 'required' } });
      expect(result.stdout).not.toContain('responses-test-key');
    });
  });

  it('rejects an unknown model profile before sending any provider request', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-doctor-unknown-profile-'));
    const result = await runDoctor(join(root, 'data'), ['--live', '--profile', 'missing-profile']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Không tìm thấy model profile');
    expect(result.stderr).not.toContain('doctor-test-secret-sentinel');
  });
});

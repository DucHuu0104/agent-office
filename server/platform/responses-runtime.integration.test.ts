import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';

describe('Responses API runtime integration', () => {
  let dataDir = '';
  let db: DatabaseClient | undefined;
  let runtime: AgentRuntime | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await runtime?.stop();
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await db?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('completes Coordinator planning, specialist artifact tools, and final answers through Responses', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-responses-runtime-'));
    const configDir = join(dataDir, 'config');
    await mkdir(configDir, { recursive: true });
    for (const entry of ['agents', 'config', 'skills']) await cp(join(process.cwd(), entry), join(configDir, entry), { recursive: true });
    for (const agentId of ['coordinator', 'writer']) {
      const manifestPath = join(configDir, 'agents', 'definitions', agentId, 'agent.yaml');
      const manifest = (await readFile(manifestPath, 'utf8')).replace(/\r\n/g, '\n');
      await writeFile(manifestPath, manifest.replace('modelProfile: primary\n', 'modelProfile: primary-responses\n'), 'utf8');
    }

    const registry = await loadRegistry(configDir);
    const artifactName = 'responses-runtime.md';
    const artifactContent = '# Responses runtime integration\n\nCreated through the Responses function-call protocol.\n';
    const requests: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
    const providerErrors: string[] = [];
    server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        void (async () => {
          requests.push({ url: request.url ?? '', authorization: request.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
          const payload = requests.at(-1)!.body;
          const tools = Array.isArray(payload.tools) ? payload.tools as Array<Record<string, unknown>> : [];
          const input = Array.isArray(payload.input) ? payload.input as Array<Record<string, unknown>> : [];
          const toolNames = tools.map((tool) => typeof tool.name === 'string' ? tool.name : '');
          const callId = `responses-call-${requests.length}`;
          const itemId = `responses-item-${requests.length}`;
          let output: Array<Record<string, unknown>>;
          let usage: Record<string, number>;

          if (toolNames.includes('submit_plan')) {
            const writerCapability = registry.definitions.get('writer')!.manifest.capabilities[0]!;
            const plan = JSON.stringify({
              goal: 'Create and verify one Responses API artifact.',
              successCriteria: ['Writer creates the requested artifact.'],
              tasks: [{ key: 'draft', title: 'Create the integration artifact', objective: 'Create the requested markdown artifact.', capability: writerCapability, dependsOn: [] }],
            });
            output = [{ id: itemId, type: 'function_call', call_id: callId, name: 'submit_plan', arguments: plan }];
            usage = { input_tokens: 31, output_tokens: 11, total_tokens: 42 };
          } else if (toolNames.includes('create_artifact') && !input.some((item) => item.type === 'function_call_output')) {
            const artifactTool = tools.find((tool) => tool.name === 'create_artifact');
            expect(artifactTool?.type).toBe('function');
            output = [{ id: itemId, type: 'function_call', call_id: callId, name: 'create_artifact', arguments: JSON.stringify({ name: artifactName, content: artifactContent, mimeType: 'text/markdown' }) }];
            usage = { input_tokens: 27, output_tokens: 13, total_tokens: 40 };
          } else {
            if (input.some((item) => item.type === 'function_call_output')) {
              expect(input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'responses-call-2' }));
              output = [{ id: itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Writer created the verified Responses API artifact.' }] }];
              usage = { input_tokens: 36, output_tokens: 9, total_tokens: 45 };
            } else {
              output = [{ id: itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The Writer completed and verified the requested artifact.' }] }];
              usage = { input_tokens: 29, output_tokens: 10, total_tokens: 39 };
            }
          }

          const responseOutput = output;
          const responseId = `responses-response-${requests.length}`;
          const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { id: responseId } }];
          if (responseOutput[0]?.type === 'function_call') {
            const item = responseOutput[0];
            events.push(
              { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
              { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
              { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments },
              { type: 'response.output_item.done', output_index: 0, item },
            );
          } else {
            const text = (responseOutput[0]?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
            events.push({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text });
          }
          events.push({ type: 'response.completed', response: { id: responseId, status: 'completed', output: responseOutput, usage } });
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
          response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}`);
        })().catch((error: unknown) => {
          providerErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));
          if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end(error instanceof Error ? error.message : 'Fake Responses provider failed.');
        });
      });
    });
    await new Promise<void>((resolve, reject) => server!.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    vi.stubEnv('MODEL_RESPONSES_BASE_URL', baseUrl);
    vi.stubEnv('MODEL_RESPONSES_API_KEY', 'responses-runtime-test-secret');
    vi.stubEnv('MODEL_RESPONSES_NAME', 'fake-responses-runtime-model');

    db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir,
      OFFICE_CONFIG_DIR: configDir,
    }));

    const project = await projects.createProject({ name: 'Responses runtime integration', goal: 'Exercise the complete Responses provider path.' });
    const message = await projects.createUserMessage(project.id, project.conversationId, 'Create a markdown artifact with the Responses API.');
    runtime.enqueue(message.runId);
    try { await viWaitForRun(db, message.runId); }
    catch (error) {
      const run = await db.one('SELECT status, error_code FROM runs WHERE id = ?', [message.runId]);
      const requestDetails = requests.map((entry) => ({
        url: entry.url,
        tools: (entry.body.tools as Array<{ name?: string }> | undefined)?.map((tool) => tool.name),
        input: (entry.body.input as Array<Record<string, unknown>> | undefined)?.map((item) => ({ type: item.type, role: item.role, name: item.name, call_id: item.call_id })),
      }));
      throw new Error(`${error instanceof Error ? error.message : String(error)}; requests=${JSON.stringify(requestDetails)}; providerErrors=${providerErrors.join('\n')}; run=${JSON.stringify(run)}`);
    }

    expect(requests).toHaveLength(4);
    expect(requests.every((entry) => entry.url === '/v1/responses')).toBe(true);
    expect(requests.every((entry) => entry.authorization === 'Bearer responses-runtime-test-secret')).toBe(true);
    expect(JSON.stringify(requests.map((entry) => entry.body))).not.toContain('responses-runtime-test-secret');
    expect(requests.every((entry) => entry.body.model === 'fake-responses-runtime-model' && entry.body.stream === true && entry.body.store === false)).toBe(true);
    expect((requests[0]!.body.tools as Array<Record<string, unknown>>).map((tool) => tool.name)).toContain('submit_plan');
    expect((requests[1]!.body.tools as Array<Record<string, unknown>>).map((tool) => tool.name)).toContain('create_artifact');
    expect((requests[2]!.body.input as Array<Record<string, unknown>>)).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'responses-call-2', name: 'create_artifact' }));
    expect((requests[2]!.body.input as Array<Record<string, unknown>>)).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'responses-call-2' }));

    expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [message.runId])).toEqual({ status: 'succeeded' });
    const tasks = await projects.getTasks(message.runId);
    expect(tasks.map((task) => task.status)).toEqual(['succeeded']);
    expect(tasks[0]!.output).toContain('Writer created the verified Responses API artifact.');
    expect((await projects.listMessages(project.conversationId)).some((entry) => entry.speaker === 'coordinator'
      && entry.status === 'completed'
      && entry.content === 'The Writer completed and verified the requested artifact.')).toBe(true);
    const artifacts = await new ArtifactService(db, events, dataDir).list(project.id);
    expect(artifacts.map((artifact) => artifact.logicalName)).toEqual([artifactName]);
    const artifact = await new ArtifactService(db, events, dataDir).content(artifacts[0]!.versionId);
    expect(artifact?.content.toString('utf8')).toBe(artifactContent);
    const calls = await db.all<{ status: string; input_tokens: number; output_tokens: number }>(
      'SELECT status, prompt_tokens AS input_tokens, completion_tokens AS output_tokens FROM model_call_reservations WHERE run_id = ? ORDER BY created_at', [message.runId],
    );
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.status === 'settled')).toBe(true);
    expect(calls.reduce((sum, call) => sum + call.input_tokens + call.output_tokens, 0)).toBe(166);
    const lifecycleEvents = (await events.listSince(0)).filter((event) => event.type === 'agent.lifecycle_hook'
      && ['before_model_call', 'after_model_call'].includes(String(event.payload.event)));
    expect(lifecycleEvents).toHaveLength(8);
    expect(lifecycleEvents.every((event) => (event.payload.metadata as Record<string, unknown>).profileId === 'primary-responses')).toBe(true);
    expect(JSON.stringify(lifecycleEvents)).not.toContain('responses-runtime-test-secret');
  });
});

async function viWaitForRun(database: DatabaseClient, runId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await database.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [runId]);
    if (run?.status === 'succeeded') return;
    if (run?.status === 'failed' || run?.status === 'cancelled') {
      throw new Error(`Responses API integration run ended as ${run.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const run = await database.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [runId]);
  throw new Error(`Responses API integration run did not finish before deadline (status ${run?.status ?? 'missing'}).`);
}

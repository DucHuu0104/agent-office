import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBaselineCli } from './run-baseline';

describe('live baseline runner with an isolated fake provider', () => {
  let root: string | undefined;
  let provider: ReturnType<typeof createServer> | undefined;
  let previousEnvironment: Map<string, string | undefined> | undefined;

  afterEach(async () => {
    if (previousEnvironment) {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      previousEnvironment = undefined;
    }
    if (provider?.listening) {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider!.close((error) => error ? reject(error) : resolve()));
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('writes tool identity/status evidence while excluding tool arguments and receipts', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-baseline-runner-'));
    let requestCount = 0;
    let csvToolCalls = 0;
    const seenToolNames: string[][] = [];
    provider = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        requestCount++;
        const payload = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
        const toolNames = payload.tools?.map((tool) => tool.function?.name ?? '(unnamed)') ?? [];
        seenToolNames.push(toolNames);
        if (requestCount === 1 && toolNames.includes('submit_plan')) {
          const plan = {
            goal: 'Count records and missing scores.',
            successCriteria: ['Report three records and one missing score.'],
            tasks: [{ key: 'analyze', title: 'Count scores', objective: 'Use the deterministic CSV tool to count records and missing scores.', capability: 'data.csv', dependsOn: [] }],
          };
          return sendModelStream(response, [{
            id: 'baseline-test-plan', choices: [{ delta: { tool_calls: [{ index: 0, id: 'baseline-test-plan-call', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }],
          }, { id: 'baseline-test-plan', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: usage() }]);
        }
        if (csvToolCalls === 0 && toolNames.includes('summarize_csv')) {
          csvToolCalls++;
          return sendModelStream(response, [{
            id: 'baseline-test-csv', choices: [{ delta: { tool_calls: [{ index: 0, id: 'baseline-test-csv-call', type: 'function', function: { name: 'summarize_csv', arguments: JSON.stringify({ csvContent: 'name,score\nA,\nB,0\nC,8\n' }) } }] }, finish_reason: null }],
          }, { id: 'baseline-test-csv', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: usage() }]);
        }
        return sendModelStream(response, [
          { id: `baseline-test-final-${requestCount}`, choices: [{ delta: { content: 'There are 3 records and 1 missing score. Zero is present.' }, finish_reason: null }] },
          { id: `baseline-test-final-${requestCount}`, choices: [{ delta: {}, finish_reason: 'stop' }], usage: usage() },
        ]);
      });
    });
    await new Promise<void>((resolve, reject) => {
      provider!.once('error', reject);
      provider!.listen(0, '127.0.0.1', resolve);
    });
    const address = provider.address() as AddressInfo;
    const outputPath = join(root, 'report.json');
    const env = {
      OFFICE_EXECUTION_MODE: 'disabled',
      OFFICE_CONFIG_DIR: process.cwd(),
      MODEL_PRIMARY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      MODEL_PRIMARY_API_KEY: 'fake-baseline-test-key',
      MODEL_PRIMARY_NAME: 'fake-baseline-test-model',
      MODEL_RESPONSES_BASE_URL: 'http://127.0.0.1:9/v1',
      MODEL_RESPONSES_API_KEY: '',
      MODEL_RESPONSES_NAME: '',
    };
    previousEnvironment = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    await runBaselineCli([
      '--live', '--tasks', 'A03', '--strategies', 'single-agent', '--repetitions', '1',
      '--max-total-usd', '0.15', '--max-total-tokens', '12000', '--max-tokens-per-run', '12000',
      '--max-output-tokens', '256', '--min-request-interval-ms', '0', '--allow-unpriced', '--output', outputPath,
    ]);
    const report = JSON.parse(await readFile(outputPath, 'utf8')) as {
      runs: Array<{ status: string; toolOperations: Array<Record<string, unknown>> }>;
    };
    expect(csvToolCalls, JSON.stringify({ seenToolNames, run: report.runs[0] })).toBe(1);
    expect(report.runs[0]).toMatchObject({
      status: 'succeeded',
      toolOperations: [{ toolId: 'analysis.csv_summary', status: 'succeeded', count: 1 }],
    });
    expect(JSON.stringify(report.runs[0]?.toolOperations)).not.toMatch(/scores\.csv|private|arguments|receipt/i);
  }, 40_000);

  it('persists the active run before provider work and publishes its completed result', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-baseline-checkpoint-'));
    let receiveResponse!: (response: ServerResponse) => void;
    const firstRequest = new Promise<ServerResponse>((resolve) => { receiveResponse = resolve; });
    provider = createServer((request, response) => {
      request.resume();
      request.on('end', () => receiveResponse(response));
    });
    await new Promise<void>((resolve, reject) => {
      provider!.once('error', reject);
      provider!.listen(0, '127.0.0.1', resolve);
    });
    const address = provider.address() as AddressInfo;
    const outputPath = join(root, 'checkpoint-report.json');
    const checkpointPath = `${outputPath}.partial`;
    const env = {
      OFFICE_EXECUTION_MODE: 'disabled',
      OFFICE_CONFIG_DIR: process.cwd(),
      MODEL_PRIMARY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      MODEL_PRIMARY_API_KEY: 'fake-baseline-test-key',
      MODEL_PRIMARY_NAME: 'fake-baseline-test-model',
      MODEL_RESPONSES_BASE_URL: 'http://127.0.0.1:9/v1',
      MODEL_RESPONSES_API_KEY: '',
      MODEL_RESPONSES_NAME: '',
    };
    previousEnvironment = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);

    const execution = runBaselineCli([
      '--live', '--tasks', 'A03', '--strategies', 'single-agent', '--repetitions', '1',
      '--max-total-usd', '0.15', '--max-total-tokens', '12000', '--max-tokens-per-run', '12000',
      '--max-output-tokens', '256', '--min-request-interval-ms', '0', '--allow-unpriced', '--output', outputPath,
    ]);
    const response = await firstRequest;
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      executionState: string;
      activeRun: { taskId: string; strategy: string; repetition: number; tokenCeiling: number } | null;
      runs: unknown[];
    };
    expect(checkpoint).toMatchObject({
      executionState: 'running',
      activeRun: { taskId: 'A03', strategy: 'single-agent', repetition: 1, tokenCeiling: 12000 },
      runs: [],
    });
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });

    sendModelStream(response, [
      { id: 'checkpoint-final', choices: [{ delta: { content: 'There are 3 records and 1 missing score. Zero is present.' }, finish_reason: null }] },
      { id: 'checkpoint-final', choices: [{ delta: {}, finish_reason: 'stop' }], usage: usage() },
    ]);
    await execution;

    const report = JSON.parse(await readFile(outputPath, 'utf8')) as {
      executionState: string;
      activeRun: unknown;
      runs: Array<{ status: string }>;
    };
    expect(report).toMatchObject({ executionState: 'finished', activeRun: null, runs: [{ status: 'succeeded' }] });
    await expect(readFile(checkpointPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 40_000);

  it('refuses an existing partial checkpoint without overwriting it or contacting the provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-baseline-checkpoint-existing-'));
    let requestCount = 0;
    provider = createServer((_request, response) => { requestCount++; response.writeHead(500).end(); });
    await new Promise<void>((resolve, reject) => {
      provider!.once('error', reject);
      provider!.listen(0, '127.0.0.1', resolve);
    });
    const address = provider.address() as AddressInfo;
    const outputPath = join(root, 'checkpoint-report.json');
    const checkpointPath = `${outputPath}.partial`;
    const checkpointContents = '{"sentinel":"preserve incomplete evidence"}\n';
    await writeFile(checkpointPath, checkpointContents, 'utf8');
    const env = {
      OFFICE_EXECUTION_MODE: 'disabled',
      OFFICE_CONFIG_DIR: process.cwd(),
      MODEL_PRIMARY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      MODEL_PRIMARY_API_KEY: 'fake-baseline-test-key',
      MODEL_PRIMARY_NAME: 'fake-baseline-test-model',
      MODEL_RESPONSES_BASE_URL: 'http://127.0.0.1:9/v1',
      MODEL_RESPONSES_API_KEY: '',
      MODEL_RESPONSES_NAME: '',
    };
    previousEnvironment = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);

    await expect(runBaselineCli([
      '--live', '--tasks', 'A03', '--strategies', 'single-agent', '--repetitions', '1',
      '--max-total-usd', '0.15', '--max-total-tokens', '12000', '--max-tokens-per-run', '12000',
      '--max-output-tokens', '256', '--min-request-interval-ms', '0', '--allow-unpriced', '--output', outputPath,
    ])).rejects.toThrow('inspect it and choose a new --output path');
    expect(requestCount).toBe(0);
    await expect(readFile(checkpointPath, 'utf8')).resolves.toBe(checkpointContents);
  }, 20_000);

  it('runs the coordinator and Analyst through an explicitly selected Responses profile', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-responses-baseline-'));
    let requestCount = 0;
    let csvToolCalls = 0;
    const requestPaths: string[] = [];
    const requestAuthorization: string[] = [];
    provider = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        requestCount++;
        requestPaths.push(request.url ?? '');
        requestAuthorization.push(request.headers.authorization ?? '');
        const payload = JSON.parse(raw) as { tools?: Array<{ name?: string }> };
        const toolNames = payload.tools?.map((tool) => tool.name ?? '(unnamed)') ?? [];
        if (toolNames.includes('submit_plan')) {
          const plan = {
            goal: 'Count records and missing scores.',
            successCriteria: ['Report three records and one missing score.'],
            tasks: [{ key: 'analyze', title: 'Count scores', objective: 'Use the deterministic CSV tool to count records and missing scores.', capability: 'data.csv', dependsOn: [] }],
          };
          return sendResponsesFunction(response, 'responses-plan', 'responses-plan-call', 'submit_plan', JSON.stringify(plan));
        }
        if (csvToolCalls === 0 && toolNames.includes('summarize_csv')) {
          csvToolCalls++;
          return sendResponsesFunction(response, 'responses-csv', 'responses-csv-call', 'summarize_csv', JSON.stringify({ csvContent: 'name,score\nA,\nB,0\nC,8\n' }));
        }
        return sendResponsesText(response, `responses-final-${requestCount}`, 'There are 3 records and 1 missing score. Zero is present.');
      });
    });
    await new Promise<void>((resolve, reject) => {
      provider!.once('error', reject);
      provider!.listen(0, '127.0.0.1', resolve);
    });
    const address = provider.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const outputPath = join(root, 'responses-report.json');
    const env = {
      OFFICE_EXECUTION_MODE: 'disabled',
      OFFICE_CONFIG_DIR: process.cwd(),
      MODEL_PRIMARY_BASE_URL: 'https://primary.invalid/v1',
      MODEL_PRIMARY_API_KEY: '',
      MODEL_PRIMARY_NAME: '',
      MODEL_RESPONSES_BASE_URL: endpoint,
      MODEL_RESPONSES_API_KEY: 'fake-responses-test-key',
      MODEL_RESPONSES_NAME: 'fake-responses-test-model',
    };
    previousEnvironment = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    await runBaselineCli([
      '--live', '--tasks', 'A03', '--strategies', 'single-agent', '--repetitions', '1',
      '--model-profile', 'primary-responses', '--max-total-usd', '0.15', '--max-total-tokens', '12000', '--max-tokens-per-run', '12000',
      '--max-output-tokens', '256', '--min-request-interval-ms', '0', '--allow-unpriced', '--output', outputPath,
    ]);
    const report = JSON.parse(await readFile(outputPath, 'utf8')) as {
      providerHost: string;
      model: string;
      runs: Array<{ status: string; toolOperations: Array<Record<string, unknown>>; measuredTokens: number; unpricedRequests: number }>;
    };
    expect(report).toMatchObject({ providerHost: `127.0.0.1:${address.port}`, model: 'fake-responses-test-model' });
    expect(report.runs[0], JSON.stringify(report.runs[0])).toMatchObject({
      status: 'succeeded', measuredTokens: 320, unpricedRequests: 4,
      toolOperations: [{ toolId: 'analysis.csv_summary', status: 'succeeded', count: 1 }],
    });
    expect(csvToolCalls).toBe(1);
    expect(requestCount).toBe(4);
    expect(requestPaths).toEqual(Array.from({ length: 4 }, () => '/v1/responses'));
    expect(requestAuthorization).toEqual(Array.from({ length: 4 }, () => 'Bearer fake-responses-test-key'));
  }, 40_000);
});

function sendModelStream(response: import('node:http').ServerResponse, chunks: Array<Record<string, unknown>>): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
}

function usage(): Record<string, number> {
  return { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 };
}

function sendResponsesFunction(response: import('node:http').ServerResponse, id: string, callId: string, name: string, args: string): void {
  const itemId = `fc_${callId}`;
  const item = { type: 'function_call', id: itemId, call_id: callId, name, arguments: args };
  sendResponses(response, [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: itemId, delta: args },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: itemId, arguments: args },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 60, output_tokens: 20, total_tokens: 80 } } },
  ]);
}

function sendResponsesText(response: import('node:http').ServerResponse, id: string, text: string): void {
  sendResponses(response, [
    { type: 'response.created', response: { id } },
    { type: 'response.output_text.delta', item_id: `msg_${id}`, delta: text },
    { type: 'response.completed', response: { id, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 60, output_tokens: 20, total_tokens: 80 } } },
  ]);
}

function sendResponses(response: import('node:http').ServerResponse, events: Array<Record<string, unknown>>): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(`${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
}

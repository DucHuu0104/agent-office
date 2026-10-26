import { describe, expect, it, vi } from 'vitest';
import type { ChatGatewayOptions } from './types';
import { ResponsesGateway } from './responses';
import { ModelGatewayError } from './types';

const options = (baseUrl = 'https://provider.example/v1'): ChatGatewayOptions => ({
  baseUrl, apiKey: 'test-secret', model: 'response-model', maxOutputTokens: 128, timeoutSeconds: 5,
});

function streamResponse(events: unknown[], chunkSize = 13): Response {
  const wire = events.map((event) => typeof event === 'string'
    ? `data: ${event}\r\n\r\n`
    : `event: ${(event as { type?: string }).type ?? 'unknown'}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('Responses API endpoint and streaming contract', () => {
  it('accepts HTTPS and loopback endpoints and rejects unsafe URLs before fetching', async () => {
    expect(() => new ResponsesGateway(options()).assertConfigured()).not.toThrow();
    expect(() => new ResponsesGateway(options('http://127.0.0.1:8080/v1')).assertConfigured()).not.toThrow();
    for (const baseUrl of [
      'http://provider.example/v1',
      'https://user:password@provider.example/v1',
      'https://provider.example/v1?api_key=secret',
      'https://provider.example/v1#fragment',
    ]) {
      const fetcher = vi.fn<typeof fetch>();
      await expect(new ResponsesGateway(options(baseUrl), fetcher).complete({ messages: [{ role: 'user', content: 'hello' }] }))
        .rejects.toMatchObject<Partial<ModelGatewayError>>({ code: 'MODEL_ENDPOINT_INVALID' });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('maps canonical history and function tools, then assembles fragmented function-call events', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { type: 'response.created', response: { id: 'resp_tool_1' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"q' },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: 'uery":"room' },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: ' status"}' },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"query":"room status"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"room status"}' } },
      { type: 'response.completed', response: {
        id: 'resp_tool_1', status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-reasoning' },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"room status"}' },
        ],
        usage: { input_tokens: 51, output_tokens: 9, total_tokens: 60 },
      } },
    ]));
    const gateway = new ResponsesGateway(options(), fetcher);
    const onTextDelta = vi.fn();
    const result = await gateway.complete({
      messages: [
        { role: 'system', content: 'Use only approved tools.' },
        { role: 'user', content: 'Find the room status.' },
        { role: 'assistant', content: null, providerItems: [
          { type: 'reasoning', id: 'rs_previous', summary: [], encrypted_content: 'previous-encrypted-reasoning' },
          { type: 'function_call', id: 'fc_previous', call_id: 'call_previous', name: 'lookup', arguments: '{"query":"rooms"}' },
        ] },
        { role: 'tool', tool_call_id: 'call_previous', content: 'Room 1 is active.' },
        { role: 'user', content: 'Check it again.' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Search the room index.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, strict: true } }],
      toolChoice: { type: 'function', function: { name: 'lookup' } },
      onTextDelta,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://provider.example/v1/responses');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-secret');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'response-model', stream: true, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 128 });
    expect(body.input).toEqual([
      { role: 'system', content: 'Use only approved tools.' },
      { role: 'user', content: 'Find the room status.' },
      { type: 'reasoning', id: 'rs_previous', summary: [], encrypted_content: 'previous-encrypted-reasoning' },
      { type: 'function_call', id: 'fc_previous', call_id: 'call_previous', name: 'lookup', arguments: '{"query":"rooms"}' },
      { type: 'function_call_output', call_id: 'call_previous', output: 'Room 1 is active.' },
      { role: 'user', content: 'Check it again.' },
    ]);
    expect(body.tools).toEqual([{ type: 'function', name: 'lookup', description: 'Search the room index.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, strict: true }]);
    expect(body.tool_choice).toEqual({ type: 'function', name: 'lookup' });
    expect(result).toMatchObject({
      id: 'resp_tool_1', content: '', finishReason: 'completed',
      toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"query":"room status"}' }],
      usage: { promptTokens: 51, completionTokens: 9, totalTokens: 60 },
      providerItems: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-reasoning' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"room status"}' },
      ],
    });
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it('streams text deltas, reports usage and tolerates an event split at arbitrary byte boundaries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { type: 'response.created', response: { id: 'resp_text_1' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hello' },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: ' world' },
      { type: 'response.completed', response: {
        id: 'resp_text_1', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world', annotations: [] }] }],
        usage: { input_tokens: 8, output_tokens: 2 },
      } },
    ], 1));
    const onTextDelta = vi.fn();

    const result = await new ResponsesGateway(options(), fetcher).complete({ messages: [{ role: 'user', content: 'Say hello.' }], onTextDelta });

    expect(result).toMatchObject({ id: 'resp_text_1', content: 'Hello world', finishReason: 'completed', usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 } });
    expect(onTextDelta.mock.calls).toEqual([['Hello'], [' world']]);
  });

  it('filters reasoning markup from Responses text, stream deltas, and retained provider items', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { type: 'response.created', response: { id: 'resp_reasoning_1' } },
      { type: 'response.completed', response: {
        id: 'resp_reasoning_1', status: 'completed',
        output: [
          { type: 'reasoning', id: 'reasoning_1', summary: [{ type: 'summary_text', text: 'Before <think>private payload</think> after' }], encrypted_content: 'opaque-provider-data' },
          { type: 'message', content: [{ type: 'output_text', text: 'Answer: <think>private payload</think>42', annotations: [] }] },
        ],
        usage: { input_tokens: 8, output_tokens: 2 },
      } },
    ]));
    const onTextDelta = vi.fn();

    const result = await new ResponsesGateway(options(), fetcher).complete({
      messages: [{ role: 'user', content: 'Answer.' }],
      onTextDelta,
    });

    expect(result.content).toBe('Answer: 42');
    expect(onTextDelta.mock.calls).toEqual([['Answer: 42']]);
    expect(result.providerItems?.[0]).toMatchObject({ summary: [{ text: 'Before  after' }] });
    expect(result.providerItems?.[1]).toMatchObject({ content: [{ text: 'Answer: 42' }] });
  });

  it('uses the Responses required-tool choice form during bounded repair turns', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { type: 'response.completed', response: { id: 'resp_required', status: 'completed', output: [{ type: 'function_call', id: 'fc_required', call_id: 'call_required', name: 'lookup', arguments: '{}' }], usage: { input_tokens: 4, output_tokens: 2 } } },
    ]));
    const tool = { type: 'function' as const, function: { name: 'lookup', description: 'Look up a value.', parameters: { type: 'object', properties: {}, required: [] } } };

    await new ResponsesGateway(options(), fetcher).complete({
      messages: [{ role: 'user', content: 'Look up a value.' }],
      tools: [tool],
      toolChoice: 'required',
    });

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.tool_choice).toBe('required');
  });

  it('rejects missing credentials, HTTP failures, invalid JSON and partial streams while preserving malformed arguments for runtime recovery', async () => {
    const missingKey = new ResponsesGateway({ ...options(), apiKey: '' }, vi.fn<typeof fetch>());
    await expect(missingKey.complete({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });

    const httpFailure = new ResponsesGateway(options(), vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '1' } })));
    await expect(httpFailure.complete({ messages: [{ role: 'user', content: 'hello' }] }))
      .rejects.toMatchObject({ code: 'MODEL_HTTP_ERROR', status: 429, retryable: true, retryAfterMs: 1000 });

    const invalidJson = new ResponsesGateway(options(), vi.fn<typeof fetch>().mockResolvedValue(streamResponse(['{broken'])));
    await expect(invalidJson.complete({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toMatchObject({ code: 'MODEL_STREAM_ERROR' });

    const partial = new ResponsesGateway(options(), vi.fn<typeof fetch>().mockResolvedValue(streamResponse([{ type: 'response.created', response: { id: 'resp_partial' } }])));
    await expect(partial.complete({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toMatchObject({ code: 'MODEL_STREAM_ERROR' });

    const invalidArguments = new ResponsesGateway(options(), vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_bad', call_id: 'call_bad', name: 'lookup', arguments: '' } },
      { type: 'response.completed', response: { id: 'resp_bad', status: 'completed', output: [{ type: 'function_call', id: 'fc_bad', call_id: 'call_bad', name: 'lookup', arguments: '{bad' }] } },
    ])));
    await expect(invalidArguments.complete({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toMatchObject({
      toolCalls: [{ id: 'call_bad', name: 'lookup', arguments: '{bad' }],
      finishReason: 'completed',
    });
  });

  it('propagates caller cancellation instead of disguising it as a timeout', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('caller cancelled')), { once: true });
    }));
    const pending = new ResponsesGateway(options(), fetcher).complete({ messages: [{ role: 'user', content: 'hello' }], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('caller cancelled');
  });
});

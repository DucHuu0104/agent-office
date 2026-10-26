import { describe, expect, it, vi } from 'vitest';
import { ChatCompletionsGateway, ModelGatewayError } from './chat-completions';
import { parseRetryAfterMs } from './types';

const options = (baseUrl: string) => ({ baseUrl, apiKey: 'test-secret', model: 'test-model', maxOutputTokens: 100, timeoutSeconds: 5 });

function streamResponse(events: unknown[], chunkSize = 11): Response {
  const wire = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('Chat Completions endpoint validation', () => {
  it('accepts HTTPS providers and HTTP loopback development endpoints', () => {
    expect(() => new ChatCompletionsGateway(options('https://provider.example/v1')).assertConfigured()).not.toThrow();
    expect(() => new ChatCompletionsGateway(options('http://127.0.0.1:8080/v1')).assertConfigured()).not.toThrow();
  });

  it.each([
    'http://provider.example/v1',
    'https://user:password@provider.example/v1',
    'https://provider.example/v1?api_key=secret',
    'https://provider.example/v1#fragment',
  ])('rejects unsafe endpoint %s before making a request', async (baseUrl) => {
    const fetcher = vi.fn<typeof fetch>();
    const gateway = new ChatCompletionsGateway({ ...options(baseUrl) }, fetcher);

    await expect(gateway.complete({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toMatchObject<Partial<ModelGatewayError>>({ code: 'MODEL_ENDPOINT_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports missing credentials before a network attempt', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const gateway = new ChatCompletionsGateway({ ...options('https://provider.example/v1'), apiKey: '' }, fetcher);

    await expect(gateway.complete({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Chat Completions streaming contract', () => {
  it('filters private reasoning markup from content and streamed deltas', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { id: 'chat_reasoning_1', choices: [{ delta: { content: 'Answer: ' }, finish_reason: null }] },
      { id: 'chat_reasoning_1', choices: [{ delta: { content: '<thi' }, finish_reason: null }] },
      { id: 'chat_reasoning_1', choices: [{ delta: { content: 'nk>private payload' }, finish_reason: null }] },
      { id: 'chat_reasoning_1', choices: [{ delta: { content: '</think>42' }, finish_reason: null }] },
      { id: 'chat_reasoning_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]));
    const onTextDelta = vi.fn();

    const result = await new ChatCompletionsGateway(options('https://provider.example/v1'), fetcher)
      .complete({ messages: [{ role: 'user', content: 'Answer.' }], onTextDelta });

    expect(result.content).toBe('Answer: 42');
    expect(onTextDelta.mock.calls).toEqual([['Answer: '], ['42']]);
  });

  it('maps canonical history and assembles multiple fragmented tool calls and usage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { id: 'chat_stream_1', choices: [{ delta: { content: 'I will ' }, finish_reason: null }] },
      { id: 'chat_stream_1', choices: [{ delta: { content: 'check.' }, finish_reason: null }] },
      { id: 'chat_stream_1', choices: [{ delta: { tool_calls: [
        { index: 0, id: 'lookup_1', type: 'function', function: { name: 'lookup_room', arguments: '{"room' } },
        { index: 1, id: 'lookup_2', type: 'function', function: { name: 'lookup_owner', arguments: '{"owner' } },
      ] }, finish_reason: null }] },
      { id: 'chat_stream_1', choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: '":"Copa"}' } },
        { index: 1, function: { arguments: '":"Ana"}' } },
      ] }, finish_reason: null }] },
      { id: 'chat_stream_1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { id: 'chat_stream_1', choices: [], usage: { prompt_tokens: 41, completion_tokens: 12, total_tokens: 53 } },
      '[DONE]',
    ], 3));
    const onTextDelta = vi.fn();
    const result = await new ChatCompletionsGateway(options('https://provider.example/v1'), fetcher).complete({
      messages: [
        { role: 'system', content: 'Use only approved tools.' },
        { role: 'assistant', content: null, providerItems: [{ type: 'reasoning', id: 'private-provider-item' }] },
        { role: 'tool', tool_call_id: 'prior-call', content: 'A room is active.' },
        { role: 'user', content: 'Check the room and owner.' },
      ],
      tools: [
        { type: 'function', function: { name: 'lookup_room', description: 'Look up a room.', parameters: { type: 'object', properties: { room: { type: 'string' } }, required: ['room'] } } },
        { type: 'function', function: { name: 'lookup_owner', description: 'Look up an owner.', parameters: { type: 'object', properties: { owner: { type: 'string' } }, required: ['owner'] } } },
      ],
      toolChoice: { type: 'function', function: { name: 'lookup_room' } },
      onTextDelta,
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://provider.example/v1/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-secret');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'test-model', stream: true, stream_options: { include_usage: true }, max_tokens: 100,
      messages: [
        { role: 'system', content: 'Use only approved tools.' },
        { role: 'assistant', content: null },
        { role: 'tool', tool_call_id: 'prior-call', content: 'A room is active.' },
        { role: 'user', content: 'Check the room and owner.' },
      ],
      tool_choice: { type: 'function', function: { name: 'lookup_room' } },
    });
    expect(result).toMatchObject({
      id: 'chat_stream_1', content: 'I will check.', finishReason: 'tool_calls',
      toolCalls: [
        { id: 'lookup_1', name: 'lookup_room', arguments: '{"room":"Copa"}' },
        { id: 'lookup_2', name: 'lookup_owner', arguments: '{"owner":"Ana"}' },
      ],
      usage: { promptTokens: 41, completionTokens: 12, totalTokens: 53 },
    });
    expect(onTextDelta.mock.calls).toEqual([['I will '], ['check.']]);
  });

  it.each([401, 429, 500, 503])('reports provider HTTP status %s without returning response content', async (status) => {
    const retryable = status === 429 || status >= 500;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private provider response', { status, headers: { 'Retry-After': '2' } }));
    const gateway = new ChatCompletionsGateway(options('https://provider.example/v1'), fetcher);

    await expect(gateway.complete({ messages: [{ role: 'user', content: 'hello' }] }))
      .rejects.toMatchObject({ code: 'MODEL_HTTP_ERROR', status, retryable, retryAfterMs: 2000 });
    await expect(gateway.complete({ messages: [{ role: 'user', content: 'hello' }] })).rejects.not.toThrow('private provider response');
  });

  it('parses Retry-After seconds and HTTP dates without accepting invalid values', () => {
    const now = Date.parse('2026-10-25T00:00:00.000Z');
    expect(parseRetryAfterMs('2', now)).toBe(2000);
    expect(parseRetryAfterMs('Sun, 25 Oct 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfterMs('yesterday', now)).toBeUndefined();
  });

  it('rejects invalid frames and empty streams while returning malformed tool arguments for guarded runtime recovery', async () => {
    const invalidJson = new ChatCompletionsGateway(options('https://provider.example/v1'), vi.fn<typeof fetch>().mockResolvedValue(streamResponse(['{bad-json'])));
    await expect(invalidJson.complete({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toMatchObject({ code: 'MODEL_STREAM_ERROR' });

    const incompleteCall = new ChatCompletionsGateway(options('https://provider.example/v1'), vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { id: 'partial_call', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'lookup', arguments: '{"room":' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ])));
    await expect(incompleteCall.complete({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toMatchObject({
      toolCalls: [{ id: 'call', name: 'lookup', arguments: '{"room":' }],
      finishReason: 'tool_calls',
    });

    const empty = new ChatCompletionsGateway(options('https://provider.example/v1'), vi.fn<typeof fetch>().mockResolvedValue(streamResponse(['[DONE]'])));
    await expect(empty.complete({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toMatchObject({ code: 'MODEL_STREAM_ERROR' });
  });

  it('preserves caller cancellation instead of reporting it as a timeout', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('caller cancelled')), { once: true });
    }));
    const pending = new ChatCompletionsGateway(options('https://provider.example/v1'), fetcher)
      .complete({ messages: [{ role: 'user', content: 'hello' }], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('caller cancelled');
  });
});

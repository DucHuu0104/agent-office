import { ModelGatewayError, parseRetryAfterMs, type ChatCompletion, type ChatGatewayOptions, type ModelGateway, type ModelRequest, type ModelUsage } from './types';
import { ReasoningMarkupFilter } from './reasoning-markup';

export { ModelGatewayError } from './types';
export type { ChatCompletion, ChatGatewayOptions, ChatMessage, ChatRole, ChatTool, ModelUsage } from './types';

export class ChatCompletionsGateway implements ModelGateway {
  constructor(private readonly options: ChatGatewayOptions, private readonly fetcher: typeof fetch = fetch) {}

  assertConfigured(): void {
    if (!this.options.apiKey || !this.options.model) throw new ModelGatewayError('MODEL_NOT_CONFIGURED', 'Chưa cấu hình model. Hãy kiểm tra các biến MODEL_* trong .env.');
    let endpoint: URL;
    try { endpoint = new URL(this.options.baseUrl); }
    catch { throw new ModelGatewayError('MODEL_ENDPOINT_INVALID', 'Model endpoint phải là URL hợp lệ.'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname.toLowerCase());
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
      throw new ModelGatewayError('MODEL_ENDPOINT_INVALID', 'Model endpoint phải dùng HTTPS; HTTP chỉ được phép cho model loopback.');
    }
  }

  async complete(input: ModelRequest): Promise<ChatCompletion> {
    this.assertConfigured();
    const { baseUrl, apiKey, model } = this.options;
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const timeout = AbortSignal.timeout(this.options.timeoutSeconds * 1000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          model,
          messages: input.messages.map((message) => { const copy = { ...message }; delete copy.providerItems; return copy; }),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: this.options.maxOutputTokens,
          ...(input.tools?.length ? { tools: input.tools, tool_choice: input.toolChoice ?? 'auto' } : {}),
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        if (input.signal?.aborted) throw error;
        throw new ModelGatewayError('MODEL_TIMEOUT', 'Model không phản hồi trong thời hạn cấu hình.');
      }
      throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Không kết nối được với model endpoint.', undefined, true);
    }
    if (!response.ok) {
      const status = response.status;
      try { await response.body?.cancel(); } catch { /* stream đã đóng */ }
      throw new ModelGatewayError('MODEL_HTTP_ERROR', `Model endpoint trả HTTP ${status}. Kiểm tra URL, model và quyền truy cập.`, status, undefined, parseRetryAfterMs(response.headers.get('retry-after')));
    }
    if (!response.body) throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model endpoint không trả stream dữ liệu.');

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const reasoningFilter = new ReasoningMarkupFilter();
    let buffer = '';
    let content = '';
    let id = '';
    let finishReason: string | null = null;
    let usage: ModelUsage | null = null;
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let splitAt: number;
        while ((splitAt = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          let chunk: any;
          try { chunk = JSON.parse(data); } catch { throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model stream chứa JSON không hợp lệ.'); }
          if (typeof chunk.id === 'string') id = chunk.id;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (typeof delta?.content === 'string' && delta.content) {
            const visible = reasoningFilter.push(delta.content);
            if (visible) {
              content += visible;
              input.onTextDelta?.(visible);
            }
          }
          if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
          for (const part of delta?.tool_calls ?? []) {
            const index = Number(part.index);
            if (!Number.isInteger(index) || index < 0) continue;
            const call = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
            if (typeof part.id === 'string') call.id += part.id;
            if (typeof part.function?.name === 'string') call.name += part.function.name;
            if (typeof part.function?.arguments === 'string') call.arguments += part.function.arguments;
            toolCalls.set(index, call);
          }
          const u = chunk.usage;
          if (u && Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens)) {
            usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens };
          }
        }
      }
      const visibleTail = reasoningFilter.finish();
      if (visibleTail) {
        content += visibleTail;
        input.onTextDelta?.(visibleTail);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof ModelGatewayError) throw error;
      if (signal.aborted && !input.signal?.aborted) throw new ModelGatewayError('MODEL_TIMEOUT', 'Model stream hết thời hạn.');
      throw error;
    } finally {
      reader.releaseLock();
    }
    const completeCalls = [...toolCalls.values()];
    for (const call of completeCalls) {
      if (!call.id || !call.name) throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model trả tool call thiếu ID hoặc tên hàm.');
    }
    if (!id && !content && completeCalls.length === 0) throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model stream kết thúc mà không có nội dung.');
    return { id, content, toolCalls: completeCalls, finishReason, usage };
  }
}

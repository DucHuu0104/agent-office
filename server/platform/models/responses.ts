import { ModelGatewayError, parseRetryAfterMs, type ChatCompletion, type ChatGatewayOptions, type ChatTool, type ModelGateway, type ModelRequest } from './types';
import { ReasoningMarkupFilter, sanitizeProviderItems } from './reasoning-markup';

interface FunctionCallState {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
}

export class ResponsesGateway implements ModelGateway {
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
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/responses`;
    const timeout = AbortSignal.timeout(this.options.timeoutSeconds * 1000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          model,
          input: toResponsesInput(input.messages),
          stream: true,
          store: false,
          include: ['reasoning.encrypted_content'],
          max_output_tokens: this.options.maxOutputTokens,
          ...(input.tools?.length ? { tools: input.tools.map(toResponsesTool), tool_choice: toResponsesToolChoice(input.tools, input.toolChoice ?? 'auto') } : {}),
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
    const calls = new Map<string, FunctionCallState>();
    const reasoningFilter = new ReasoningMarkupFilter();
    let buffer = '';
    let id = '';
    let content = '';
    let finishReason: string | null = null;
    let usage: ChatCompletion['usage'] = null;
    let providerItems: Array<Record<string, unknown>> | undefined;
    let completed = false;
    const appendText = (text: string): void => {
      const visible = reasoningFilter.push(text);
      if (visible) {
        content += visible;
        input.onTextDelta?.(visible);
      }
    };
    const processFrame = (frame: string): void => {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') return;
      let event: any;
      try { event = JSON.parse(data); }
      catch { throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model stream chứa JSON không hợp lệ.'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model stream chứa event không hợp lệ.');
      if (event.type === 'error' || event.type === 'response.failed') throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model response stream báo lỗi trước khi hoàn tất.');
      if (event.type === 'response.created' && typeof event.response?.id === 'string') id = event.response.id;
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        appendText(event.delta);
      }
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        const item = event.item;
        if (item?.type === 'function_call') mergeFunctionCall(calls, event.output_index, item);
        if (event.type === 'response.output_item.done' && item?.type === 'message' && !content) {
          const text = extractOutputText(item.content);
          if (text) appendText(text);
        }
      }
      if (event.type === 'response.function_call_arguments.delta') {
        const itemId = typeof event.item_id === 'string' ? event.item_id : `index:${event.output_index}`;
        const call = calls.get(itemId) ?? { index: Number(event.output_index), itemId, callId: '', name: '', arguments: '' };
        if (typeof event.delta === 'string') call.arguments += event.delta;
        calls.set(itemId, call);
      }
      if (event.type === 'response.function_call_arguments.done') {
        const itemId = typeof event.item_id === 'string' ? event.item_id : `index:${event.output_index}`;
        const call = calls.get(itemId) ?? { index: Number(event.output_index), itemId, callId: '', name: '', arguments: '' };
        if (typeof event.arguments === 'string') call.arguments = event.arguments;
        calls.set(itemId, call);
      }
      if (event.type === 'response.completed') {
        const response = event.response;
        if (typeof response?.id === 'string') id = response.id;
        if (typeof response?.status === 'string') finishReason = response.status;
        if (Array.isArray(response?.output)) providerItems = sanitizeProviderItems(response.output);
        if (!content) {
          const text = extractResponseText(response?.output);
          if (text) appendText(text);
        }
        for (const [index, item] of (response?.output ?? []).entries()) if (item?.type === 'function_call') mergeFunctionCall(calls, index, item);
        const tokenUsage = response?.usage;
        if (tokenUsage && Number.isFinite(tokenUsage.input_tokens) && Number.isFinite(tokenUsage.output_tokens)) {
          usage = {
            promptTokens: tokenUsage.input_tokens,
            completionTokens: tokenUsage.output_tokens,
            totalTokens: Number.isFinite(tokenUsage.total_tokens) ? tokenUsage.total_tokens : tokenUsage.input_tokens + tokenUsage.output_tokens,
          };
        }
        completed = true;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          processFrame(frame);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processFrame(buffer);
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

    if (!completed) throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model stream kết thúc trước response.completed.');
    const toolCalls = [...calls.values()].sort((left, right) => left.index - right.index).map((call) => ({ id: call.callId, name: call.name, arguments: call.arguments }));
    for (const call of toolCalls) {
      if (!call.id || !call.name) throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model trả function call thiếu call_id hoặc tên hàm.');
    }
    if (!id || !content && toolCalls.length === 0) throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Model stream kết thúc mà không có response ID hoặc nội dung.');
    return { id, content, toolCalls, finishReason, usage, ...(providerItems?.length ? { providerItems } : {}) };
  }
}

function toResponsesInput(messages: ModelRequest['messages']): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.providerItems?.length) {
      input.push(...message.providerItems);
      continue;
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Tool output thiếu tool_call_id.');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      continue;
    }
    input.push({ role: message.role, content: message.content ?? '' });
  }
  return input;
}

function toResponsesTool(tool: ChatTool): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }),
  };
}

function toResponsesToolChoice(tools: ChatTool[], choice: NonNullable<ModelRequest['toolChoice']>): string | Record<string, string> {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (!tools.some((tool) => tool.function.name === choice.function.name)) throw new ModelGatewayError('MODEL_STREAM_ERROR', 'Tool choice tham chiếu function không được khai báo.');
  return { type: 'function', name: choice.function.name };
}

function mergeFunctionCall(calls: Map<string, FunctionCallState>, indexValue: unknown, item: any): void {
  const index = Number(indexValue);
  const itemId = typeof item.id === 'string' ? item.id : `index:${index}`;
  const call = calls.get(itemId) ?? { index, itemId, callId: '', name: '', arguments: '' };
  if (Number.isInteger(index) && index >= 0) call.index = index;
  if (typeof item.call_id === 'string') call.callId = item.call_id;
  if (typeof item.name === 'string') call.name = item.name;
  if (typeof item.arguments === 'string') call.arguments = item.arguments;
  calls.set(itemId, call);
}

function extractOutputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'output_text' && typeof part.text === 'string').map((part) => part.text as string).join('');
}

function extractResponseText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  return output.filter((item) => item?.type === 'message').map((item) => extractOutputText(item.content)).join('');
}


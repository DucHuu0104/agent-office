export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  providerItems?: Array<Record<string, unknown>>;
}

export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
}

export interface ModelUsage { promptTokens: number; completionTokens: number; totalTokens: number }

export interface ChatCompletion {
  id: string;
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: ModelUsage | null;
  providerItems?: Array<Record<string, unknown>>;
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools?: ChatTool[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

export interface ChatGatewayOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutSeconds: number;
}

export interface ModelGateway {
  assertConfigured(): void;
  complete(input: ModelRequest): Promise<ChatCompletion>;
}

export class ModelGatewayError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: 'MODEL_NOT_CONFIGURED' | 'MODEL_ENDPOINT_INVALID' | 'MODEL_HTTP_ERROR' | 'MODEL_STREAM_ERROR' | 'MODEL_TIMEOUT',
    message: string,
    readonly status?: number,
    retryable?: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelGatewayError';
    this.retryable = retryable ?? (code === 'MODEL_HTTP_ERROR' && (status === 429 || status !== undefined && status >= 500));
  }
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.max(0, Math.ceil(Number(trimmed) * 1000));
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

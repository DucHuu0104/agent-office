import { createHash } from 'node:crypto';
import type { AgentDefinition } from './registry';
import type { AgentHookEvent, HookHandlerId } from './hook-contracts';
import type { EventHub } from './events';
import type { MemoryService } from './memory';
import type { ProjectService } from './projects';
import type { DatabaseClient } from './database';
import { validateMemoryContent } from './memory';

export interface HookContext {
  eventId: string;
  executionId: string;
  runId: string;
  projectId: string;
  taskId?: string;
  agentInstanceId: string;
  data: Record<string, unknown>;
}

export interface HookResult {
  handler: HookHandlerId;
  event: AgentHookEvent;
  result: Record<string, unknown> | null;
}

interface HookServices {
  db: DatabaseClient;
  events: EventHub;
  memory: MemoryService;
  projects: ProjectService;
}

type Handler = (definition: AgentDefinition, context: HookContext, services: HookServices, signal: AbortSignal) => Promise<Record<string, unknown>>;

interface HookOutboxRow {
  hook_id: string;
  event_id: string;
  event: AgentHookEvent;
  handler: HookHandlerId;
  execution_id: string;
  run_id: string;
  project_id: string;
  task_id: string | null;
  agent_instance_id: string;
  payload_json: string | null;
  payload_hash: string;
  timeout_ms: number;
  on_error: 'fail' | 'warn';
  status: 'pending' | 'completed' | 'abandoned';
  attempts: number;
  result_json: string | null;
}

const MAX_DURABLE_DELIVERY_ATTEMPTS = 5;
const DURABLE_HANDLERS = new Set<HookHandlerId>(['policy.audit_intent', 'memory.propose_summary', 'lifecycle.audit']);

const handlers: Record<HookHandlerId, Handler> = {
  'context.load_project': async (_definition, context, services, signal) => {
    if (signal.aborted) throw hookError('HOOK_ABORTED');
    const sequence = context.data.requestSequence;
    const project = await services.projects.projectContext(context.projectId, typeof sequence === 'number' ? sequence : undefined);
    if (!project) throw hookError('PROJECT_NOT_FOUND');
    return { projectContext: project };
  },
  'policy.audit_intent': async (_definition, context, services, signal) => {
    void services;
    if (signal.aborted) throw hookError('HOOK_ABORTED');
    const toolId = context.data.toolId;
    const argumentsHash = context.data.argumentsHash;
    if (typeof toolId !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(toolId) || typeof argumentsHash !== 'string' || !/^[a-f0-9]{64}$/.test(argumentsHash)) {
      throw hookError('HOOK_INVALID_PAYLOAD');
    }
    return { toolId, argumentsHash };
  },
  'memory.propose_summary': async (definition, context, services, signal) => {
    void services;
    if (signal.aborted) throw hookError('HOOK_ABORTED');
    if (!definition.manifest.memoryScopes.includes('project')) return { skipped: 'project_scope_not_granted' };
    if (context.data.outcome !== 'succeeded' || typeof context.data.summary !== 'string') return { skipped: 'run_not_succeeded' };
    return { summary: context.data.summary };
  },
  'lifecycle.audit': async (_definition, context, _services, signal) => {
    if (signal.aborted) throw hookError('HOOK_ABORTED');
    return { metadata: safeLifecycleMetadata(context.eventId, context.data) };
  },
};

export class HookRunner {
  private readonly committed = new Map<string, Promise<Record<string, unknown>>>();

  constructor(private readonly services: HookServices) {}

  /** Replays callbacks whose durable intent was committed before the process stopped. */
  async replayPending(): Promise<void> {
    const pending = await this.services.db.all<HookOutboxRow>(`SELECT * FROM hook_outbox WHERE status = 'pending' ORDER BY created_at, hook_id`);
    for (const delivery of pending) {
      try {
        if (!DURABLE_HANDLERS.has(delivery.handler) || !delivery.payload_json) throw hookError('HOOK_INVALID_PAYLOAD');
        const context = contextFromDelivery(delivery);
        const definition = replayDefinition(delivery.handler, delivery.payload_json);
        await this.runDurableDelivery(delivery, definition, context);
      } catch (error) {
        const code = (error as { code?: string })?.code ?? 'HOOK_FAILED';
        if (code === 'HOOK_INVALID_PAYLOAD' || code === 'HOOK_IDEMPOTENCY_CONFLICT') await this.abandonDelivery(delivery.hook_id, code);
        if (delivery.on_error === 'fail') throw Object.assign(new Error(`Pending agent hook could not be replayed: ${delivery.handler} (${code}).`), { code });
        console.warn(`[office hook] pending ${delivery.handler} replay failed (${code}); continuing by policy.`);
      }
    }
  }

  async dispatch(definition: AgentDefinition, event: AgentHookEvent, context: HookContext, parentSignal?: AbortSignal): Promise<HookResult[]> {
    const configured = definition.hooks.hooks[event] ?? [];
    const results: HookResult[] = [];
    for (const hook of configured) {
      if (parentSignal?.aborted) throw hookError('HOOK_ABORTED');
      const controller = new AbortController();
      const relayAbort = () => controller.abort(parentSignal?.reason ?? hookError('HOOK_ABORTED'));
      parentSignal?.addEventListener('abort', relayAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timeout: Promise<never>;
      timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = hookError('HOOK_TIMEOUT');
          controller.abort(error);
          reject(error);
        }, hook.timeoutMs);
      });
      const hookContext = { ...context, data: { ...context.data, lifecycleEvent: event } };
      let delivery: HookOutboxRow | null = null;
      try {
        let committed: Record<string, unknown>;
        if (DURABLE_HANDLERS.has(hook.handler) && durablePayload(hook.handler, definition, hookContext)) {
          delivery = await this.ensureDelivery(hook.handler, event, hookContext, definition, hook.timeoutMs, hook.onError);
          if (delivery.status === 'completed') {
            committed = parseResult(delivery.result_json);
          } else {
            committed = await this.runDurableDelivery(delivery, definition, hookContext, controller.signal, timeout);
          }
        } else {
          const result = await Promise.race([
            Promise.resolve().then(() => handlers[hook.handler](definition, hookContext, this.services, controller.signal)),
            timeout,
          ]);
          if (parentSignal?.aborted) throw hookError('HOOK_ABORTED');
          committed = await this.commitOnce(hook.handler, hookContext, result, parentSignal);
        }
        if (timer) { clearTimeout(timer); timer = undefined; }
        results.push({ handler: hook.handler, event, result: committed });
      } catch (error) {
        if (delivery && delivery.status === 'pending') await this.failDelivery(delivery.hook_id, (error as { code?: string })?.code ?? 'HOOK_FAILED').catch(() => undefined);
        if (parentSignal?.aborted) throw hookError('HOOK_ABORTED');
        const code = (error as { code?: string })?.code ?? 'HOOK_FAILED';
        if (hook.onError === 'fail') throw Object.assign(new Error(`Agent hook failed: ${hook.handler} (${code}).`), { code });
        console.warn(`[office hook] ${hook.handler} failed for ${event} (${code}); continuing by policy.`);
        results.push({ handler: hook.handler, event, result: null });
      } finally {
        if (timer) clearTimeout(timer);
        parentSignal?.removeEventListener('abort', relayAbort);
        controller.abort();
      }
    }
    return results;
  }

  private async ensureDelivery(handler: HookHandlerId, event: AgentHookEvent, context: HookContext, definition: AgentDefinition, timeoutMs: number, onError: 'fail' | 'warn'): Promise<HookOutboxRow> {
    const payload = durablePayload(handler, definition, context);
    if (!payload) throw hookError('HOOK_INVALID_PAYLOAD');
    const payloadJson = JSON.stringify(payload.data);
    if (Buffer.byteLength(payloadJson, 'utf8') > 64 * 1024) throw hookError('HOOK_INVALID_PAYLOAD');
    const payloadHash = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
    const hookId = durableHookEventId(context.eventId, handler);
    const now = new Date().toISOString();
    await this.services.db.run(`INSERT OR IGNORE INTO hook_outbox(
      hook_id, event_id, event, handler, execution_id, run_id, project_id, task_id, agent_instance_id,
      payload_json, payload_hash, timeout_ms, on_error, status, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`, [
      hookId, context.eventId, event, handler, context.executionId, context.runId, context.projectId, context.taskId ?? null,
      context.agentInstanceId, payloadJson, payloadHash, timeoutMs, onError, now, now,
    ]);
    const row = await this.services.db.one<HookOutboxRow>('SELECT * FROM hook_outbox WHERE hook_id = ?', [hookId]);
    if (!row) throw new Error('Durable hook delivery was not saved.');
    if (row.event_id !== context.eventId || row.event !== event || row.handler !== handler || row.execution_id !== context.executionId ||
      row.run_id !== context.runId || row.project_id !== context.projectId || row.task_id !== (context.taskId ?? null) ||
      row.agent_instance_id !== context.agentInstanceId || row.payload_hash !== payloadHash) {
      throw Object.assign(new Error('Hook idempotency key was reused with different delivery data.'), { code: 'HOOK_IDEMPOTENCY_CONFLICT' });
    }
    if (row.status === 'abandoned') throw Object.assign(new Error('Durable hook delivery exhausted its retry limit.'), { code: 'HOOK_DELIVERY_ABANDONED' });
    return row;
  }

  private async runDurableDelivery(delivery: HookOutboxRow, definition: AgentDefinition, context: HookContext, signal?: AbortSignal, timeout?: Promise<never>): Promise<Record<string, unknown>> {
    if (delivery.status === 'completed') return parseResult(delivery.result_json);
    await this.beginDelivery(delivery.hook_id);
    const localController = signal ? null : new AbortController();
    const activeSignal = signal ?? localController!.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = timeout ?? new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = hookError('HOOK_TIMEOUT');
        localController!.abort(error);
        reject(error);
      }, delivery.timeout_ms);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => handlers[delivery.handler](definition, context, this.services, activeSignal)),
        timedOut,
      ]);
      if (activeSignal.aborted) throw hookError('HOOK_ABORTED');
      const committed = await this.commitOnce(delivery.handler, context, result, activeSignal);
      await this.completeDelivery(delivery.hook_id, committed);
      return committed;
    } catch (error) {
      await this.failDelivery(delivery.hook_id, (error as { code?: string })?.code ?? 'HOOK_FAILED');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async beginDelivery(hookId: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.services.db.batch<unknown[]>([
      { mode: 'run', sql: `UPDATE hook_outbox SET attempts = attempts + 1, updated_at = ? WHERE hook_id = ? AND status = 'pending' AND attempts < ?`, params: [now, hookId, MAX_DURABLE_DELIVERY_ATTEMPTS] },
      { mode: 'get', sql: 'SELECT status, attempts FROM hook_outbox WHERE hook_id = ?', params: [hookId] },
    ], true);
    const updated = (result[0] as { changes?: number } | undefined)?.changes ?? 0;
    const row = result[1] as { status: string; attempts: number } | null;
    if (!row) throw new Error('Durable hook delivery disappeared.');
    if (row.status === 'completed') return;
    if (row.status !== 'pending' || updated !== 1) {
      await this.services.db.run(`UPDATE hook_outbox SET status = 'abandoned', payload_json = NULL, last_error_code = 'HOOK_RETRY_LIMIT', updated_at = ? WHERE hook_id = ? AND status = 'pending'`, [now, hookId]);
      throw Object.assign(new Error('Durable hook delivery exhausted its retry limit.'), { code: 'HOOK_DELIVERY_ABANDONED' });
    }
  }

  private async completeDelivery(hookId: string, result: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    const updated = await this.services.db.run(`UPDATE hook_outbox SET status = 'completed', payload_json = NULL, result_json = ?, last_error_code = NULL, updated_at = ? WHERE hook_id = ? AND status = 'pending'`, [JSON.stringify(result), now, hookId]);
    if (!updated.changes) {
      const row = await this.services.db.one<{ status: string; result_json: string | null }>('SELECT status, result_json FROM hook_outbox WHERE hook_id = ?', [hookId]);
      if (row?.status !== 'completed' || row.result_json !== JSON.stringify(result)) throw new Error('Durable hook delivery completion was not saved.');
    }
  }

  private async failDelivery(hookId: string, code: string): Promise<void> {
    const now = new Date().toISOString();
    await this.services.db.run(`UPDATE hook_outbox SET
      status = CASE WHEN attempts >= ? THEN 'abandoned' ELSE 'pending' END,
      payload_json = CASE WHEN attempts >= ? THEN NULL ELSE payload_json END,
      last_error_code = ?, updated_at = ? WHERE hook_id = ? AND status = 'pending'`,
    [MAX_DURABLE_DELIVERY_ATTEMPTS, MAX_DURABLE_DELIVERY_ATTEMPTS, /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'HOOK_FAILED', now, hookId]);
  }

  private async abandonDelivery(hookId: string, code: string): Promise<void> {
    await this.services.db.run(`UPDATE hook_outbox SET status = 'abandoned', payload_json = NULL, last_error_code = ?, updated_at = ? WHERE hook_id = ? AND status = 'pending'`, [
      /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'HOOK_INVALID_PAYLOAD', new Date().toISOString(), hookId,
    ]);
  }

  private async commitOnce(handler: HookHandlerId, context: HookContext, result: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const key = `${context.eventId}:${handler}`;
    const existing = this.committed.get(key);
    if (existing) return existing;
    const pending = this.commit(handler, context, result, signal);
    this.committed.set(key, pending);
    while (this.committed.size > 5_000) this.committed.delete(this.committed.keys().next().value!);
    try { return await pending; }
    catch (error) {
      if (this.committed.get(key) === pending) this.committed.delete(key);
      throw error;
    }
  }

  private async commit(handler: HookHandlerId, context: HookContext, result: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw hookError('HOOK_ABORTED');
    if (handler === 'lifecycle.audit') {
      if (!result.metadata || typeof result.metadata !== 'object' || Array.isArray(result.metadata)) throw hookError('HOOK_INVALID_RESULT');
      await this.services.events.transactIdempotent(durableHookEventId(context.eventId, handler), 'agent.lifecycle_hook', context.runId, context.projectId, {
        hookEventId: context.eventId, event: context.data.lifecycleEvent, runId: context.runId,
        taskId: context.taskId ?? null, agentInstanceId: context.agentInstanceId, metadata: result.metadata,
      });
      return { recorded: true };
    }
    if (handler === 'policy.audit_intent') {
      await this.services.events.transactIdempotent(durableHookEventId(context.eventId, handler), 'tool.intent_audited', context.executionId, context.projectId, {
        hookEventId: context.eventId, runId: context.runId, taskId: context.taskId ?? null,
        agentInstanceId: context.agentInstanceId, toolId: result.toolId, argumentsHash: result.argumentsHash,
      });
      return { audited: true };
    }
    if (handler === 'memory.propose_summary') {
      if (typeof result.skipped === 'string') return result;
      if (typeof result.summary !== 'string') throw hookError('HOOK_INVALID_RESULT');
      const memory = await this.services.memory.proposeRunSummary({
        projectId: context.projectId, runId: context.runId, coordinatorInstanceId: context.agentInstanceId, content: result.summary,
      }, signal);
      return { memoryId: memory.id, status: memory.status, revision: memory.revision };
    }
    return result;
  }
}

function hookError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function durableHookEventId(eventId: string, handler: HookHandlerId): string {
  return createHash('sha256').update(`agent-hook\0${handler}\0${eventId}`, 'utf8').digest('hex');
}

function durablePayload(handler: HookHandlerId, definition: AgentDefinition, context: HookContext): { data: Record<string, unknown> } | null {
  if (handler === 'lifecycle.audit') return { data: safeLifecycleMetadata(context.eventId, context.data) };
  if (handler === 'policy.audit_intent') {
    const toolId = context.data.toolId;
    const argumentsHash = context.data.argumentsHash;
    if (typeof toolId !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(toolId) || typeof argumentsHash !== 'string' || !/^[a-f0-9]{64}$/.test(argumentsHash)) return null;
    return { data: { toolId, argumentsHash } };
  }
  if (handler === 'memory.propose_summary') {
    const summary = context.data.summary;
    if (!definition.manifest.memoryScopes.includes('project') || context.data.outcome !== 'succeeded' || typeof summary !== 'string') return null;
    try {
      return { data: { outcome: 'succeeded', summary: validateMemoryContent(summary), projectMemoryGranted: true } };
    } catch {
      return null;
    }
  }
  return null;
}

function contextFromDelivery(delivery: HookOutboxRow): HookContext {
  if (!delivery.payload_json) throw Object.assign(new Error('Pending hook payload is missing.'), { code: 'HOOK_INVALID_PAYLOAD' });
  let parsed: unknown;
  try { parsed = JSON.parse(delivery.payload_json); } catch { throw hookError('HOOK_INVALID_PAYLOAD'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw hookError('HOOK_INVALID_PAYLOAD');
  const data = parsed as Record<string, unknown>;
  return {
    eventId: delivery.event_id, executionId: delivery.execution_id, runId: delivery.run_id, projectId: delivery.project_id,
    ...(delivery.task_id ? { taskId: delivery.task_id } : {}), agentInstanceId: delivery.agent_instance_id,
    data: { ...data, lifecycleEvent: delivery.event },
  };
}

function replayDefinition(handler: HookHandlerId, payload: string | null): AgentDefinition {
  const data = payload ? JSON.parse(payload) as Record<string, unknown> : {};
  const memoryScopes = handler === 'memory.propose_summary' && data.projectMemoryGranted === true ? ['project'] : [];
  return { manifest: { memoryScopes } } as AgentDefinition;
}

function parseResult(result: string | null): Record<string, unknown> {
  if (!result) return {};
  const parsed = JSON.parse(result) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Stored hook result is invalid.');
  return parsed as Record<string, unknown>;
}

function safeLifecycleMetadata(eventId: string, data: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = { hookEventId: eventId };
  const addString = (key: string, pattern: RegExp, max = 100) => {
    const value = data[key];
    if (typeof value === 'string' && value.length <= max && pattern.test(value)) metadata[key] = value;
  };
  const addInteger = (key: string, min = 0, max = 1_000_000) => {
    const value = data[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) metadata[key] = value;
  };
  addString('lifecycleEvent', /^[a-z_]{1,40}$/);
  addString('profileId', /^[a-z][a-z0-9-]{0,63}$/);
  addInteger('attempt', 1, 10);
  addInteger('messageCount', 0, 100_000);
  addInteger('toolCount', 0, 1_000);
  addInteger('promptTokens', 0, 10_000_000);
  addInteger('completionTokens', 0, 10_000_000);
  addInteger('toolCallCount', 0, 1_000);
  addInteger('requestSequence', 1, Number.MAX_SAFE_INTEGER);
  addInteger('taskCount', 0, 12);
  addString('outcome', /^(succeeded|failed)$/);
  addString('errorCode', /^[A-Z0-9_]{1,100}$/);
  addString('toolId', /^[a-z][a-z0-9._-]{0,79}$/);
  addString('toolStatus', /^(succeeded|failed)$/);
  addString('argumentsHash', /^[a-f0-9]{64}$/);
  addString('resultHash', /^[a-f0-9]{64}$/);
  if (Array.isArray(data.taskKeys) && data.taskKeys.length <= 12 && data.taskKeys.every((key) => typeof key === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key))) metadata.taskKeys = data.taskKeys;
  if (Array.isArray(data.capabilities) && data.capabilities.length <= 12 && data.capabilities.every((capability) => typeof capability === 'string' && /^[a-z][a-z0-9._-]{0,119}$/.test(capability))) metadata.capabilities = data.capabilities;
  return metadata;
}

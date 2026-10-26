import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../../shared/platform/contracts';
import { eventEnvelopeSchema } from '../../shared/platform/contracts';
import type { DatabaseClient, DbOperation } from './database';

interface EventRow {
  sequence: number;
  event_id: string;
  type: string;
  project_id: string | null;
  aggregate_id: string;
  payload_json: string;
  occurred_at: string;
}

export type EventListener = (event: DomainEvent) => void;
export type TransientListener = (name: string, data: Record<string, unknown>) => void;

export class EventHub {
  private readonly listeners = new Set<EventListener>();
  private readonly transientListeners = new Set<TransientListener>();

  constructor(private readonly db: DatabaseClient, private readonly workspaceId = 'local-workspace') {}

  async transact(type: string, aggregateId: string, projectId: string | null, payload: Record<string, unknown>, operations: DbOperation[] = []): Promise<DomainEvent> {
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    const all: DbOperation[] = [
      ...operations,
      { mode: 'run', sql: 'UPDATE workspaces SET revision = revision + 1 WHERE id = ?', params: [this.workspaceId] },
      { mode: 'run', sql: 'INSERT INTO domain_events(event_id, workspace_id, type, project_id, aggregate_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)', params: [eventId, this.workspaceId, type, projectId, aggregateId, JSON.stringify(payload), occurredAt] },
      { mode: 'get', sql: 'SELECT last_insert_rowid() AS sequence' },
    ];
    const result = await this.db.batch<unknown[]>(all, true);
    const sequence = Number((result.at(-1) as { sequence?: number } | undefined)?.sequence);
    const event = eventEnvelopeSchema.parse({ schemaVersion: 1, eventId, sequence, type, projectId, aggregateId, occurredAt, payload });
    this.emit(event);
    return event;
  }

  /** Commits an event once across retries and server restarts using a caller-stable event ID. */
  async transactIdempotent(eventId: string, type: string, aggregateId: string, projectId: string | null, payload: Record<string, unknown>): Promise<DomainEvent> {
    const occurredAt = new Date().toISOString();
    const result = await this.db.batch<unknown[]>([
      { mode: 'run', sql: `INSERT OR IGNORE INTO domain_events(event_id, workspace_id, type, project_id, aggregate_id, payload_json, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, params: [eventId, this.workspaceId, type, projectId, aggregateId, JSON.stringify(payload), occurredAt] },
      { mode: 'run', sql: 'UPDATE workspaces SET revision = revision + 1 WHERE id = ? AND changes() > 0', params: [this.workspaceId] },
      { mode: 'get', sql: 'SELECT sequence, event_id, type, project_id, aggregate_id, payload_json, occurred_at FROM domain_events WHERE event_id = ?', params: [eventId] },
    ], true);
    const inserted = (result[0] as { changes?: number } | undefined)?.changes === 1;
    const row = result[2] as EventRow | undefined;
    if (!row) throw new Error('Idempotent event commit did not produce a durable event.');
    const eventPayload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (row.type !== type || row.aggregate_id !== aggregateId || row.project_id !== projectId || JSON.stringify(eventPayload) !== JSON.stringify(payload)) {
      throw Object.assign(new Error('Idempotency key was reused for a different event.'), { code: 'EVENT_IDEMPOTENCY_CONFLICT' });
    }
    const event = eventEnvelopeSchema.parse({
      schemaVersion: 1, eventId: row.event_id, sequence: row.sequence, type: row.type,
      projectId: row.project_id, aggregateId: row.aggregate_id, occurredAt: row.occurred_at, payload: eventPayload,
    });
    if (inserted) this.emit(event);
    return event;
  }

  async transactConditional(type: string, aggregateId: string, projectId: string | null, payload: Record<string, unknown>, operations: DbOperation[]): Promise<DomainEvent> {
    if (!operations.length || operations[0]!.mode !== 'run') throw new Error('Conditional event transaction needs a guarded write as its first operation.');
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    const all: DbOperation[] = [
      operations[0]!,
      { mode: 'assert_changes', sql: 'SELECT changes() AS changes' },
      { mode: 'run', sql: 'UPDATE workspaces SET revision = revision + 1 WHERE id = ?', params: [this.workspaceId] },
      { mode: 'run', sql: 'INSERT INTO domain_events(event_id, workspace_id, type, project_id, aggregate_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)', params: [eventId, this.workspaceId, type, projectId, aggregateId, JSON.stringify(payload), occurredAt] },
      { mode: 'get', sql: 'SELECT last_insert_rowid() AS sequence' },
      ...operations.slice(1),
    ];
    let result: unknown[];
    try {
      result = await this.db.batch<unknown[]>(all, true);
    } catch (error) {
      if ((error as { code?: string }).code === 'REVISION_CONFLICT') {
        throw Object.assign(new Error('Dữ liệu đã thay đổi; hãy tải lại rồi thử lại.'), { status: 409, code: 'REVISION_CONFLICT' });
      }
      throw error;
    }
    const guardedWrite = result[0] as { changes?: number } | undefined;
    if (!guardedWrite?.changes) throw Object.assign(new Error('Dữ liệu đã thay đổi; hãy tải lại rồi thử lại.'), { status: 409, code: 'REVISION_CONFLICT' });
    const sequence = Number((result[4] as { sequence?: number } | undefined)?.sequence);
    const event = eventEnvelopeSchema.parse({ schemaVersion: 1, eventId, sequence, type, projectId, aggregateId, occurredAt, payload });
    this.emit(event);
    return event;
  }

  async listSince(sequence: number, limit = 1000): Promise<DomainEvent[]> {
    const rows = await this.db.all<EventRow>(
      'SELECT sequence, event_id, type, project_id, aggregate_id, payload_json, occurred_at FROM domain_events WHERE workspace_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
      [this.workspaceId, sequence, Math.max(1, Math.min(5000, limit))],
    );
    return rows.map((row) => eventEnvelopeSchema.parse({
      schemaVersion: 1,
      eventId: row.event_id,
      sequence: row.sequence,
      type: row.type,
      projectId: row.project_id,
      aggregateId: row.aggregate_id,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json),
    }));
  }

  onEvent(listener: EventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onTransient(listener: TransientListener): () => void { this.transientListeners.add(listener); return () => this.transientListeners.delete(listener); }

  transient(name: string, data: Record<string, unknown>): void {
    for (const listener of this.transientListeners) {
      try { listener(name, data); } catch (error) { console.error('[office events] transient subscriber failed:', error instanceof Error ? error.message : 'unknown'); }
    }
  }

  private emit(event: DomainEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { console.error('[office events] subscriber failed:', error instanceof Error ? error.message : 'unknown'); }
    }
  }
}

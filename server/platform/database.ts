import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

export type DbOperation = { mode: 'exec' | 'run' | 'get' | 'all'; sql: string; params?: unknown[] } | { mode: 'assert_changes'; sql: string; params?: unknown[] };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class DatabaseClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly worker: Worker;

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.on('message', (message: { id: number; ok: boolean; result?: unknown; error?: { message?: string; code?: string } }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Object.assign(new Error(message.error?.message ?? 'Database operation failed.'), { code: message.error?.code }));
    });
    worker.on('error', (error) => this.rejectAll(error));
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) this.rejectAll(new Error(`DB worker stopped (${code}).`));
    });
  }

  static async open(dataDir: string, development: boolean): Promise<DatabaseClient> {
    return this.connect(dataDir, development, false);
  }

  static async openReadOnly(dataDir: string, development: boolean): Promise<DatabaseClient> {
    return this.connect(dataDir, development, true);
  }

  private static async connect(dataDir: string, development: boolean, readonly: boolean): Promise<DatabaseClient> {
    const workerPath = development ? new URL('./db-worker-loader.mjs', import.meta.url) : new URL('./platform/db-worker.js', import.meta.url);
    const worker = new Worker(workerPath, { name: 'agent-office-db' });
    const client = new DatabaseClient(worker);
    try {
      await client.request({ kind: 'init', file: join(dataDir, 'agent-office.sqlite'), readonly });
    } catch (error) {
      client.closed = true;
      await worker.terminate();
      throw error;
    }
    return client;
  }

  async batch<T = unknown[]>(operations: DbOperation[], transaction = false): Promise<T> {
    return this.request({ kind: 'batch', operations, transaction }) as Promise<T>;
  }

  async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const [result] = await this.batch<[T | null]>([{ mode: 'get', sql, params }]);
    return result;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [result] = await this.batch<[T[]]>([{ mode: 'all', sql, params }]);
    return result;
  }

  async backup(file: string): Promise<void> {
    await this.request({ kind: 'backup', file });
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const [result] = await this.batch<[{ changes: number; lastInsertRowid: number | bigint }]>([{ mode: 'run', sql, params }]);
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.request({ kind: 'close' });
    this.closed = true;
    await this.worker.terminate();
  }

  private request(request: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Database is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...request });
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

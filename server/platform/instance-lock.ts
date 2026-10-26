import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface InstanceLock {
  release(): void;
}

export function acquireInstanceLock(dataDir: string, busyTimeoutMs = 1_000): InstanceLock {
  mkdirSync(dataDir, { recursive: true });
  const database = new Database(join(dataDir, 'instance-lock.sqlite'));
  database.pragma(`busy_timeout = ${Math.max(0, Math.min(10_000, Math.floor(busyTimeoutMs)))}`);
  try {
    database.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    database.close();
    const code = (error as { code?: string }).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      throw Object.assign(new Error('Agent Office is already running with this data directory.'), { code: 'OFFICE_ALREADY_RUNNING' });
    }
    throw error;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try { database.exec('ROLLBACK'); }
      finally { database.close(); }
    },
  };
}

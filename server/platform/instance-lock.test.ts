import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, type InstanceLock } from './instance-lock';

describe('platform instance lock', () => {
  let dataDir: string;
  const locks: InstanceLock[] = [];

  afterEach(async () => {
    for (const lock of locks.splice(0)) lock.release();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('allows only one server lock per data directory and releases it cleanly', () => {
    dataDir = join(tmpdir(), `agent-office-instance-${process.pid}-${Date.now()}`);
    const first = acquireInstanceLock(dataDir, 50);
    locks.push(first);

    expect(() => acquireInstanceLock(dataDir, 50)).toThrow(/already running/);
    first.release();
    const next = acquireInstanceLock(dataDir, 50);
    locks.push(next);
    expect(() => acquireInstanceLock(dataDir, 50)).toThrow(/already running/);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseClient } from './database';
import { EventHub } from './events';

describe('durable event transactions', () => {
  let dataDir: string;
  let db: DatabaseClient;

  afterEach(async () => {
    if (db) await db.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('rolls back domain writes, workspace revision, and event publication together', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-events-rollback-'));
    db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const observed: string[] = [];
    events.onEvent((event) => observed.push(event.type));
    const before = await db.one<{ name: string; revision: number }>("SELECT name, revision FROM workspaces WHERE id = 'local-workspace'");

    await expect(events.transact('test.rollback', 'aggregate-a', null, { value: 1 }, [
      { mode: 'run', sql: "UPDATE workspaces SET name = 'must roll back' WHERE id = 'local-workspace'" },
      { mode: 'run', sql: "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (10, 'duplicate-version', 'now')" },
    ])).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });

    expect(await db.one<{ name: string; revision: number }>("SELECT name, revision FROM workspaces WHERE id = 'local-workspace'")).toEqual(before);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'test.rollback'")).toEqual({ count: 0 });
    expect(observed).toEqual([]);
  });

  it('does not publish an event or mutate projections when a conditional transaction loses its race', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-events-cas-'));
    db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const observed: string[] = [];
    events.onEvent((event) => observed.push(event.type));
    const before = await db.one<{ name: string; revision: number }>("SELECT name, revision FROM workspaces WHERE id = 'local-workspace'");

    await expect(events.transactConditional('test.stale', 'aggregate-a', null, {}, [
      { mode: 'run', sql: "UPDATE workspaces SET name = 'stale write' WHERE id = 'local-workspace' AND revision = -1" },
      { mode: 'run', sql: "UPDATE workspaces SET name = 'unguarded stale side effect' WHERE id = 'local-workspace'" },
    ])).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });

    expect(await db.one<{ name: string; revision: number }>("SELECT name, revision FROM workspaces WHERE id = 'local-workspace'")).toEqual(before);
    expect(await events.listSince(0)).toEqual([]);
    expect(observed).toEqual([]);
  });

  it('commits its event when the guarded write succeeds but a later optional projection changes no rows', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-events-conditional-followups-'));
    db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const observed: string[] = [];
    events.onEvent((event) => observed.push(event.type));

    const committed = await events.transactConditional('test.conditional', 'aggregate-a', null, { value: 1 }, [
      { mode: 'run', sql: "UPDATE workspaces SET name = 'guarded update' WHERE id = 'local-workspace'" },
      { mode: 'run', sql: "UPDATE projects SET updated_at = 'never' WHERE id = 'missing-project'" },
    ]);

    expect(await events.listSince(0)).toContainEqual(committed);
    expect(observed).toEqual(['test.conditional']);
    expect(await db.one<{ name: string }>("SELECT name FROM workspaces WHERE id = 'local-workspace'")).toEqual({ name: 'guarded update' });
  });

  it('replays committed events in sequence after reopening the database', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-events-replay-'));
    db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const observed: number[] = [];
    events.onEvent((event) => observed.push(event.sequence));
    const committed = await events.transact('test.replay', 'aggregate-a', null, { text: 'persisted' }, [
      { mode: 'run', sql: "UPDATE workspaces SET name = 'persisted' WHERE id = 'local-workspace'" },
    ]);
    expect(observed).toEqual([committed.sequence]);

    await db.close();
    db = await DatabaseClient.open(dataDir, true);
    const replayed = await new EventHub(db).listSince(0);
    expect(replayed).toContainEqual(committed);
    expect(await new EventHub(db).listSince(committed.sequence)).toEqual([]);
  });

  it('deduplicates a stable event across database reopen and rejects a key reused for different content', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-events-idempotent-'));
    db = await DatabaseClient.open(dataDir, true);
    const firstHub = new EventHub(db);
    const observed: number[] = [];
    firstHub.onEvent((event) => observed.push(event.sequence));
    const before = await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'");
    const first = await firstHub.transactIdempotent('stable-hook-event', 'agent.lifecycle_hook', 'run-a', null, { hookEventId: 'hook-a', event: 'after_run' });
    expect(observed).toEqual([first.sequence]);
    expect((await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'"))?.revision).toBe((before?.revision ?? 0) + 1);

    await db.close();
    db = await DatabaseClient.open(dataDir, true);
    const restartedHub = new EventHub(db);
    const replayed = await restartedHub.transactIdempotent('stable-hook-event', 'agent.lifecycle_hook', 'run-a', null, { hookEventId: 'hook-a', event: 'after_run' });
    expect(replayed).toEqual(first);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE event_id = 'stable-hook-event'")).toEqual({ count: 1 });
    await expect(restartedHub.transactIdempotent('stable-hook-event', 'agent.lifecycle_hook', 'run-a', null, { hookEventId: 'hook-a', event: 'on_error' }))
      .rejects.toMatchObject({ code: 'EVENT_IDEMPOTENCY_CONFLICT' });
    expect((await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'"))?.revision).toBe((before?.revision ?? 0) + 1);
  });
});

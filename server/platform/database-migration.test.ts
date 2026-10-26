import Database from 'better-sqlite3';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';

describe('schema migration safety', () => {
  let dataDir: string;

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('verifies a pre-migration SQLite backup before applying the next schema', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-migration-backup-'));
    const file = join(dataDir, 'agent-office.sqlite');
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    legacy.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (13, ?, ?)')
      .run('agent-office-schema-v13-test-fixture', '2026-10-25T00:00:00.000Z');
    legacy.exec('CREATE TABLE migration_fixture (value TEXT NOT NULL)');
    legacy.prepare('INSERT INTO migration_fixture(value) VALUES (?)').run('preserve before migration');
    legacy.close();

    const migrated = await DatabaseClient.open(dataDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hook_outbox'")).toEqual({ name: 'hook_outbox' });
    } finally {
      await migrated.close();
    }

    const backupName = (await readdir(dataDir)).find((name) => name.startsWith('agent-office.pre-migration-v13-to-v15-') && name.endsWith('.sqlite'));
    expect(backupName).toBeTruthy();
    const backup = new Database(join(dataDir, backupName!), { readonly: true, fileMustExist: true });
    try {
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 13 });
      expect(backup.prepare('SELECT value FROM migration_fixture').get()).toEqual({ value: 'preserve before migration' });
      expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hook_outbox'").get()).toBeUndefined();
    } finally {
      backup.close();
    }
  });

  it('does not create migration backups for a new or current database', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-migration-current-'));
    const fresh = await DatabaseClient.open(dataDir, true);
    await fresh.close();
    expect((await readdir(dataDir)).filter((name) => name.startsWith('agent-office.pre-migration-'))).toEqual([]);

    const current = new Database(join(dataDir, 'agent-office.sqlite'));
    current.close();
    const reopened = await DatabaseClient.open(dataDir, true);
    await reopened.close();
    expect((await readdir(dataDir)).filter((name) => name.startsWith('agent-office.pre-migration-'))).toEqual([]);
  });

  it('adds a durable user-pause flag to an existing v14 runs table', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-migration-pause-'));
    const file = join(dataDir, 'agent-office.sqlite');
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO runs(id, status) VALUES ('run-v14', 'executing');`);
    legacy.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (14, ?, ?)')
      .run('agent-office-schema-v14-test-fixture', '2026-10-25T00:00:00.000Z');
    legacy.close();

    const migrated = await DatabaseClient.open(dataDir, true);
    try {
      expect(await migrated.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await migrated.one<{ pause_requested: number; pause_reason: string | null }>('SELECT pause_requested, pause_reason FROM runs WHERE id = ?', ['run-v14']))
        .toEqual({ pause_requested: 0, pause_reason: null });
    } finally {
      await migrated.close();
    }
  });

  it('upgrades a populated v14 office, verifies its rollback snapshot, and recovers from it', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-migration-upgrade-recovery-'));
    const registry = await loadRegistry(process.cwd());
    const initial = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(initial);
    const projects = new ProjectService(initial, events, registry);
    await projects.seedRegistry();
    const project = await projects.createProject({ name: 'Upgrade recovery fixture', goal: 'Keep this room through an upgrade.' });
    const message = await projects.createUserMessage(project.id, project.conversationId, 'Keep this request through an upgrade.');
    await initial.close();

    // Model the real v14 shape by removing only the additive v15 pause fields
    // from a fully populated current database.
    const legacy = new Database(join(dataDir, 'agent-office.sqlite'));
    legacy.exec('ALTER TABLE runs DROP COLUMN pause_reason; ALTER TABLE runs DROP COLUMN pause_requested; DELETE FROM schema_migrations WHERE version = 15;');
    expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 14 });
    legacy.close();

    const upgraded = await DatabaseClient.open(dataDir, true);
    try {
      expect(await upgraded.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await upgraded.one<{ name: string }>('SELECT name FROM projects WHERE id = ?', [project.id])).toEqual({ name: project.name });
      expect(await upgraded.one<{ content: string }>('SELECT content FROM messages WHERE id = ?', [message.message.id])).toEqual({ content: 'Keep this request through an upgrade.' });
      expect(await upgraded.one<{ pause_requested: number; pause_reason: string | null }>('SELECT pause_requested, pause_reason FROM runs WHERE id = ?', [message.runId]))
        .toEqual({ pause_requested: 0, pause_reason: null });
    } finally {
      await upgraded.close();
    }

    const backupName = (await readdir(dataDir)).find((name) => name.startsWith('agent-office.pre-migration-v14-to-v15-') && name.endsWith('.sqlite'));
    expect(backupName).toBeTruthy();
    const rollbackDir = join(dataDir, 'rollback');
    await mkdir(rollbackDir);
    await copyFile(join(dataDir, backupName!), join(rollbackDir, 'agent-office.sqlite'));
    const rollbackSnapshot = new Database(join(rollbackDir, 'agent-office.sqlite'), { readonly: true, fileMustExist: true });
    try {
      expect(rollbackSnapshot.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(rollbackSnapshot.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 14 });
      expect(rollbackSnapshot.prepare('SELECT id FROM projects WHERE id = ?').get(project.id)).toEqual({ id: project.id });
      expect(rollbackSnapshot.prepare('SELECT id FROM messages WHERE id = ?').get(message.message.id)).toEqual({ id: message.message.id });
    } finally {
      rollbackSnapshot.close();
    }

    // Restart from the recovered pre-upgrade snapshot and verify that the
    // supported version reapplies the migration without losing office data.
    const recovered = await DatabaseClient.open(rollbackDir, true);
    try {
      expect(await recovered.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')).toEqual({ version: 15 });
      expect(await recovered.one<{ name: string }>('SELECT name FROM projects WHERE id = ?', [project.id])).toEqual({ name: project.name });
      expect(await recovered.one<{ content: string }>('SELECT content FROM messages WHERE id = ?', [message.message.id])).toEqual({ content: 'Keep this request through an upgrade.' });
    } finally {
      await recovered.close();
    }
  });

  it('preserves the original database and verified snapshot when a migration fails', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-migration-rollback-'));
    const file = join(dataDir, 'agent-office.sqlite');
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    legacy.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (13, ?, ?)')
      .run('agent-office-schema-v13-test-fixture', '2026-10-25T00:00:00.000Z');
    legacy.exec('CREATE TABLE migration_fixture (value TEXT NOT NULL)');
    legacy.prepare('INSERT INTO migration_fixture(value) VALUES (?)').run('preserve after failed migration');
    // Force v14 to fail transactionally after its verified snapshot is written.
    legacy.exec('CREATE TABLE hook_outbox (hook_id TEXT PRIMARY KEY, unexpected TEXT NOT NULL)');
    legacy.close();

    await expect(DatabaseClient.open(dataDir, true)).rejects.toThrow(/hook_outbox/i);

    const original = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(original.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(original.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 13 });
      expect(original.prepare('SELECT value FROM migration_fixture').get()).toEqual({ value: 'preserve after failed migration' });
      expect(original.prepare('PRAGMA table_info(hook_outbox)').all()).toHaveLength(2);
    } finally {
      original.close();
    }

    const backupName = (await readdir(dataDir)).find((name) => name.startsWith('agent-office.pre-migration-v13-to-v15-') && name.endsWith('.sqlite'));
    expect(backupName).toBeTruthy();
    const backup = new Database(join(dataDir, backupName!), { readonly: true, fileMustExist: true });
    try {
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 13 });
      expect(backup.prepare('SELECT value FROM migration_fixture').get()).toEqual({ value: 'preserve after failed migration' });
      expect(backup.prepare('PRAGMA table_info(hook_outbox)').all()).toHaveLength(2);
    } finally {
      backup.close();
    }
  });

  it('refuses a database from a newer application version without changing it', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-migration-future-'));
    const file = join(dataDir, 'agent-office.sqlite');
    const future = new Database(file);
    future.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    future.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (16, ?, ?)')
      .run('agent-office-schema-v16-future-fixture', '2026-10-25T00:00:00.000Z');
    future.exec('CREATE TABLE future_fixture (value TEXT NOT NULL)');
    future.prepare('INSERT INTO future_fixture(value) VALUES (?)').run('must not be modified');
    future.close();

    await expect(DatabaseClient.open(dataDir, true)).rejects.toThrow('newer than this application supports');

    const reopened = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(reopened.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 16 });
      expect(reopened.prepare('SELECT value FROM future_fixture').get()).toEqual({ value: 'must not be modified' });
    } finally {
      reopened.close();
    }
    expect((await readdir(dataDir)).filter((name) => name.startsWith('agent-office.pre-migration-'))).toEqual([]);
  });
});

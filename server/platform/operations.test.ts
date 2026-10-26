import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseClient } from './database';
import { ArtifactService } from './artifacts';
import { EventHub } from './events';
import { createBackupBundle, createDatabaseBackup, inspectStorage, restoreBackupBundle, restoreDatabaseBackup } from './operations';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';

async function makeConfiguration(root: string): Promise<string> {
  const configDir = join(root, 'app-config');
  for (const section of ['agents', 'skills', 'config']) {
    await cp(join(process.cwd(), section), join(configDir, section), { recursive: true });
  }
  return configDir;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port for restore smoke test.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface RestoredOfficeSmoke {
  health: Record<string, unknown>;
  office: { snapshot: { projects: unknown[]; agents: Array<Record<string, unknown>> } };
  storage: Awaited<ReturnType<typeof inspectStorage>>;
}

async function startRestoredOffice(dataDir: string, configDir: string): Promise<RestoredOfficeSmoke> {
  const port = await unusedLoopbackPort();
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  Object.assign(childEnv, {
    OFFICE_HOST: '127.0.0.1',
    OFFICE_PORT: String(port),
    OFFICE_DATA_DIR: dataDir,
    OFFICE_CONFIG_DIR: configDir,
    OFFICE_EXECUTION_MODE: 'disabled',
  });
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/platform/index.ts', '--dev'], { cwd: process.cwd(), env: childEnv, windowsHide: true });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-8_000); });
  child.stderr?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-8_000); });
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExit = resolve; });
  child.once('exit', (code, signal) => resolveExit({ code, signal }));
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Restored office exited before health check. ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/platform/v1/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          const health = await response.json() as Record<string, unknown>;
          const officeResponse = await fetch(`http://127.0.0.1:${port}/platform/v1/office`, { signal: AbortSignal.timeout(500) });
          if (!officeResponse.ok) throw new Error(`Restored office snapshot returned HTTP ${officeResponse.status}. ${output}`);
          const office = await officeResponse.json() as RestoredOfficeSmoke['office'];
          const storage = await inspectStorage(dataDir, true);
          return { health, office, storage };
        }
        throw new Error(`Restored office health returned HTTP ${response.status}. ${output}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Restored office health')) throw error;
        await delay(100);
      }
    }
    throw new Error(`Restored office did not become healthy within 10 seconds. ${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const result = await Promise.race([exited, delay(5_000).then(() => null)]);
    if (!result && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([exited, delay(2_000)]);
    }
  }
}

describe('database backup and restore', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('creates a consistent SQLite backup and restores it into a new data directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-backup-'));
    const sourceDir = join(root, 'source');
    const db = await DatabaseClient.open(sourceDir, true);
    try {
      await db.run('CREATE TABLE backup_probe(value TEXT NOT NULL)');
      await db.run('INSERT INTO backup_probe(value) VALUES (?)', ['restored']);

      const backupPath = join(root, 'backup.sqlite');
      const backup = await createDatabaseBackup(sourceDir, backupPath, true);
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM backup_probe')).toEqual({ count: 1 });

      const restoredDir = join(root, 'restored');
      const restored = await restoreDatabaseBackup(backupPath, restoredDir, true);
      const copy = await DatabaseClient.open(restoredDir, true);
      let row: { value: string } | null;
      try { row = await copy.one<{ value: string }>('SELECT value FROM backup_probe'); }
      finally { await copy.close(); }

      expect(backup.path).toBe(backupPath);
      expect(backup.bytes).toBeGreaterThan(0);
      expect(restored.databaseFile).toBe(join(restoredDir, 'agent-office.sqlite'));
      expect(row).toEqual({ value: 'restored' });
    } finally {
      await db.close();
    }
  });

  it('rejects existing destinations and corrupted backups without replacing data', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-restore-reject-'));
    const sourceDir = join(root, 'source');
    const db = await DatabaseClient.open(sourceDir, true);
    await db.close();
    const backupPath = join(root, 'backup.sqlite');
    await createDatabaseBackup(sourceDir, backupPath, true);

    await expect(createDatabaseBackup(sourceDir, backupPath, true)).rejects.toThrow('already exists');
    await expect(restoreDatabaseBackup(backupPath, sourceDir, true)).rejects.toThrow('already exists');

    const brokenBackup = join(root, 'broken.sqlite');
    await writeFile(brokenBackup, 'not a SQLite database');
    const failedTarget = join(root, 'failed-restore');
    await expect(restoreDatabaseBackup(brokenBackup, failedTarget, true)).rejects.toThrow();
    await expect(readFile(join(failedTarget, 'agent-office.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('complete backup bundle', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('restores the database, artifact bytes and agent registry into a portable directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-bundle-'));
    const dataDir = join(root, 'source-data');
    const configDir = await makeConfiguration(root);
    await writeFile(join(configDir, '.env'), 'MODEL_PRIMARY_API_KEY=do-not-copy');
    const registry = await loadRegistry(configDir);
    const db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    const project = await projects.createProject({ name: 'Backup fixture', goal: 'Verify complete restore.' });
    const artifacts = new ArtifactService(db, events, dataDir);
    const artifact = await artifacts.create({ projectId: project.id, taskId: null, name: 'handoff.md', content: '# Handoff\nRestored exactly.\n' });
    await db.close();

    const bundlePath = join(root, 'backup.aobackup');
    const backup = await createBackupBundle(dataDir, bundlePath, configDir, true);
    const restoredPath = join(root, 'restored-data');
    const restored = await restoreBackupBundle(bundlePath, restoredPath, true);
    const restoredDb = await DatabaseClient.open(restoredPath, true);
    let restoredArtifact: Awaited<ReturnType<ArtifactService['content']>>;
    try { restoredArtifact = await new ArtifactService(restoredDb, new EventHub(restoredDb), restoredPath).content(artifact.versionId); }
    finally { await restoredDb.close(); }

    expect(backup.fileCount).toBeGreaterThan(1);
    expect(backup.configRevision).toBe(registry.revision);
    expect(restored.configDir).toBe(join(restoredPath, 'configuration'));
    expect((await loadRegistry(restored.configDir)).revision).toBe(registry.revision);
    expect(restoredArtifact?.content.toString('utf8')).toBe('# Handoff\nRestored exactly.\n');
    await expect(stat(join(restored.configDir, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    const smoke = await startRestoredOffice(restored.dataDir, restored.configDir);
    expect(smoke.health).toMatchObject({ ok: true, storage: { ready: true }, runtime: { ready: true }, registryRevision: registry.revision });
    expect(smoke.office.snapshot.projects).toHaveLength(1);
    expect(smoke.office.snapshot.agents.some((agent) => agent.role === 'coordinator')).toBe(true);
    expect(smoke.storage).toMatchObject({ integrity: 'ok', requiredTables: 'ok', foreignKeyViolations: 0 });
  }, 20_000);

  it('rejects secrets during backup and tampered payloads during restore', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-bundle-reject-'));
    const dataDir = join(root, 'source-data');
    const configDir = await makeConfiguration(root);
    const db = await DatabaseClient.open(dataDir, true);
    await db.close();

    const modelsPath = join(configDir, 'config', 'models.yaml');
    const safeModels = await readFile(modelsPath, 'utf8');
    await writeFile(modelsPath, `${safeModels}\n# apiKey = sk-proj-1234567890abcdefghijklmnop\n`);
    const secretBackup = join(root, 'secret.aobackup');
    await expect(createBackupBundle(dataDir, secretBackup, configDir, true)).rejects.toThrow('appears to contain a secret');
    await expect(stat(secretBackup)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(modelsPath, safeModels);

    const bundlePath = join(root, 'valid.aobackup');
    await createBackupBundle(dataDir, bundlePath, configDir, true);
    await writeFile(join(bundlePath, 'database', 'agent-office.sqlite'), 'tampered');
    const target = join(root, 'must-not-exist');
    await expect(restoreBackupBundle(bundlePath, target, true)).rejects.toThrow('checksum mismatch');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

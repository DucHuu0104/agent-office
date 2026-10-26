import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';

describe('artifact write recovery', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let artifacts: ArtifactService;
  let projectId: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-artifact-recovery-'));
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    const projects = new ProjectService(db, events, await loadRegistry(process.cwd()));
    await projects.seedRegistry();
    projectId = (await projects.createProject({ name: 'Artifact recovery', goal: '' })).id;
    artifacts = new ArtifactService(db, events, dataDir);
  });

  afterEach(async () => {
    await db?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('removes uncommitted artifact files only after the recovery grace period', async () => {
    const versionId = randomUUID();
    const storageKey = `${versionId}.md`;
    const artifactsDir = join(dataDir, 'artifacts');
    const journalDir = join(artifactsDir, '.pending');
    const blob = join(artifactsDir, storageKey);
    const temp = `${blob}.tmp`;
    const journal = join(journalDir, `${versionId}.json`);
    await mkdir(journalDir, { recursive: true });
    await writeFile(blob, 'orphaned artifact');
    await writeFile(temp, 'interrupted temporary write');
    await writeFile(journal, JSON.stringify({
      formatVersion: 1,
      versionId,
      storageKey,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }));

    expect(await artifacts.recoverOrphans()).toBe(1);
    await expect(readFile(blob)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(temp)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM artifact_versions WHERE id = ?', [versionId])).toEqual({ count: 0 });
  });

  it('rejects oversized artifacts before creating storage or metadata', async () => {
    await expect(artifacts.create({ projectId, taskId: null, name: 'too-large.txt', content: 'x'.repeat(1_000_001) }))
      .rejects.toThrow('1 MB');
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM artifacts WHERE project_id = ?', [projectId])).toEqual({ count: 0 });
    await expect(lstat(join(dataDir, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps committed bytes after a lost database acknowledgement and clears the journal on recovery', async () => {
    const originalTransact = events.transact.bind(events);
    vi.spyOn(events, 'transact').mockImplementation(async (type, aggregateId, relatedProjectId, payload, operations) => {
      await originalTransact(type, aggregateId, relatedProjectId, payload, operations);
      throw new Error('injected lost database acknowledgement');
    });

    await expect(artifacts.create({ projectId, taskId: null, name: 'report.md', content: 'Committed artifact bytes.' }))
      .rejects.toThrow('injected lost database acknowledgement');
    const row = await db.one<{ id: string; storage_key: string }>(`SELECT version.id, version.storage_key FROM artifact_versions version
      JOIN artifacts artifact ON artifact.id = version.artifact_id WHERE artifact.project_id = ?`, [projectId]);
    expect(row).toBeTruthy();
    const journal = join(dataDir, 'artifacts', '.pending', `${row!.id}.json`);
    await expect(readFile(journal, 'utf8')).resolves.toContain(row!.storage_key);

    expect(await artifacts.recoverOrphans()).toBe(1);

    await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = await artifacts.content(row!.id);
    expect(recovered?.content.toString('utf8')).toBe('Committed artifact bytes.');
  });

  it('preserves the recovery journal when a committed artifact no longer matches its checksum', async () => {
    const created = await artifacts.create({ projectId, taskId: null, name: 'verified.md', content: 'Original artifact.' });
    const storageKey = `${created.versionId}.md`;
    const blob = join(dataDir, 'artifacts', storageKey);
    const journal = join(dataDir, 'artifacts', '.pending', `${created.versionId}.json`);
    await writeFile(blob, 'unexpected bytes');
    await writeFile(journal, JSON.stringify({
      formatVersion: 1,
      versionId: created.versionId,
      storageKey,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }));

    expect(await artifacts.recoverOrphans()).toBe(0);
    await expect(readFile(journal, 'utf8')).resolves.toContain(storageKey);
    await expect(artifacts.content(created.versionId)).rejects.toThrow('checksum');
  });

  it('leaves an uncommitted artifact alone until its journal is older than the grace period', async () => {
    const versionId = randomUUID();
    const storageKey = `${versionId}.csv`;
    const artifactsDir = join(dataDir, 'artifacts');
    const journalDir = join(artifactsDir, '.pending');
    const blob = join(artifactsDir, storageKey);
    const journal = join(journalDir, `${versionId}.json`);
    const createdAt = new Date();
    await mkdir(journalDir, { recursive: true });
    await writeFile(blob, 'keep briefly');
    await writeFile(journal, JSON.stringify({ formatVersion: 1, versionId, storageKey, createdAt: createdAt.toISOString() }));

    expect(await artifacts.recoverOrphans(new Date(createdAt.getTime() + 30 * 60 * 1000))).toBe(0);
    await expect(readFile(blob, 'utf8')).resolves.toBe('keep briefly');
    expect(await artifacts.recoverOrphans(new Date(createdAt.getTime() + 2 * 60 * 60 * 1000))).toBe(1);
    await expect(readFile(blob)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

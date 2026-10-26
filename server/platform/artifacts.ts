import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import type { DatabaseClient } from './database';
import { EventHub } from './events';

const ARTIFACT_ORPHAN_GRACE_MS = 60 * 60 * 1000;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface ArtifactInfo {
  id: string;
  versionId: string;
  projectId: string;
  logicalName: string;
  mimeType: string;
  checksum: string;
  sizeBytes: number;
  createdAt: string;
}

export class ArtifactService {
  private readonly root: string;
  private readonly journalRoot: string;
  private readonly pendingWrites = new Set<string>();

  constructor(private readonly db: DatabaseClient, private readonly events: EventHub, dataDir: string) {
    this.root = resolve(dataDir, 'artifacts');
    this.journalRoot = resolve(this.root, '.pending');
  }

  async create(input: { projectId: string; taskId: string | null; name: string; content: string; mimeType?: string }): Promise<ArtifactInfo> {
    if (Buffer.byteLength(input.content, 'utf8') > 1_000_000) throw new Error('Artifact vượt giới hạn 1 MB.');
    const name = sanitizeName(input.name);
    const mimeType = safeMime(input.mimeType, extname(name));
    const id = randomUUID();
    const versionId = randomUUID();
    const storageKey = `${versionId}${extname(name) || '.txt'}`;
    const destination = resolve(this.root, storageKey);
    const destinationRelative = relative(this.root, destination);
    if (isAbsolute(destinationRelative) || destinationRelative.startsWith('..')) throw new Error('Đường dẫn artifact không hợp lệ.');
    await ensureDirectory(this.root);
    await ensureDirectory(this.journalRoot);
    const temp = `${destination}.tmp`;
    const journalPath = resolve(this.journalRoot, `${versionId}.json`);
    const journalRelative = relative(this.journalRoot, journalPath);
    if (isAbsolute(journalRelative) || journalRelative.startsWith('..')) throw new Error('Artifact journal path is invalid.');
    const journal = JSON.stringify({ formatVersion: 1, versionId, storageKey, createdAt: new Date().toISOString() });
    await writeFile(journalPath, journal, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    this.pendingWrites.add(versionId);
    const checksum = createHash('sha256').update(input.content, 'utf8').digest('hex');
    const createdAt = new Date().toISOString();
    let blobRenamed = false;
    let databaseWriteAttempted = false;
    try {
      await writeFile(temp, input.content, { encoding: 'utf8', flag: 'wx' });
      await rename(temp, destination);
      blobRenamed = true;
      databaseWriteAttempted = true;
      await this.events.transact('artifact.version_created', versionId, input.projectId, { artifactId: id, versionId, logicalName: name, checksum }, [
        { mode: 'run', sql: 'INSERT INTO artifacts(id, project_id, logical_name, created_at) VALUES (?, ?, ?, ?)', params: [id, input.projectId, name, createdAt] },
        { mode: 'run', sql: 'INSERT INTO artifact_versions(id, artifact_id, task_id, storage_key, mime_type, checksum, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params: [versionId, id, input.taskId, storageKey, mimeType, checksum, Buffer.byteLength(input.content, 'utf8'), createdAt] },
      ]);
      await unlink(journalPath).catch(() => undefined);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      if (!databaseWriteAttempted) {
        if (blobRenamed) await unlink(destination).catch(() => undefined);
        await unlink(journalPath).catch(() => undefined);
      }
      throw error;
    } finally {
      this.pendingWrites.delete(versionId);
    }
    return { id, versionId, projectId: input.projectId, logicalName: name, mimeType, checksum, sizeBytes: Buffer.byteLength(input.content, 'utf8'), createdAt };
  }

  /** Reconciles interrupted file writes without deleting a blob while its DB result is uncertain. */
  async recoverOrphans(now = new Date()): Promise<number> {
    const directory = await lstat(this.journalRoot).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!directory) return 0;
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Artifact journal storage is not a regular directory.');
    let recovered = 0;
    for (const entry of await readdir(this.journalRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
      const versionId = entry.name.slice(0, -'.json'.length);
      if (!UUID_PATTERN.test(versionId) || this.pendingWrites.has(versionId)) continue;
      const journalPath = resolve(this.journalRoot, entry.name);
      const raw = await readFile(journalPath, 'utf8').catch(() => null);
      if (raw === null) continue;
      const journal = parseArtifactJournal(raw, versionId);
      if (!journal) continue;

      const committed = await this.db.one<{ storage_key: string; checksum: string; size_bytes: number }>(
        'SELECT storage_key, checksum, size_bytes FROM artifact_versions WHERE id = ?', [versionId],
      );
      if (committed) {
        if (committed.storage_key !== journal.storageKey) continue;
        const destination = resolve(this.root, journal.storageKey);
        const destinationRelative = relative(this.root, destination);
        if (isAbsolute(destinationRelative) || destinationRelative.startsWith('..')) continue;
        const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (!info?.isFile() || info.isSymbolicLink() || info.size !== committed.size_bytes) continue;
        const content = await readFile(destination);
        if (createHash('sha256').update(content).digest('hex') !== committed.checksum) continue;
        await unlink(journalPath).catch(() => undefined);
        recovered++;
        continue;
      }
      const ageMs = now.getTime() - Date.parse(journal.createdAt);
      if (ageMs < ARTIFACT_ORPHAN_GRACE_MS) continue;
      const destination = resolve(this.root, journal.storageKey);
      const destinationRelative = relative(this.root, destination);
      if (isAbsolute(destinationRelative) || destinationRelative.startsWith('..')) continue;
      if (!await unlinkRegularFile(destination) || !await unlinkRegularFile(`${destination}.tmp`)) continue;
      await unlink(journalPath).catch(() => undefined);
      recovered++;
    }
    return recovered;
  }

  async list(projectId: string): Promise<ArtifactInfo[]> {
    const rows = await this.db.all<{ id: string; version_id: string; project_id: string; logical_name: string; mime_type: string; checksum: string; size_bytes: number; created_at: string }>(`SELECT a.id, v.id AS version_id, a.project_id, a.logical_name, v.mime_type, v.checksum, v.size_bytes, v.created_at
      FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id WHERE a.project_id = ? ORDER BY v.created_at DESC`, [projectId]);
    return rows.map((row) => ({ id: row.id, versionId: row.version_id, projectId: row.project_id, logicalName: row.logical_name, mimeType: row.mime_type, checksum: row.checksum, sizeBytes: row.size_bytes, createdAt: row.created_at }));
  }

  async content(versionId: string): Promise<{ info: ArtifactInfo; content: Buffer } | null> {
    const row = await this.db.one<{ id: string; version_id: string; project_id: string; logical_name: string; storage_key: string; mime_type: string; checksum: string; size_bytes: number; created_at: string }>(`SELECT a.id, v.id AS version_id, a.project_id, a.logical_name, v.storage_key, v.mime_type, v.checksum, v.size_bytes, v.created_at
      FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id WHERE v.id = ?`, [versionId]);
    if (!row) return null;
    const path = resolve(this.root, row.storage_key);
    const pathRelative = relative(this.root, path);
    if (isAbsolute(pathRelative) || pathRelative.startsWith('..')) return null;
    const content = await readFile(path);
    const checksum = createHash('sha256').update(content).digest('hex');
    if (checksum !== row.checksum) throw new Error('Artifact checksum không khớp.');
    return { info: { id: row.id, versionId: row.version_id, projectId: row.project_id, logicalName: row.logical_name, mimeType: row.mime_type, checksum: row.checksum, sizeBytes: row.size_bytes, createdAt: row.created_at }, content };
  }
}

function parseArtifactJournal(raw: string, expectedVersionId: string): { storageKey: string; createdAt: string } | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.formatVersion !== 1 || value.versionId !== expectedVersionId || typeof value.storageKey !== 'string' || typeof value.createdAt !== 'string') return null;
    if (Object.keys(value).sort().join(',') !== 'createdAt,formatVersion,storageKey,versionId') return null;
    const storageKey = value.storageKey;
    if (storageKey.length > 160 || basename(storageKey) !== storageKey || !storageKey.startsWith(`${expectedVersionId}.`) || /[\\/\u0000]/.test(storageKey)) return null;
    if (!Number.isFinite(Date.parse(value.createdAt))) return null;
    return { storageKey, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

async function unlinkRegularFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return true;
  if (!info.isFile() || info.isSymbolicLink()) return false;
  await unlink(path);
  return true;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Artifact storage is not a regular directory.');
}

function sanitizeName(value: string): string {
  const name = basename(value.trim()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').slice(0, 120);
  return name && name !== '.' ? name : 'artifact.txt';
}

function safeMime(value: string | undefined, ext: string): string {
  if (value && ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/html'].includes(value)) return value;
  switch (ext.toLowerCase()) {
    case '.md': return 'text/markdown';
    case '.csv': return 'text/csv';
    case '.json': return 'application/json';
    case '.html': return 'text/html';
    default: return 'text/plain';
  }
}

import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, link, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DatabaseClient } from './database';
import { loadRegistry } from './registry';

const DATABASE_FILE = 'agent-office.sqlite';
const REQUIRED_TABLES = ['schema_migrations', 'workspaces', 'projects', 'runs', 'memory_records', 'hook_outbox'];
const BACKUP_MANIFEST = 'manifest.json';
const MAX_BACKUP_FILES = 50_000;
const MAX_CONFIGURATION_BYTES = 250 * 1024 * 1024;
const MAX_BACKUP_BYTES = 20 * 1024 * 1024 * 1024;

const backupManifestSchema = z.object({
  formatVersion: z.literal(1),
  createdAt: z.string().datetime(),
  appVersion: z.string().max(100),
  schemaVersion: z.number().int().positive(),
  configRevision: z.string().regex(/^[a-f\d]{64}$/i),
  files: z.array(z.object({ path: z.string().min(1).max(1024), sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f\d]{64}$/i) }).strict()).max(MAX_BACKUP_FILES),
}).strict();

type BackupManifest = z.infer<typeof backupManifestSchema>;
type BackupManifestFile = BackupManifest['files'][number];

export async function createBackupBundle(dataDir: string, destination: string, configDir: string, development = false, appDir = process.cwd()): Promise<{ path: string; bytes: number; fileCount: number; schemaVersion: number; configRevision: string }> {
  const sourceDatabase = resolve(dataDir, DATABASE_FILE);
  const targetDir = resolve(destination);
  if (samePath(sourceDatabase, targetDir) || samePath(resolve(dataDir), targetDir)) throw new Error('Backup destination must differ from the active data directory.');
  await requireFile(sourceDatabase, 'Active database was not found. Start Agent Office once before creating a backup.');
  await mkdir(dirname(targetDir), { recursive: true });
  await requirePathMissing(targetDir, 'Backup destination already exists; choose a new path.');

  const temporaryDir = join(dirname(targetDir), `.${basename(targetDir)}.partial-${randomUUID()}`);
  const databaseDir = join(temporaryDir, 'database');
  const artifactsDir = join(temporaryDir, 'artifacts');
  const configurationDir = join(temporaryDir, 'configuration');
  const files: BackupManifestFile[] = [];
  const configurationState = { bytes: 0, count: 0 };
  await mkdir(temporaryDir, { recursive: false });
  try {
    await Promise.all([mkdir(databaseDir), mkdir(artifactsDir), mkdir(configurationDir)]);
    const liveDatabase = await DatabaseClient.open(dataDir, development);
    try { await liveDatabase.backup(join(databaseDir, DATABASE_FILE)); }
    finally { await liveDatabase.close(); }

    const snapshot = await DatabaseClient.open(databaseDir, development);
    let schemaVersion: number;
    let artifactRows: Array<{ storage_key: string; checksum: string }>;
    try {
      const integrity = await snapshot.one<{ integrity_check: string }>('PRAGMA integrity_check');
      if (integrity?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed.');
      const migration = await snapshot.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations');
      if (!migration || migration.version < 6) throw new Error('Backup schema is older than the supported memory-history schema.');
      schemaVersion = migration.version;
      artifactRows = await snapshot.all<{ storage_key: string; checksum: string }>('SELECT storage_key, checksum FROM artifact_versions ORDER BY id');
    } finally { await snapshot.close(); }
    await assertHealthyDatabase(databaseDir, development);
    await removeSqliteSidecars(databaseDir);

    files.push(await recordFile(join(databaseDir, DATABASE_FILE), temporaryDir, `database/${DATABASE_FILE}`));
    const sourceArtifacts = resolve(dataDir, 'artifacts');
    const artifactDirectoryInfo = await lstat(sourceArtifacts).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (artifactRows.length && (!artifactDirectoryInfo || !artifactDirectoryInfo.isDirectory() || artifactDirectoryInfo.isSymbolicLink())) {
      throw new Error('Artifact storage is missing or is not a regular directory.');
    }
    for (const artifact of artifactRows) {
      const key = validateStorageKey(artifact.storage_key);
      const source = join(sourceArtifacts, key);
      const sourceInfo = await lstat(source).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Referenced artifact is missing or unsafe: ${key}.`);
      const destinationPath = join(artifactsDir, key);
      const entry = await recordFile(source, temporaryDir, `artifacts/${key}`, destinationPath);
      if (entry.sha256 !== artifact.checksum) throw new Error(`Artifact checksum does not match the database: ${key}.`);
      files.push(entry);
    }

    const sourceRegistry = await loadRegistry(resolve(configDir));
    for (const section of ['agents', 'skills', 'config']) {
      const source = join(configDir, section);
      const destinationSection = join(configurationDir, section);
      const info = await lstat(source).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`Configuration directory is missing or unsafe: ${section}.`);
      await mkdir(destinationSection, { recursive: false });
      await copyConfigurationTree(source, destinationSection, `${section}/`, temporaryDir, files, configurationState);
    }
    const copiedRegistry = await loadRegistry(configurationDir);
    const currentRegistry = await loadRegistry(resolve(configDir));
    if (copiedRegistry.revision !== sourceRegistry.revision || currentRegistry.revision !== sourceRegistry.revision) {
      throw new Error('Agent configuration changed during backup; no bundle was published.');
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest: BackupManifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      appVersion: await readAppVersion(appDir),
      schemaVersion,
      configRevision: sourceRegistry.revision,
      files,
    };
    await writeFile(join(temporaryDir, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const bytes = files.reduce((sum, file) => sum + file.sizeBytes, Buffer.byteLength(JSON.stringify(manifest)));
    await requirePathMissing(targetDir, 'Backup destination already exists; choose a new path.');
    await rename(temporaryDir, targetDir);
    return { path: targetDir, bytes, fileCount: files.length, schemaVersion, configRevision: sourceRegistry.revision };
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function restoreBackupBundle(source: string, destinationDataDir: string, development = false): Promise<{ dataDir: string; databaseFile: string; configDir: string; manifest: BackupManifest }> {
  const sourceDir = resolve(source);
  const targetDir = resolve(destinationDataDir);
  const sourceInfo = await lstat(sourceDir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Backup bundle directory was not found or is unsafe.');
  await requirePathMissing(targetDir, 'Restore destination already exists; restore into a new, empty path.');
  const manifestPath = join(sourceDir, BACKUP_MANIFEST);
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 8_000_000) throw new Error('Backup manifest is missing, unsafe or too large.');
  let rawManifest: unknown;
  try { rawManifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new Error('Backup manifest is not valid JSON.'); }
  const parsedManifest = backupManifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) throw new Error(`Backup manifest is invalid: ${parsedManifest.error.issues.map((issue) => issue.path.join('.')).join(', ')}.`);
  const manifest = parsedManifest.data;
  const totalBytes = manifest.files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (totalBytes > MAX_BACKUP_BYTES) throw new Error('Backup bundle exceeds the 20 GB restore limit.');
  const entries = new Map<string, BackupManifestFile>();
  for (const entry of manifest.files) {
    validateBundleRelativePath(entry.path);
    if (entries.has(entry.path)) throw new Error(`Backup manifest contains a duplicate path: ${entry.path}.`);
    entries.set(entry.path, entry);
  }
  if (!entries.has(`database/${DATABASE_FILE}`)) throw new Error('Backup manifest is missing the SQLite database.');
  await assertBundleHasNoUnlistedFiles(sourceDir, entries);
  for (const entry of entries.values()) {
    const path = resolveBundleFile(sourceDir, entry.path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Backup entry is not a regular file: ${entry.path}.`);
    if (info.size !== entry.sizeBytes || await hashFile(path) !== entry.sha256) throw new Error(`Backup checksum mismatch: ${entry.path}.`);
  }

  await mkdir(dirname(targetDir), { recursive: true });
  const temporaryDir = join(dirname(targetDir), `.${basename(targetDir)}.restore-${randomUUID()}`);
  await mkdir(temporaryDir, { recursive: false });
  try {
    for (const entry of entries.values()) {
      const destination = restoreDestination(temporaryDir, entry.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolveBundleFile(sourceDir, entry.path), destination, constants.COPYFILE_EXCL);
      const copied = await stat(destination);
      if (copied.size !== entry.sizeBytes || await hashFile(destination) !== entry.sha256) throw new Error(`Restored file checksum failed: ${entry.path}.`);
    }
    await assertHealthyDatabase(temporaryDir, development);
    await verifyRestoredArtifacts(temporaryDir, entries);
    const restoredRegistry = await loadRegistry(join(temporaryDir, 'configuration'));
    if (restoredRegistry.revision !== manifest.configRevision) throw new Error('Restored agent configuration revision does not match the backup manifest.');
    await removeSqliteSidecars(temporaryDir);
    await requirePathMissing(targetDir, 'Restore destination already exists; restore into a new, empty path.');
    await rename(temporaryDir, targetDir);
    return { dataDir: targetDir, databaseFile: join(targetDir, DATABASE_FILE), configDir: join(targetDir, 'configuration'), manifest };
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createDatabaseBackup(dataDir: string, destination: string, development = false): Promise<{ path: string; bytes: number }> {
  const sourceFile = resolve(dataDir, DATABASE_FILE);
  const targetFile = resolve(destination);
  if (samePath(sourceFile, targetFile)) throw new Error('Backup destination must differ from the active database.');
  await requireFile(sourceFile, 'Active database was not found. Start Agent Office once before creating a backup.');
  await mkdir(dirname(targetFile), { recursive: true });
  await requireMissing(targetFile, 'Backup destination already exists; choose a new path.');

  const temporaryDir = join(dirname(targetFile), `.${basename(targetFile)}.partial-${randomUUID()}`);
  await mkdir(temporaryDir, { recursive: false });
  const temporaryFile = join(temporaryDir, DATABASE_FILE);
  const database = await DatabaseClient.open(dataDir, development);
  try {
    await database.backup(temporaryFile);
    await assertHealthyDatabase(temporaryDir, development);
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await database.close();
  }

  try {
    await publishFileWithoutOverwrite(temporaryFile, targetFile);
    const details = await stat(targetFile);
    return { path: targetFile, bytes: details.size };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function restoreDatabaseBackup(source: string, destinationDataDir: string, development = false): Promise<{ dataDir: string; databaseFile: string }> {
  const sourceFile = resolve(source);
  const targetDir = resolve(destinationDataDir);
  await requireFile(sourceFile, 'Backup file was not found.');
  await requireMissing(targetDir, 'Restore destination already exists; restore into a new, empty path.');
  await mkdir(dirname(targetDir), { recursive: true });

  const temporaryDir = join(dirname(targetDir), `.${basename(targetDir)}.restore-${randomUUID()}`);
  await mkdir(temporaryDir, { recursive: false });
  const temporaryDatabaseFile = join(temporaryDir, DATABASE_FILE);
  try {
    await copyFile(sourceFile, temporaryDatabaseFile, constants.COPYFILE_EXCL);
    await assertHealthyDatabase(temporaryDir, development);
    await removeSqliteSidecars(temporaryDir);
    await rename(temporaryDir, targetDir);
    return { dataDir: targetDir, databaseFile: join(targetDir, DATABASE_FILE) };
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export interface StorageDiagnostics {
  sqliteVersion: string;
  schemaVersion: number;
  integrity: 'ok';
  requiredTables: 'ok';
  foreignKeyViolations: 0;
}

export async function inspectStorage(dataDir: string, development = false): Promise<StorageDiagnostics> {
  const databasePath = resolve(dataDir, DATABASE_FILE);
  const databaseInfo = await lstat(databasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('Agent Office database was not found. Start the office once to initialize its data directory.');
    throw error;
  });
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) throw new Error('Agent Office database path is not a regular file.');
  await assertSqliteHeader(databasePath);
  const database = await DatabaseClient.openReadOnly(dataDir, development);
  try {
    const integrity = await database.one<{ integrity_check: string }>('PRAGMA integrity_check');
    if (integrity?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed.');
    const tables = new Set((await database.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => '?').join(',')})`, REQUIRED_TABLES)).map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((name) => !tables.has(name));
    if (missing.length) throw new Error(`Database is missing required Agent Office tables: ${missing.join(', ')}.`);
    const migration = await database.one<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations');
    if (!migration?.version || migration.version < 6) throw new Error('Database schema is older than the supported memory-history schema.');
    const violations = await database.all('PRAGMA foreign_key_check');
    if (violations.length) throw new Error(`SQLite reports ${violations.length} foreign-key violation(s).`);
    const version = await database.one<{ sqlite_version: string }>('SELECT sqlite_version() AS sqlite_version');
    if (!version?.sqlite_version) throw new Error('SQLite version could not be read.');
    return { sqliteVersion: version.sqlite_version, schemaVersion: migration.version, integrity: 'ok', requiredTables: 'ok', foreignKeyViolations: 0 };
  } finally {
    await database.close();
  }
}

async function assertHealthyDatabase(dataDir: string, development: boolean): Promise<void> {
  await inspectStorage(dataDir, development);
}

async function assertSqliteHeader(databasePath: string): Promise<void> {
  const file = await open(databasePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !header.equals(Buffer.from('SQLite format 3\0', 'ascii'))) {
      throw new Error('Database file does not have a valid SQLite header.');
    }
  } finally {
    await file.close();
  }
}

async function removeSqliteSidecars(dataDir: string): Promise<void> {
  for (const suffix of ['-wal', '-shm']) {
    const path = join(dataDir, `${DATABASE_FILE}${suffix}`);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`SQLite sidecar is not a regular file: ${basename(path)}.`);
    if (suffix === '-wal' && info.size > 0) throw new Error('Staged SQLite backup has a non-empty WAL after validation; refusing to publish an incomplete snapshot.');
    await unlink(path);
  }
}

async function publishFileWithoutOverwrite(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
    await unlink(source);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error('Backup destination already exists; choose a new path.');
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code ?? '')) throw error;
  }

  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Backup destination already exists; choose a new path.');
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function requireFile(path: string, message: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error(message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(message);
    throw error;
  }
}

async function requireMissing(path: string, message: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
  return normalize(left) === normalize(right);
}

async function recordFile(sourcePath: string, bundleRoot: string, archivePath: string, destinationPath = resolve(bundleRoot, ...archivePath.split('/'))): Promise<BackupManifestFile> {
  const relativePath = relative(resolve(bundleRoot), resolve(destinationPath));
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error(`Backup path escapes its bundle: ${archivePath}.`);
  if (!samePath(sourcePath, destinationPath)) {
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
  }
  const details = await stat(destinationPath);
  return { path: archivePath, sizeBytes: details.size, sha256: await hashFile(destinationPath) };
}

async function copyConfigurationTree(sourceDir: string, destinationDir: string, prefix: string, bundleRoot: string, files: BackupManifestFile[], state: { bytes: number; count: number }): Promise<void> {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (isSensitiveBackupName(entry.name)) continue;
    const source = join(sourceDir, entry.name);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Configuration contains a symlink or junction: ${prefix}${entry.name}.`);
    const destination = join(destinationDir, entry.name);
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: false });
      await copyConfigurationTree(source, destination, `${prefix}${entry.name}/`, bundleRoot, files, state);
      continue;
    }
    if (!info.isFile()) throw new Error(`Configuration contains a non-regular file: ${prefix}${entry.name}.`);
    state.count++;
    if (state.count > MAX_BACKUP_FILES) throw new Error('Configuration backup exceeds the 50,000 file limit.');
    const bytes = await readFile(source);
    state.bytes += bytes.byteLength;
    if (state.bytes > MAX_CONFIGURATION_BYTES) throw new Error('Configuration backup exceeds the 250 MB limit.');
    if (containsCredentialMaterial(prefix + entry.name, bytes)) throw new Error(`Configuration appears to contain a secret: ${prefix}${entry.name}. Remove it or move it to an environment variable before backing up.`);
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    const archivePath = `configuration/${prefix}${entry.name}`;
    files.push({ path: archivePath, sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}

function isSensitiveBackupName(name: string): boolean {
  const lower = name.toLocaleLowerCase('en-US');
  return lower === '.git' || lower === 'node_modules' || lower === '.claude' || lower === '.codex' || lower === '.env' || lower.startsWith('.env.')
    || lower === '.npmrc' || lower === 'secrets' || lower === 'credentials' || lower === 'id_rsa' || lower === 'id_ed25519'
    || lower.endsWith('.key') || lower.endsWith('.pem');
}

function containsCredentialMaterial(path: string, bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const source = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/.test(source)) return true;
  if (!/\.(?:ya?ml|json|toml|ini)$/i.test(path)) return false;
  const assignment = /(?:^|[\s"'])(?:api[_-]?key|client[_-]?secret|password|access[_-]?token|private[_-]?key|secret)\s*["']?\s*[:=]\s*["']?([^\s"'#]+)/gim;
  for (const match of source.matchAll(assignment)) {
    const value = (match[1] ?? '').replace(/[,;}]+$/, '');
    if (!value || value.length < 8) continue;
    if (/^(?:\$?\{[A-Z][A-Z0-9_]*\}|[A-Z][A-Z0-9_]*|env:[A-Z][A-Z0-9_]*)$/i.test(value)) continue;
    if (/^(?:<[^>]+>|change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example[-_ ]?value)$/i.test(value)) continue;
    return true;
  }
  return false;
}

async function readAppVersion(appDir: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version.slice(0, 100) : 'unknown';
  } catch { return 'unknown'; }
}

function validateStorageKey(value: string): string {
  if (!value || value !== basename(value) || value.includes('\\') || value.includes('/') || value.includes(':') || value === '.' || value === '..') {
    throw new Error('Artifact storage key is invalid.');
  }
  return value;
}

function validateBundleRelativePath(value: string): void {
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.includes(':')) throw new Error(`Backup path is invalid: ${value}.`);
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || isSensitiveBackupName(part))) throw new Error(`Backup path is invalid: ${value}.`);
  if (parts[0] === 'database' && parts.length === 2 && parts[1] === DATABASE_FILE) return;
  if (parts[0] === 'artifacts' && parts.length === 2) { validateStorageKey(parts[1]!); return; }
  if (parts[0] === 'configuration' && parts.length >= 3 && ['agents', 'skills', 'config'].includes(parts[1]!)) return;
  throw new Error(`Backup path is not an allowed payload: ${value}.`);
}

function resolveBundleFile(bundleRoot: string, archivePath: string): string {
  validateBundleRelativePath(archivePath);
  const target = resolve(bundleRoot, ...archivePath.split('/'));
  const rel = relative(resolve(bundleRoot), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Backup path escapes the bundle: ${archivePath}.`);
  return target;
}

async function assertBundleHasNoUnlistedFiles(bundleRoot: string, entries: Map<string, BackupManifestFile>): Promise<void> {
  const actual = new Set<string>();
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (prefix === '' && entry.name === BACKUP_MANIFEST) continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Backup contains a symlink or junction: ${prefix}${entry.name}.`);
      if (info.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else if (info.isFile()) actual.add(`${prefix}${entry.name}`);
      else throw new Error(`Backup contains a non-regular entry: ${prefix}${entry.name}.`);
    }
  }
  await walk(bundleRoot, '');
  const expected = new Set([...entries.keys()].map((path) => {
    validateBundleRelativePath(path);
    return path;
  }));
  if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) {
    const unlisted = [...actual].filter((path) => !expected.has(path));
    const missing = [...expected].filter((path) => !actual.has(path));
    throw new Error(`Backup contains unlisted files or is missing manifest entries. Unlisted: ${unlisted.slice(0, 8).join(', ') || 'none'}; missing: ${missing.slice(0, 8).join(', ') || 'none'}.`);
  }
}

function restoreDestination(stagingDir: string, archivePath: string): string {
  validateBundleRelativePath(archivePath);
  const parts = archivePath.split('/');
  const restoredParts = parts[0] === 'database' ? [DATABASE_FILE] : parts;
  const restored = resolve(stagingDir, ...restoredParts);
  const rel = relative(resolve(stagingDir), restored);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Restore path escapes its data directory: ${archivePath}.`);
  return restored;
}

async function verifyRestoredArtifacts(dataDir: string, entries: Map<string, BackupManifestFile>): Promise<void> {
  const database = await DatabaseClient.open(dataDir, true);
  try {
    const rows = await database.all<{ storage_key: string; checksum: string }>('SELECT storage_key, checksum FROM artifact_versions ORDER BY id');
    const referenced = new Set<string>();
    for (const row of rows) {
      const key = validateStorageKey(row.storage_key);
      const archivePath = `artifacts/${key}`;
      const entry = entries.get(archivePath);
      if (!entry || entry.sha256 !== row.checksum) throw new Error(`Backup manifest does not contain a verified database artifact: ${key}.`);
      const destination = join(dataDir, 'artifacts', key);
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.sizeBytes || await hashFile(destination) !== row.checksum) throw new Error(`Restored artifact checksum failed: ${key}.`);
      referenced.add(archivePath);
    }
    const bundledArtifacts = [...entries.keys()].filter((path) => path.startsWith('artifacts/'));
    if (bundledArtifacts.length !== referenced.size || bundledArtifacts.some((path) => !referenced.has(path))) throw new Error('Backup includes orphaned or unreferenced artifact files.');
  } finally { await database.close(); }
}

async function requirePathMissing(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}


import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_SOURCE_PATHS = [
  '.env.example',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'docs/AGENT-OFFICE-PACKAGE-README.md',
  'docs/AGENT-OFFICE-USER-GUIDE.md',
  'docs/AGENT-OFFICE-UAT-CHECKLIST.md',
  'docs/AGENT-OFFICE-TEST-REPORT.md',
  'docs/planning/agent-office',
  'agents',
  'config',
  'skills',
  'dist',
  'visual-evidence/office-r78-working.png',
  'visual-evidence/office-r78-activity.png',
  'visual-evidence/office-r78-settings.png',
] as const;

const REQUIRED_RELEASE_FILES = [
  '.env.example',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'package.json',
  'npm-shrinkwrap.json',
  'agents/roster.yaml',
  'config/models.yaml',
  'config/policies.yaml',
  'config/tools.yaml',
  'dist/server/platform.js',
  'dist/server/platform-cli.js',
  'dist/server/platform/db-worker.js',
  'dist/server/preview-supervisor.mjs',
  'dist/client/office.html',
  'docs/AGENT-OFFICE-USER-GUIDE.md',
  'docs/AGENT-OFFICE-UAT-CHECKLIST.md',
  'docs/planning/agent-office/README.md',
  'visual-evidence/office-r78-working.png',
  'visual-evidence/office-r78-activity.png',
  'visual-evidence/office-r78-settings.png',
] as const;

export interface ReleaseManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  bundleSha256: string;
  files: ReleaseManifestFile[];
}

interface PackageJson {
  name?: unknown;
  version?: unknown;
  scripts?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function buildReleasePackage(sourceDir: string, outputDir: string): Promise<{ path: string; fileCount: number; bundleSha256: string }> {
  const sourceRoot = await realpath(sourceDir);
  const requestedOutput = resolve(outputDir);
  await mkdir(dirname(requestedOutput), { recursive: true });
  const outputRoot = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  assertSeparateTrees(sourceRoot, outputRoot);
  try {
    await lstat(outputRoot);
    throw new Error(`Output directory already exists; choose a new path: ${outputRoot}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  await mkdir(outputRoot);
  try {
    for (const sourcePath of RELEASE_SOURCE_PATHS) {
      const source = join(sourceRoot, sourcePath);
      const destinationPath = sourcePath === 'docs/AGENT-OFFICE-PACKAGE-README.md'
        ? 'README.md'
        : sourcePath;
      const destination = join(outputRoot, destinationPath);
      await copyTreeWithoutSecrets(source, destination, sourceRoot, outputRoot);
    }

    const readmePath = join(outputRoot, 'README.md');
    const packageId = basename(outputRoot).replace(/^agent-office-/i, '').replace(/[^A-Za-z0-9._-]/g, '-');
    const readme = await readFile(readmePath, 'utf8');
    if (!readme.includes('__PACKAGE_ID__')) throw new Error('Package README must include the __PACKAGE_ID__ data-directory token.');
    await writeFile(readmePath, readme.replaceAll('__PACKAGE_ID__', packageId), 'utf8');

    await assertRegularFile(join(sourceRoot, 'package.json'));
    await assertRegularFile(join(sourceRoot, 'package-lock.json'));
    const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8')) as PackageJson;
    if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
      throw new Error('Source package.json must declare a name and version.');
    }
    const scripts = {
      start: 'node --env-file-if-exists=.env dist/server/platform.js',
      'office:start': 'node --env-file-if-exists=.env dist/server/platform.js',
      'config:validate': 'node --env-file-if-exists=.env dist/server/platform-cli.js validate',
      'office:doctor': 'node --env-file-if-exists=.env dist/server/platform-cli.js doctor',
      'office:backup': 'node --env-file-if-exists=.env dist/server/platform-cli.js backup',
      'office:restore': 'node --env-file-if-exists=.env dist/server/platform-cli.js restore',
    };
    await writeFile(join(outputRoot, 'package.json'), `${JSON.stringify({ ...packageJson, scripts }, null, 2)}\n`, 'utf8');
    await copyFile(join(sourceRoot, 'package-lock.json'), join(outputRoot, 'npm-shrinkwrap.json'));

    await assertRequiredFiles(outputRoot);
    const files = await inventory(outputRoot);
    const manifest: ReleaseManifest = {
      schemaVersion: 1,
      bundleSha256: sha256(JSON.stringify(files)),
      files,
    };
    await writeFile(join(outputRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await verifyReleasePackage(outputRoot);
    return { path: outputRoot, fileCount: files.length, bundleSha256: manifest.bundleSha256 };
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyReleasePackage(packageDir: string): Promise<ReleaseManifest> {
  const root = await realpath(packageDir);
  const manifestPath = join(root, 'release-manifest.json');
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('Release manifest must be a regular file.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ReleaseManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || typeof manifest.bundleSha256 !== 'string') {
    throw new Error('Unsupported or malformed release manifest.');
  }
  await assertRequiredFiles(root);
  const actual = await inventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error('Release package files do not match the manifest (missing, added, or changed file).');
  }
  const bundleSha256 = sha256(JSON.stringify(actual));
  if (bundleSha256 !== manifest.bundleSha256) throw new Error('Release package bundle hash does not match its manifest.');
  return manifest;
}

async function copyTreeWithoutSecrets(source: string, destination: string, sourceRoot: string, outputRoot: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Release input may not contain symlinks: ${relative(sourceRoot, source)}.`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      if (isEnvironmentFile(entry)) continue;
      await copyTreeWithoutSecrets(join(source, entry), join(destination, entry), sourceRoot, outputRoot);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Release input is not a regular file: ${relative(sourceRoot, source)}.`);
  if (isEnvironmentFile(basename(source))) return;
  const targetRelative = relative(outputRoot, destination);
  if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
    throw new Error('Release copy target escapes the package directory.');
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function inventory(root: string): Promise<ReleaseManifestFile[]> {
  const paths = (await listFiles(root)).filter((path) => path !== 'release-manifest.json').sort(comparePath);
  const files: ReleaseManifestFile[] = [];
  for (const path of paths) {
    const fullPath = join(root, ...path.split('/'));
    const info = await lstat(fullPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release package contains a non-regular file: ${path}.`);
    const content = await readFile(fullPath);
    files.push({ path, bytes: content.byteLength, sha256: sha256(content) });
  }
  return files;
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === 'node_modules') continue;
    if (!prefix && isRootEnvironmentFile(entry.name)) continue;
    const fullPath = join(root, ...path.split('/'));
    if (entry.isSymbolicLink()) throw new Error(`Release package may not contain symlinks: ${path}.`);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Release package contains an unsupported filesystem entry: ${path}.`);
  }
  return files;
}

function isEnvironmentFile(name: string): boolean {
  return name !== '.env.example' && (name === '.env' || name.startsWith('.env.') || name.endsWith('.env'));
}

function isRootEnvironmentFile(name: string): boolean {
  return name !== '.env.example' && (name === '.env' || name.startsWith('.env.'));
}

async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Required release input is not a regular file: ${path}.`);
}

async function assertRequiredFiles(root: string): Promise<void> {
  for (const path of REQUIRED_RELEASE_FILES) {
    const fullPath = join(root, ...path.split('/'));
    await assertRegularFile(fullPath);
  }
}

function assertSeparateTrees(source: string, output: string): void {
  const inputs = [...RELEASE_SOURCE_PATHS.map((path) => join(source, path)), join(source, 'package.json'), join(source, 'package-lock.json')];
  if (inputs.some((input) => isWithin(input, output) || isWithin(output, input))) {
    throw new Error('Release output may not overlap any packaged source path.');
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function main(): Promise<void> {
  const sourceRoot = process.cwd();
  const verifyIndex = process.argv.indexOf('--verify');
  if (verifyIndex !== -1) {
    const path = process.argv[verifyIndex + 1];
    if (!path || path.startsWith('--')) throw new Error('--verify requires a package directory.');
    const manifest = await verifyReleasePackage(resolve(path));
    console.log(JSON.stringify({ ok: true, fileCount: manifest.files.length, bundleSha256: manifest.bundleSha256 }, null, 2));
    return;
  }
  const outputIndex = process.argv.indexOf('--output-dir');
  const outputArgument = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
  if (outputIndex !== -1 && (!outputArgument || outputArgument.startsWith('--'))) throw new Error('--output-dir requires a new directory path.');
  const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8')) as PackageJson;
  if (typeof packageJson.version !== 'string') throw new Error('Source package.json must declare a version.');
  const output = outputArgument ? resolve(outputArgument) : join(sourceRoot, 'release', `agent-office-${packageJson.version}`);
  const result = await buildReleasePackage(sourceRoot, output);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}

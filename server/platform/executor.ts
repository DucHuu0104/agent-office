import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export interface DockerCheckExecution {
  mode: 'docker';
  image: string;
  network: 'none' | 'bridge';
  installDependencies: 'none' | 'npm-ci';
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

export type CheckExecution = { mode: 'local-trusted' } | DockerCheckExecution;

export function checkExecutionFromConfig(config: {
  executionMode: 'disabled' | 'docker' | 'local-trusted';
  docker: Omit<DockerCheckExecution, 'mode'>;
}): CheckExecution {
  if (config.executionMode === 'docker') return { mode: 'docker', ...config.docker };
  if (config.executionMode === 'local-trusted') return { mode: 'local-trusted' };
  throw new Error('Chưa bật executor cho workspace checks.');
}

const CHECK_NAMES = new Set(['test', 'test:unit', 'test:e2e', 'typecheck', 'build', 'lint', 'check', 'verify']);
const MAX_SNAPSHOT_BYTES = 1_000_000_000;
const MAX_SNAPSHOT_FILES = 200_000;
const MAX_OUTPUT_BYTES = 24_000;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

export interface ProposedCheck {
  name: string;
  command: string;
  lifecycle: Array<{ name: string; command: string }>;
}

export interface CheckProposal {
  packageChecksum: string;
  packageName: string;
  execution: CheckExecution;
  dependencyInstall?: { command: 'npm ci --no-audit --no-fund'; lockFile: string; lockChecksum: string; lifecycle: Array<{ name: string; command: string }> };
  checks: ProposedCheck[];
}

export interface CheckResult {
  packageName: string;
  packageChecksum: string;
  snapshot: { isolated: true; skippedSymlinks: number; skippedHardLinks: number; execution: CheckExecution };
  dependencyInstall?: {
    command: 'npm ci --no-audit --no-fund';
    lockFile: string;
    lockChecksum: string;
    outcome: 'passed' | 'failed' | 'timed_out' | 'cancelled';
    exitCode: number | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
  };
  checks: Array<ProposedCheck & {
    outcome: 'passed' | 'failed' | 'timed_out' | 'cancelled';
    exitCode: number | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
  }>;
  passed: boolean;
  cancelled: boolean;
}

export interface PackageScripts {
  packageName: string;
  packageChecksum: string;
  scripts: Record<string, string>;
}

export async function prepareWorkspaceChecks(root: string | null, names: unknown, execution: CheckExecution = { mode: 'local-trusted' }): Promise<CheckProposal> {
  if (!Array.isArray(names) || names.length < 1 || names.length > 4 || names.some((item) => typeof item !== 'string')) {
    throw new Error('Chọn từ 1 đến 4 lượt kiểm tra được hỗ trợ.');
  }
  const checks = [...new Set(names as string[])];
  if (checks.length !== names.length || checks.some((name) => !CHECK_NAMES.has(name))) throw new Error('Tên lượt kiểm tra không hợp lệ hoặc bị lặp.');
  const pkg = await readPackageScripts(root);
  const proposals: ProposedCheck[] = checks.map((name) => {
    const command = pkg.scripts[name];
    if (typeof command !== 'string' || !command.trim()) throw new Error(`Workspace không khai báo script "${name}" trong package.json.`);
    const lifecycle: ProposedCheck['lifecycle'] = [];
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      const body = pkg.scripts[hook];
      if (typeof body === 'string' && body.trim()) lifecycle.push({ name: hook, command: body });
    }
    return { name, command, lifecycle };
  });
  const dependencyInstall = execution.mode === 'docker' && execution.installDependencies === 'npm-ci'
    ? await prepareNpmCi(root, pkg.scripts)
    : undefined;
  return { packageChecksum: pkg.packageChecksum, packageName: pkg.packageName, execution, ...(dependencyInstall ? { dependencyInstall } : {}), checks: proposals };
}

export async function runWorkspaceChecks(
  root: string | null,
  approved: CheckProposal,
  signal?: AbortSignal,
): Promise<CheckResult> {
  if (signal?.aborted) throw new Error('Đã hủy trước khi chạy kiểm tra.');
  const current = await prepareWorkspaceChecks(root, approved.checks.map((check) => check.name), approved.execution);
  if (current.packageChecksum !== approved.packageChecksum || JSON.stringify(current.checks) !== JSON.stringify(approved.checks) || JSON.stringify(current.dependencyInstall) !== JSON.stringify(approved.dependencyInstall)) {
    throw new Error('package.json đã thay đổi sau khi bạn duyệt; chưa chạy lệnh nào.');
  }
  if (!root) throw new Error('Project chưa gắn workspace folder.');
  const snapshot = await createWorkspaceSnapshot(root, 'agent-office-check-', approved.execution.mode === 'docker' && approved.execution.installDependencies === 'npm-ci');
  const snapshotRoot = snapshot.root;
  try {
    const snapshotPackage = await readPackageScripts(snapshotRoot);
    if (snapshotPackage.packageChecksum !== approved.packageChecksum) throw new Error('Workspace đổi trong lúc tạo snapshot; chưa chạy lệnh nào.');
    if (approved.dependencyInstall) {
      const snapshotLock = await prepareNpmCi(snapshotRoot, snapshotPackage.scripts);
      if (JSON.stringify(snapshotLock) !== JSON.stringify(approved.dependencyInstall)) throw new Error('Lockfile hoặc hook npm đã thay đổi trong lúc tạo snapshot; chưa chạy lệnh nào.');
    }
    const npmCli = approved.execution.mode === 'local-trusted' ? await findNpmCli() : null;
    if (approved.execution.mode === 'docker') await assertDockerReady(approved.execution);
    const checks: CheckResult['checks'] = [];
    let dependencyInstall: CheckResult['dependencyInstall'];
    if (approved.execution.mode === 'docker' && approved.execution.installDependencies === 'npm-ci') {
      const setup = approved.dependencyInstall;
      if (!setup) throw new Error('Thiếu xác nhận lockfile cho bước npm ci.');
      const setupStart = performance.now();
      const setupResult = await runDockerCommandInContainer(['npm', 'ci', '--no-audit', '--no-fund'], snapshotRoot, approved.execution, signal);
      const setupOutcome = setupResult.cancelled ? 'cancelled' : setupResult.timedOut ? 'timed_out' : setupResult.exitCode === 0 ? 'passed' : 'failed';
      dependencyInstall = { ...setup, outcome: setupOutcome, exitCode: setupResult.exitCode, durationMs: Math.round(performance.now() - setupStart), stdout: setupResult.stdout, stderr: setupResult.stderr, outputTruncated: setupResult.outputTruncated };
      if (setupOutcome !== 'passed') {
        const cancelled = setupOutcome === 'cancelled' || signal?.aborted === true;
        return {
          packageName: approved.packageName,
          packageChecksum: approved.packageChecksum,
          snapshot: { isolated: true, skippedSymlinks: snapshot.skippedSymlinks, skippedHardLinks: snapshot.skippedHardLinks, execution: approved.execution },
          dependencyInstall,
          checks,
          passed: false,
          cancelled,
        };
      }
    }
    for (const proposal of approved.checks) {
      if (signal?.aborted) break;
      const start = performance.now();
      const result = approved.execution.mode === 'docker'
        ? await runDockerScript(proposal.name, snapshotRoot, approved.execution, signal)
        : await runNpmScript(npmCli!, proposal.name, snapshotRoot, signal);
      const outcome = result.cancelled ? 'cancelled' : result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed';
      checks.push({ ...proposal, outcome, exitCode: result.exitCode, durationMs: Math.round(performance.now() - start), stdout: result.stdout, stderr: result.stderr, outputTruncated: result.outputTruncated });
      if (result.cancelled) break;
    }
    const cancelled = signal?.aborted ?? false;
    return {
      packageName: approved.packageName,
      packageChecksum: approved.packageChecksum,
      snapshot: { isolated: true, skippedSymlinks: snapshot.skippedSymlinks, skippedHardLinks: snapshot.skippedHardLinks, execution: approved.execution },
      ...(dependencyInstall ? { dependencyInstall } : {}),
      checks,
      passed: !cancelled && checks.length === approved.checks.length && checks.every((check) => check.outcome === 'passed'),
      cancelled,
    };
  } finally {
    await snapshot.cleanup();
  }
}

export interface WorkspaceSnapshot {
  parent: string;
  root: string;
  skippedSymlinks: number;
  skippedHardLinks: number;
  cleanup(): Promise<void>;
}

/** Make a bounded copy of a workspace without credentials, repository metadata, links or hard-linked files. */
export async function createWorkspaceSnapshot(root: string | null, prefix: string, skipNodeModules = false): Promise<WorkspaceSnapshot> {
  if (!root) throw new Error('Project chưa gắn workspace folder.');
  const source = await realpath(root);
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const target = join(parent, 'workspace');
  const copyState = { bytes: 0, files: 0, skippedHardLinks: 0 };
  try {
    await mkdir(target);
    const skippedSymlinks = await copyTree(source, target, copyState, skipNodeModules);
    return {
      parent,
      root: target,
      skippedSymlinks,
      skippedHardLinks: copyState.skippedHardLinks,
      cleanup: () => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
    };
  } catch (error) {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }
}

export async function validateWorkspaceCheckProposal(root: string | null, value: unknown, execution: CheckExecution = { mode: 'local-trusted' }): Promise<CheckProposal> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Đề xuất chạy kiểm tra không hợp lệ.');
  const proposal = value as Partial<CheckProposal>;
  if (typeof proposal.packageChecksum !== 'string' || !/^[a-f\d]{64}$/i.test(proposal.packageChecksum) || typeof proposal.packageName !== 'string' || !Array.isArray(proposal.checks)) {
    throw new Error('Đề xuất chạy kiểm tra thiếu package hash hoặc danh sách script.');
  }
  const current = await prepareWorkspaceChecks(root, proposal.checks.map((check) => (check as ProposedCheck)?.name), execution);
  if (current.packageChecksum !== proposal.packageChecksum || current.packageName !== proposal.packageName || JSON.stringify(current.checks) !== JSON.stringify(proposal.checks) || JSON.stringify(current.execution) !== JSON.stringify(proposal.execution) || JSON.stringify(current.dependencyInstall) !== JSON.stringify(proposal.dependencyInstall)) {
    throw new Error('package.json hoặc nội dung script đã thay đổi sau khi bạn duyệt; chưa chạy lệnh nào.');
  }
  return current;
}

export async function readPackageScripts(root: string | null): Promise<PackageScripts> {
  if (!root) throw new Error('Project chưa gắn workspace folder.');
  const realRoot = await realpath(root);
  const packagePath = resolve(realRoot, 'package.json');
  const info = await lstat(packagePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('Không tìm thấy package.json an toàn trong workspace.');
  const packageRealPath = await realpath(packagePath);
  const relativePath = packageRealPath.slice(realRoot.length).replace(/^[/\\]+/, '');
  if (!relativePath || relativePath.includes('..') || dirname(packageRealPath) !== realRoot) throw new Error('package.json phải nằm trực tiếp trong workspace.');
  const bytes = await readFile(packageRealPath);
  if (bytes.byteLength > 1_000_000) throw new Error('package.json vượt giới hạn 1 MB.');
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('package.json không phải JSON hợp lệ.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('package.json không hợp lệ.');
  const value = parsed as { name?: unknown; scripts?: unknown };
  if (!value.scripts || typeof value.scripts !== 'object' || Array.isArray(value.scripts)) throw new Error('package.json chưa khai báo scripts.');
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(value.scripts)) if (typeof command === 'string') scripts[name] = command;
  return {
    packageName: typeof value.name === 'string' ? value.name.slice(0, 160) : '(không tên)',
    packageChecksum: createHash('sha256').update(bytes).digest('hex'),
    scripts,
  };
}

export async function prepareNpmCi(root: string | null, scripts: Record<string, string>): Promise<NonNullable<CheckProposal['dependencyInstall']>> {
  if (!root) throw new Error('Project chưa gắn workspace folder.');
  const realRoot = await realpath(root);
  for (const lockFile of ['npm-shrinkwrap.json', 'package-lock.json']) {
    const path = join(realRoot, lockFile);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${lockFile} phải là file thông thường trong workspace.`);
    if (info.size > 20_000_000) throw new Error(`${lockFile} vượt giới hạn 20 MB.`);
    const realPath = await realpath(path);
    if (dirname(realPath) !== realRoot) throw new Error(`${lockFile} không được trỏ ra ngoài workspace.`);
    const bytes = await readFile(realPath);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(`${lockFile} không phải JSON hợp lệ.`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${lockFile} không có cấu trúc hợp lệ.`);
    const lifecycleOrder = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
    const lifecycle = lifecycleOrder.flatMap((name) => typeof scripts[name] === 'string' && scripts[name]!.trim() ? [{ name, command: scripts[name]! }] : []);
    return { command: 'npm ci --no-audit --no-fund', lockFile, lockChecksum: createHash('sha256').update(bytes).digest('hex'), lifecycle };
  }
  throw new Error('Chế độ npm ci cần package-lock.json hoặc npm-shrinkwrap.json trong workspace.');
}

async function copyTree(source: string, target: string, state: { bytes: number; files: number; skippedHardLinks: number }, skipNodeModules = false): Promise<number> {
  let skippedSymlinks = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (isExcluded(entry.name, entry.isDirectory(), skipNodeModules)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) { skippedSymlinks++; continue; }
    if (info.isDirectory()) {
      await mkdir(to);
      skippedSymlinks += await copyTree(from, to, state, skipNodeModules);
    } else if (info.isFile()) {
      if (info.nlink > 1) { state.skippedHardLinks++; continue; }
      state.files++;
      state.bytes += info.size;
      if (state.files > MAX_SNAPSHOT_FILES || state.bytes > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot vượt giới hạn 200.000 file hoặc 1 GB.');
      await copyFile(from, to, constants.COPYFILE_EXCL);
    }
  }
  return skippedSymlinks;
}

function isExcluded(name: string, directory: boolean, skipNodeModules: boolean): boolean {
  const lower = name.toLowerCase();
  if (directory && skipNodeModules && lower === 'node_modules') return true;
  if (directory && new Set(['.git', '.claude', '.codex', '.ssh', '.aws', 'secrets', 'credentials', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache']).has(lower)) return true;
  if (lower === '.env' || lower.startsWith('.env.') || lower === '.npmrc' || lower === '.pypirc') return true;
  if (/\.(key|pem|pfx|p12)$/i.test(name) || /^(id_rsa|id_ed25519|credentials|secrets?)$/i.test(name)) return true;
  return false;
}

export async function findNpmCli(): Promise<string> {
  const npmExecPath = envValue('npm_execpath');
  if (npmExecPath && npmExecPath.endsWith('.js') && await access(npmExecPath, constants.R_OK).then(() => true, () => false)) return await realpath(npmExecPath);
  const pathValue = envValue('PATH') ?? '';
  for (const segment of pathValue.split(delimiter).filter(Boolean)) {
    const candidates = [join(segment, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(segment, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
    for (const candidate of candidates) if (await access(candidate, constants.R_OK).then(() => true, () => false)) return candidate;
    for (const name of ['npm', 'npm.cmd']) {
      const executable = join(segment, name);
      if (!await access(executable, constants.R_OK).then(() => true, () => false)) continue;
      const resolved = await realpath(executable).catch(() => executable);
      if (resolved.endsWith('.js')) return resolved;
      const parent = dirname(executable);
      const cli = join(parent, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (await access(cli, constants.R_OK).then(() => true, () => false)) return cli;
    }
  }
  throw new Error('Không tìm thấy npm-cli.js; hãy cài Node.js và npm trên máy này.');
}

function envValue(name: string): string | undefined {
  const key = Object.keys(process.env).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? process.env[key] : undefined;
}

export async function createRestrictedProcessEnv(cwd: string, extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const tempHome = join(cwd, '.agent-office-home');
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
    const value = envValue(name);
    if (value !== undefined) env[name] = value;
  }
  env.HOME = tempHome;
  env.USERPROFILE = tempHome;
  env.APPDATA = join(tempHome, 'AppData', 'Roaming');
  env.LOCALAPPDATA = join(tempHome, 'AppData', 'Local');
  env.TEMP = envValue('TEMP') ?? tmpdir();
  env.TMP = envValue('TMP') ?? env.TEMP;
  env.CI = 'true';
  env.BROWSER = 'none';
  env.NPM_CONFIG_USERCONFIG = join(cwd, '.agent-office-npmrc');
  env.NPM_CONFIG_CACHE = join(tempHome, 'npm-cache');
  Object.assign(env, extra);
  await mkdir(join(tempHome, 'AppData', 'Roaming'), { recursive: true });
  await mkdir(join(tempHome, 'AppData', 'Local'), { recursive: true });
  await mkdir(env.NPM_CONFIG_CACHE, { recursive: true });
  await writeFile(env.NPM_CONFIG_USERCONFIG, '');
  return env;
}

async function runNpmScript(npmCli: string, script: string, cwd: string, signal?: AbortSignal): Promise<{
  exitCode: number | null; stdout: string; stderr: string; outputTruncated: boolean; timedOut: boolean; cancelled: boolean;
}> {
  if (!CHECK_NAMES.has(script)) return Promise.reject(new Error('Script kiểm tra không được hỗ trợ.'));
  if (signal?.aborted) return Promise.resolve({ exitCode: null, stdout: '', stderr: '', outputTruncated: false, timedOut: false, cancelled: true });
  const env = await createRestrictedProcessEnv(cwd);
  let outputBytes = 0;
  let outputTruncated = false;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let cancelled = false;
  let child!: ChildProcess;
  return new Promise((resolvePromise, reject) => {
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const available = Math.max(0, MAX_OUTPUT_BYTES - outputBytes);
      const kept = Buffer.from(value).subarray(0, available).toString('utf8');
      outputBytes += Buffer.byteLength(kept);
      if (Buffer.byteLength(value) > Buffer.byteLength(kept)) outputTruncated = true;
      if (kind === 'stdout') stdout += kept;
      else stderr += kept;
    };
    try {
      child = spawn(process.execPath, [npmCli, '--silent', 'run', script], { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (error) { reject(error); return; }
    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));
    const stopTree = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const systemRoot = envValue('SystemRoot') ?? 'C:\\Windows';
        const taskkill = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        taskkill.on('error', () => child.kill('SIGKILL'));
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 1500);
        force.unref();
      }
    };
    const onAbort = () => { cancelled = true; stopTree(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; stopTree(); }, CHECK_TIMEOUT_MS);
    timeout.unref();
    child.once('error', (error) => { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({ exitCode: code, stdout, stderr, outputTruncated, timedOut, cancelled });
    });
  });
}

export async function assertDockerReady(execution: DockerCheckExecution): Promise<void> {
  let result: Awaited<ReturnType<typeof runDockerCli>>;
  try {
    result = await runDockerCli(['image', 'inspect', execution.image, '--format', '{{.Id}}'], { timeoutMs: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Không tìm thấy Docker CLI. Hãy cài Docker Desktop hoặc Docker Engine rồi khởi động Docker.');
    throw error;
  }
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Không kiểm tra được Docker image "${execution.image}". Hãy khởi động Docker và tải image bằng docker pull; Agent Office không tự tải image. ${result.stderr.slice(0, 1000)}`);
  }
}

async function runDockerScript(script: string, cwd: string, execution: DockerCheckExecution, signal?: AbortSignal): Promise<{
  exitCode: number | null; stdout: string; stderr: string; outputTruncated: boolean; timedOut: boolean; cancelled: boolean;
}> {
  if (!CHECK_NAMES.has(script)) throw new Error('Script kiểm tra không được hỗ trợ.');
  return runDockerCommandInContainer(['npm', '--silent', 'run', script], cwd, execution, signal);
}

async function runDockerCommandInContainer(command: string[], cwd: string, execution: DockerCheckExecution, signal?: AbortSignal): Promise<{
  exitCode: number | null; stdout: string; stderr: string; outputTruncated: boolean; timedOut: boolean; cancelled: boolean;
}> {
  if (signal?.aborted) return { exitCode: null, stdout: '', stderr: '', outputTruncated: false, timedOut: false, cancelled: true };
  const containerName = `agent-office-check-${randomUUID()}`;
  try {
    const created = await runDockerCli(dockerCreateCommandArgs(containerName, cwd, command, execution), { signal, timeoutMs: 30_000 });
    if (created.cancelled || signal?.aborted) return { ...created, cancelled: true };
    if (created.timedOut) throw new Error('Tạo Docker container quá 30 giây; không chạy script.');
    if (created.exitCode !== 0) throw new Error(`Docker không tạo được container. ${created.stderr.slice(0, 2000)}`);
    const started = await runDockerCli(['start', '--attach', containerName], {
      signal,
      timeoutMs: CHECK_TIMEOUT_MS,
      onStop: () => removeDockerContainer(containerName),
    });
    return started;
  } finally {
    await removeDockerContainer(containerName);
  }
}

export function dockerCreateArgs(containerName: string, workspacePath: string, script: string, execution: DockerCheckExecution): string[] {
  if (!CHECK_NAMES.has(script)) throw new Error('Script kiểm tra không được hỗ trợ.');
  return dockerCreateCommandArgs(containerName, workspacePath, ['npm', '--silent', 'run', script], execution);
}

function dockerCreateCommandArgs(containerName: string, workspacePath: string, command: string[], execution: DockerCheckExecution): string[] {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(containerName)) throw new Error('Tên Docker container không hợp lệ.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(execution.image)) throw new Error('Tham chiếu Docker image không hợp lệ.');
  if (!['none', 'bridge'].includes(execution.network) || !['none', 'npm-ci'].includes(execution.installDependencies)) throw new Error('Chính sách Docker không hợp lệ.');
  if (!Number.isInteger(execution.memoryMb) || execution.memoryMb < 256 || execution.memoryMb > 16384
    || !Number.isFinite(execution.cpus) || execution.cpus < 0.25 || execution.cpus > 8 || execution.cpus * 4 % 1 !== 0
    || !Number.isInteger(execution.pidsLimit) || execution.pidsLimit < 32 || execution.pidsLimit > 1024) throw new Error('Giới hạn Docker không hợp lệ.');
  if (!command.length || command.length > 16 || command.some((part) => typeof part !== 'string' || part.includes('\0'))) throw new Error('Lệnh Docker không hợp lệ.');
  const source = resolve(workspacePath);
  return [
    'create', '--rm', '--init', `--name=${containerName}`,
    `--network=${execution.network}`,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    `--pids-limit=${execution.pidsLimit}`,
    `--memory=${execution.memoryMb}m`, `--memory-swap=${execution.memoryMb}m`, `--cpus=${execution.cpus}`,
    '--user=1000:1000', '--workdir=/workspace',
    `--volume=${source}:/workspace:rw`,
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m',
    '--env=CI=true', '--env=HOME=/tmp/home', '--env=npm_config_cache=/tmp/npm-cache',
    execution.image, ...command,
  ];
}

async function removeDockerContainer(name: string): Promise<void> {
  await runDockerCli(['rm', '--force', name], { timeoutMs: 10_000 }).catch(() => undefined);
}

async function runDockerCli(args: string[], options: {
  signal?: AbortSignal;
  timeoutMs: number;
  onStop?: () => Promise<void>;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; outputTruncated: boolean; timedOut: boolean; cancelled: boolean }> {
  if (options.signal?.aborted) return { exitCode: null, stdout: '', stderr: '', outputTruncated: false, timedOut: false, cancelled: true };
  let outputBytes = 0;
  let outputTruncated = false;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let cancelled = false;
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (error) { reject(error); return; }
    let stopPromise: Promise<void> | null = null;
    let settled = false;
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const available = Math.max(0, MAX_OUTPUT_BYTES - outputBytes);
      const kept = Buffer.from(value).subarray(0, available).toString('utf8');
      outputBytes += Buffer.byteLength(kept);
      if (Buffer.byteLength(value) > Buffer.byteLength(kept)) outputTruncated = true;
      if (kind === 'stdout') stdout += kept;
      else stderr += kept;
    };
    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));
    const stop = () => {
      if (stopPromise) return;
      stopPromise = (async () => {
        await options.onStop?.().catch(() => undefined);
        if (child.exitCode === null) child.kill('SIGKILL');
      })();
    };
    const onAbort = () => { cancelled = true; stop(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    timeout.unref();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      void (async () => {
        if (stopPromise) await stopPromise;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        resolvePromise({ exitCode: code, stdout, stderr, outputTruncated, timedOut, cancelled });
      })();
    });
  });
}

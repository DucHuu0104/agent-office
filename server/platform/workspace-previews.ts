import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertDockerReady, createRestrictedProcessEnv, createWorkspaceSnapshot, findNpmCli, prepareNpmCi, readPackageScripts, type CheckExecution, type DockerCheckExecution, type WorkspaceSnapshot } from './executor';

const PREVIEW_SCRIPTS = new Set(['dev', 'preview', 'start', 'serve']);
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const PREVIEW_START_TIMEOUT_MS = 120_000;
const MAX_PREVIEWS = 4;
const MAX_PROXY_REQUEST_BYTES = 10_000_000;
const MAX_PROXY_RESPONSE_BYTES = 50_000_000;
const PREVIEW_HOST = '127.0.0.2';
const UPSTREAM_HOST = '127.0.0.1';
const MIME_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'user-agent']);
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'vary']);

export interface PreviewScript {
  name: string;
  command: string;
  lifecycle: Array<{ name: string; command: string }>;
}

export interface WorkspacePreviewDescription {
  executionMode: CheckExecution['mode'] | 'disabled';
  scripts: PreviewScript[];
  packageChecksum: string;
  dependencyInstall?: { command: 'npm ci --no-audit --no-fund'; lockFile: string; lockChecksum: string; lifecycle: Array<{ name: string; command: string }> };
  active: WorkspacePreviewInfo | null;
}

export interface WorkspacePreviewInfo {
  id: string;
  projectId: string;
  script: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  executionMode: CheckExecution['mode'];
  networkAccess: boolean;
}

interface PreviewSession {
  info: WorkspacePreviewInfo;
  snapshot: WorkspaceSnapshot;
  upstreamPort: number;
  proxyPort: number;
  proxyServer: Server;
  supervisor: ChildProcess;
  output: string;
  stopping: boolean;
}

interface PreviewSupervisorMessage {
  type?: string;
  message?: string;
  code?: number | null;
  signal?: string | null;
  detail?: string;
  output?: string;
  stoppedBy?: string;
  context?: string;
}

function officeError(message: string, status: number, code: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status, code });
}

/** Starts approved project web scripts in a throwaway snapshot and exposes them only through a loopback proxy. */
export class WorkspacePreviewManager {
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly ownerId: string;
  private readonly supervisorPath = fileURLToPath(new URL('./preview-supervisor.mjs', import.meta.url));
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: {
    dataDir: string;
    execution: CheckExecution | null;
  }) {
    this.ownerId = createHash('sha256').update(resolve(options.dataDir).toLowerCase()).digest('hex').slice(0, 16);
    this.cleanupTimer = setInterval(() => void this.expireSessions(), 15_000);
    this.cleanupTimer.unref();
  }

  async initialize(): Promise<void> {
    const prefix = `agent-office-preview-${this.ownerId}-`;
    for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const path = resolve(tmpdir(), entry.name);
      if (resolve(path).startsWith(`${resolve(tmpdir())}${sep}`)) {
        const info = await stat(path).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 60_000) await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }

  async describe(projectId: string, root: string | null): Promise<WorkspacePreviewDescription> {
    if (!this.options.execution) return { executionMode: 'disabled', scripts: [], packageChecksum: '', active: this.activeForProject(projectId) };
    if (!root) throw officeError('Gắn project với thư mục workspace trước khi mở website preview.', 409, 'PREVIEW_WORKSPACE_REQUIRED');
    const pkg = await readPackageScripts(root);
    const scripts = previewScripts(pkg.scripts);
    let dependencyInstall: WorkspacePreviewDescription['dependencyInstall'];
    if (this.options.execution.mode === 'docker' && this.options.execution.installDependencies === 'npm-ci' && scripts.length) {
      dependencyInstall = await prepareNpmCi(root, pkg.scripts);
    }
    return { executionMode: this.options.execution.mode, scripts, packageChecksum: pkg.packageChecksum, ...(dependencyInstall ? { dependencyInstall } : {}), active: this.activeForProject(projectId) };
  }

  async start(input: { projectId: string; root: string | null; script: unknown; packageChecksum: unknown; dependencyInstallChecksum?: unknown; allowNetworkAccess: unknown }): Promise<WorkspacePreviewInfo> {
    if (!this.options.execution) throw officeError('Chưa bật process executor cho workspace preview.', 409, 'PREVIEW_EXECUTION_DISABLED');
    if (!input.root) throw officeError('Gắn project với thư mục workspace trước khi mở website preview.', 409, 'PREVIEW_WORKSPACE_REQUIRED');
    if (typeof input.script !== 'string' || !PREVIEW_SCRIPTS.has(input.script)) throw officeError('Chọn một script preview được hỗ trợ: dev, preview, start hoặc serve.', 400, 'PREVIEW_SCRIPT_INVALID');
    if (typeof input.packageChecksum !== 'string' || !/^[a-f\d]{64}$/i.test(input.packageChecksum)) throw officeError('Thiếu checksum package.json đã được bạn xem xét.', 400, 'PREVIEW_CHECKSUM_REQUIRED');
    if (input.allowNetworkAccess !== true) throw officeError('Bạn cần xác nhận script sẽ chạy với quyền truy cập mạng của chế độ executor đang chọn.', 403, 'PREVIEW_NETWORK_CONSENT_REQUIRED');
    const current = await this.describe(input.projectId, input.root);
    if (current.packageChecksum !== input.packageChecksum) throw officeError('package.json đã đổi sau khi bạn xem lệnh preview. Hãy xem lại rồi thử lại.', 409, 'PREVIEW_PACKAGE_CHANGED');
    if (current.dependencyInstall && input.dependencyInstallChecksum !== current.dependencyInstall.lockChecksum) throw officeError('Lockfile đã đổi hoặc chưa được bạn xem xét. Hãy xem lại rồi thử lại.', 409, 'PREVIEW_LOCKFILE_CHANGED');
    if (!current.dependencyInstall && input.dependencyInstallChecksum !== undefined && input.dependencyInstallChecksum !== null) throw officeError('Yêu cầu có checksum lockfile nhưng cấu hình không chạy npm ci.', 400, 'PREVIEW_LOCKFILE_UNEXPECTED');
    const script = current.scripts.find((item) => item.name === input.script);
    if (!script) throw officeError(`Workspace chưa khai báo script "${input.script}" để mở preview.`, 422, 'PREVIEW_SCRIPT_MISSING');
    const existing = this.activeForProject(input.projectId);
    if (existing) await this.stop(existing.id);
    if (this.sessions.size >= MAX_PREVIEWS) throw officeError('Đã đạt giới hạn website preview đang chạy. Hãy dừng preview khác rồi thử lại.', 429, 'PREVIEW_LIMIT');

    const execution = this.options.execution;
    const dockerExecution = execution.mode === 'docker'
      ? { ...execution, network: 'bridge' } as DockerCheckExecution
      : null;
    if (dockerExecution) {
      validateDockerPreviewExecution(dockerExecution);
      await assertDockerReady(dockerExecution);
    }
    const id = randomBytes(24).toString('base64url');
    const snapshot = await createWorkspaceSnapshot(input.root, `agent-office-preview-${this.ownerId}-${id.slice(0, 8)}-`, execution.mode === 'docker');
    let proxyServer: Server | undefined;
    let supervisor: ChildProcess | undefined;
    try {
      const snapshotPackage = await readPackageScripts(snapshot.root);
      if (snapshotPackage.packageChecksum !== current.packageChecksum) throw officeError('Workspace đổi trong lúc tạo snapshot; chưa chạy script nào.', 409, 'PREVIEW_PACKAGE_CHANGED');
      const snapshotInstall = execution.mode === 'docker' && execution.installDependencies === 'npm-ci'
        ? await prepareNpmCi(snapshot.root, snapshotPackage.scripts)
        : undefined;
      if (JSON.stringify(snapshotInstall) !== JSON.stringify(current.dependencyInstall)) throw officeError('Lockfile hoặc lifecycle hook npm đổi trong lúc tạo snapshot; chưa chạy lệnh nào.', 409, 'PREVIEW_LOCKFILE_CHANGED');
      const snapshotScripts = previewScripts(snapshotPackage.scripts);
      const snapshotScript = snapshotScripts.find((item) => item.name === script.name);
      if (!snapshotScript || JSON.stringify(snapshotScript) !== JSON.stringify(script)) throw officeError('Script hoặc lifecycle hook đổi trong lúc tạo snapshot; chưa chạy script nào.', 409, 'PREVIEW_SCRIPT_CHANGED');
      const upstreamPort = await reservePort(UPSTREAM_HOST);
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
      const proxy = createServer((req, res) => void proxyRequest(req, res, upstreamPort));
      proxy.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, upstreamPort));
      proxyServer = proxy;
      await listen(proxyServer, PREVIEW_HOST);
      const address = proxyServer.address() as AddressInfo;
      const proxyPort = address.port;
      const previewEnv = execution.mode === 'local-trusted'
        ? await createRestrictedProcessEnv(snapshot.root, { HOST: UPSTREAM_HOST, PORT: String(upstreamPort), VITE_PORT: String(upstreamPort), BROWSER: 'none' })
        : {};
      let dockerArgs: string[] | undefined;
      let containerName: string | undefined;
      let npmCli: string | undefined;
      let npmArgs: string[] = [];
      if (dockerExecution) {
        if (dockerExecution.installDependencies === 'npm-ci' && !snapshotInstall) throw officeError('Thiếu lockfile đã được xác nhận cho npm ci.', 422, 'PREVIEW_LOCKFILE_REQUIRED');
        containerName = `agent-office-preview-${this.ownerId.slice(0, 8)}-${id.slice(0, 8)}`;
        dockerArgs = dockerPreviewArgs({ containerName, ownerId: this.ownerId, workspace: snapshot.root, hostPort: upstreamPort, execution: dockerExecution, script: snapshotScript, install: Boolean(snapshotInstall) });
      } else {
        npmCli = await findNpmCli();
        npmArgs = previewNpmArgs(snapshotScript, UPSTREAM_HOST, upstreamPort);
      }
      const helperConfig = {
        mode: execution.mode,
        ttlMs: PREVIEW_TTL_MS,
        ...(dockerArgs && containerName ? { dockerArgs, containerName } : {}),
        ...(npmCli ? { npmCli, script: snapshotScript.name, npmArgs, cwd: snapshot.root, previewEnv: { HOST: UPSTREAM_HOST, PORT: String(upstreamPort), VITE_PORT: String(upstreamPort), BROWSER: 'none' } } : {}),
      };
      const supervisorEnv = execution.mode === 'local-trusted' ? previewEnv : await createRestrictedProcessEnv(snapshot.root);
      supervisor = spawn(process.execPath, [this.supervisorPath, Buffer.from(JSON.stringify(helperConfig)).toString('base64url')], {
        cwd: snapshot.root,
        env: supervisorEnv,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        shell: false,
      });
      const session: PreviewSession = {
        info: {
          id, projectId: input.projectId, script: script.name,
          url: `http://${PREVIEW_HOST}:${proxyPort}/`, createdAt, expiresAt,
          executionMode: execution.mode, networkAccess: true,
        },
        snapshot, upstreamPort, proxyPort, proxyServer, supervisor, output: '', stopping: false,
      };
      this.sessions.set(id, session);
      this.collectProcessOutput(session);
      try {
        await waitForSupervisor(supervisor, session, PREVIEW_START_TIMEOUT_MS);
        await waitForPreview(supervisor, session, PREVIEW_START_TIMEOUT_MS);
      } catch (error) {
        await this.stop(id);
        throw error;
      }
      return { ...session.info };
    } catch (error) {
      if (supervisor && !this.sessions.has(id)) await stopSupervisor(supervisor);
      await new Promise<void>((resolvePromise) => proxyServer?.close(() => resolvePromise()) ?? resolvePromise());
      await snapshot.cleanup();
      throw error;
    }
  }

  async stop(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    session.stopping = true;
    await stopSupervisor(session.supervisor);
    await new Promise<void>((resolvePromise) => {
      session.proxyServer.close(() => resolvePromise());
      session.proxyServer.closeAllConnections();
    });
    await session.snapshot.cleanup();
    return true;
  }

  async stopProject(projectId: string): Promise<void> {
    const session = this.activeForProject(projectId);
    if (session) await this.stop(session.id);
  }

  async closeAll(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  list(projectId?: string): WorkspacePreviewInfo[] {
    this.pruneExpiredMap();
    return [...this.sessions.values()].filter((session) => !projectId || session.info.projectId === projectId).map((session) => ({ ...session.info }));
  }

  private activeForProject(projectId: string): WorkspacePreviewInfo | null {
    this.pruneExpiredMap();
    const active = [...this.sessions.values()].find((session) => session.info.projectId === projectId);
    return active ? { ...active.info } : null;
  }

  private pruneExpiredMap(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) if (Date.parse(session.info.expiresAt) <= now) void this.stop(session.info.id);
  }

  private async expireSessions(): Promise<void> {
    this.pruneExpiredMap();
    for (const session of this.sessions.values()) {
      if (session.supervisor.exitCode !== null || session.supervisor.signalCode !== null) await this.stop(session.info.id);
    }
  }

  private collectProcessOutput(session: PreviewSession): void {
    const capture = (chunk: Buffer | string) => {
      const output = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      session.output = `${session.output}${output}`.slice(-8000);
    };
    session.supervisor.stdout?.on('data', capture);
    session.supervisor.stderr?.on('data', capture);
    session.supervisor.on('message', (message: PreviewSupervisorMessage) => {
      if (message.type !== 'process_exit' && message.type !== 'process_error') return;
      const status = message.type === 'process_exit'
        ? `Preview child exited with code ${message.code ?? 'unknown'}${message.signal ? ` (signal ${message.signal})` : ''}${message.stoppedBy ? `; supervisor stop reason: ${message.stoppedBy}` : ''}${message.context ? `; ${message.context}` : ''}.`
        : `Preview child error: ${message.message ?? 'unknown error'}.`;
      capture(`${status}${message.output ? `\n${message.output}` : ''}\n`);
    });
    session.supervisor.once('exit', () => {
      if (!session.stopping) void this.stop(session.info.id);
    });
  }
}

function previewScripts(scripts: Record<string, string>): PreviewScript[] {
  return ['preview', 'dev', 'start', 'serve'].flatMap((name) => {
    const command = scripts[name];
    if (typeof command !== 'string' || !command.trim()) return [];
    const lifecycle = [`pre${name}`, name, `post${name}`].flatMap((hook) => typeof scripts[hook] === 'string' && scripts[hook]!.trim() ? [{ name: hook, command: scripts[hook]! }] : []);
    return [{ name, command, lifecycle }];
  });
}

function previewNpmArgs(script: PreviewScript, host: string, port: number): string[] {
  const base = ['--silent', 'run', script.name];
  if (/(^|[/\\\s])vite(?:\s|$)/i.test(script.command)) return [...base, '--', '--host', host, '--port', String(port), '--strictPort'];
  if (/\bnext\s+(?:dev|start)\b/i.test(script.command)) return [...base, '--', '--hostname', host, '--port', String(port)];
  return base;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateDockerPreviewExecution(execution: DockerCheckExecution): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(execution.image)
    || !Number.isInteger(execution.memoryMb) || execution.memoryMb < 256 || execution.memoryMb > 16384
    || !Number.isFinite(execution.cpus) || execution.cpus < 0.25 || execution.cpus > 8 || execution.cpus * 4 % 1 !== 0
    || !Number.isInteger(execution.pidsLimit) || execution.pidsLimit < 32 || execution.pidsLimit > 1024) {
    throw officeError('Thiết lập giới hạn Docker cho preview không hợp lệ.', 422, 'PREVIEW_DOCKER_CONFIG_INVALID');
  }
}

function dockerPreviewArgs(input: { containerName: string; ownerId: string; workspace: string; hostPort: number; execution: DockerCheckExecution; script: PreviewScript; install: boolean }): string[] {
  const npmArgs = previewNpmArgs(input.script, '0.0.0.0', 3000);
  const command = `${input.install ? 'npm ci --no-audit --no-fund && ' : ''}npm ${npmArgs.map(shellQuote).join(' ')}`;
  return [
    'run', '--detach', '--rm', '--init', `--name=${input.containerName}`,
    `--label=com.agent-office.preview-owner=${input.ownerId}`,
    '--network=bridge', `--publish=127.0.0.1:${input.hostPort}:3000`,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    `--pids-limit=${input.execution.pidsLimit}`, `--memory=${input.execution.memoryMb}m`, `--memory-swap=${input.execution.memoryMb}m`, `--cpus=${input.execution.cpus}`,
    '--user=1000:1000', '--workdir=/workspace', `--volume=${resolve(input.workspace)}:/workspace:rw`,
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m', '--env=CI=true', '--env=HOME=/tmp/home', '--env=npm_config_cache=/tmp/npm-cache', '--env=HOST=0.0.0.0', '--env=PORT=3000', '--env=VITE_PORT=3000', '--env=BROWSER=none',
    input.execution.image, 'sh', '-lc', command,
  ];
}

async function reservePort(host: string): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolvePromise(); });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function listen(server: Server, host: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolvePromise(); });
  });
}

function waitForSupervisor(supervisor: ChildProcess, session: PreviewSession, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      supervisor.off('message', onMessage);
      supervisor.off('exit', onExit);
      if (error) reject(error); else resolvePromise();
    };
    const onMessage = (message: PreviewSupervisorMessage) => {
      if (message.type === 'started') finish();
      if (message.type === 'start_error' || message.type === 'process_error') finish(officeError(`Không thể chạy script preview. ${message.message ?? session.output.slice(-1500)}`, 422, 'PREVIEW_START_FAILED'));
    };
    const onExit = (code: number | null) => finish(officeError(`Process preview đã dừng trước khi mở trang (exit ${code ?? 'unknown'}). ${session.output.slice(-1000)}`, 422, 'PREVIEW_PROCESS_EXITED'));
    const timeout = setTimeout(() => finish(officeError('Process preview khởi động quá lâu.', 504, 'PREVIEW_START_TIMEOUT')), timeoutMs);
    timeout.unref();
    supervisor.on('message', onMessage);
    supervisor.once('exit', onExit);
  });
}

async function waitForPreview(supervisor: ChildProcess, session: PreviewSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) throw officeError(`Process preview đã dừng trước khi trang sẵn sàng. ${session.output.slice(-1000)}`, 422, 'PREVIEW_PROCESS_EXITED');
    if (await canConnect(session.upstreamPort)) {
      const response = await requestPreview(session.upstreamPort).catch(() => null);
      if (response) return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw officeError(`Website preview không phản hồi trong thời gian giới hạn. ${session.output.slice(-1200)}`, 504, 'PREVIEW_NOT_READY');
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect(port, UPSTREAM_HOST);
    const finish = (result: boolean) => { socket.destroy(); resolvePromise(result); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function requestPreview(port: number): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ hostname: UPSTREAM_HOST, port, path: '/', method: 'GET', timeout: 1000, headers: { 'Accept-Encoding': 'identity' } }, (res) => {
      res.resume();
      res.once('end', () => resolvePromise(true));
    });
    req.once('error', reject);
    req.once('timeout', () => { req.destroy(new Error('Preview request timed out.')); });
    req.end();
  });
}

async function stopSupervisor(supervisor: ChildProcess): Promise<void> {
  if (supervisor.exitCode !== null || supervisor.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => {
      if (supervisor.pid) {
        if (process.platform === 'win32') {
          const systemRoot = Object.keys(process.env).find((name) => name.toLowerCase() === 'systemroot');
          const taskkill = spawn(join(systemRoot ? process.env[systemRoot]! : 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(supervisor.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          taskkill.on('error', () => supervisor.kill('SIGKILL'));
        } else {
          try { process.kill(-supervisor.pid, 'SIGKILL'); } catch { supervisor.kill('SIGKILL'); }
        }
      }
      resolvePromise();
    }, 5000);
    timeout.unref();
    supervisor.once('exit', () => { clearTimeout(timeout); resolvePromise(); });
    supervisor.send?.({ type: 'stop' }, (error) => { if (error) supervisor.kill('SIGTERM'); });
  });
}

async function proxyRequest(req: IncomingMessage, res: ServerResponse, upstreamPort: number): Promise<void> {
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method ?? '')) { res.statusCode = 405; res.end('Method not allowed'); return; }
  const path = req.url ?? '/';
  let target: URL;
  try { target = new URL(path, `http://${UPSTREAM_HOST}:${upstreamPort}`); } catch { res.statusCode = 400; res.end('Bad preview path'); return; }
  if (target.origin !== `http://${UPSTREAM_HOST}:${upstreamPort}`) { res.statusCode = 400; res.end('Bad preview path'); return; }
  const headers: Record<string, string> = { host: `${UPSTREAM_HOST}:${upstreamPort}`, 'accept-encoding': 'identity' };
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || !MIME_HEADERS.has(name.toLowerCase())) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (req.headers.origin) headers.origin = `http://${UPSTREAM_HOST}:${upstreamPort}`;
  let requestBytes = 0;
  const upstream = request({ hostname: UPSTREAM_HOST, port: upstreamPort, path: `${target.pathname}${target.search}`, method: req.method, headers, timeout: 15_000 }, (response) => {
    res.statusCode = response.statusCode ?? 502;
    for (const [name, value] of Object.entries(response.headers)) {
      if (name === 'location' && typeof value === 'string') {
        const rewritten = rewriteRedirect(value, upstreamPort);
        if (!rewritten) { response.destroy(); res.statusCode = 502; res.end('External redirects are disabled in preview.'); return; }
        res.setHeader('Location', rewritten);
      } else if (RESPONSE_HEADERS.has(name) && value !== undefined) res.setHeader(name, value);
    }
    res.setHeader('Content-Security-Policy', previewCsp(PREVIEW_HOST, Number((res.req as IncomingMessage & { socket: Socket }).socket.localPort)));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    let responseBytes = 0;
    response.on('data', (chunk: Buffer) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_PROXY_RESPONSE_BYTES) {
        response.destroy();
        if (!res.headersSent) { res.statusCode = 502; res.end('Preview response exceeded the size limit.'); }
        else res.destroy();
      }
    });
    response.once('error', () => { if (!res.writableEnded) res.destroy(); });
    response.pipe(res);
  });
  upstream.once('timeout', () => upstream.destroy(new Error('Preview upstream timed out.')));
  upstream.once('error', () => { if (!res.headersSent) { res.statusCode = 502; res.end('Preview process is unavailable.'); } else res.destroy(); });
  req.on('data', (chunk: Buffer) => {
    requestBytes += chunk.byteLength;
    if (requestBytes > MAX_PROXY_REQUEST_BYTES) { req.destroy(); upstream.destroy(); }
  });
  req.once('aborted', () => upstream.destroy());
  res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, upstreamPort: number): void {
  if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const headers: Record<string, string> = { host: `${UPSTREAM_HOST}:${upstreamPort}`, origin: `http://${UPSTREAM_HOST}:${upstreamPort}` };
  for (const name of ['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const proxy = request({ hostname: UPSTREAM_HOST, port: upstreamPort, path: req.url ?? '/', method: 'GET', headers });
  proxy.once('upgrade', (response, upstream, upstreamHead) => {
    const status = response.statusMessage ?? 'Switching Protocols';
    socket.write(`HTTP/1.1 101 ${status}\r\n`);
    for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) socket.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
    socket.write('\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
  });
  proxy.once('response', (response) => { response.resume(); socket.end('HTTP/1.1 502 Preview websocket unavailable\r\n\r\n'); });
  proxy.once('error', () => socket.destroy());
  proxy.end();
}

function rewriteRedirect(location: string, upstreamPort: number): string | null {
  try {
    const target = new URL(location, `http://${UPSTREAM_HOST}:${upstreamPort}`);
    if (target.origin !== `http://${UPSTREAM_HOST}:${upstreamPort}`) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch { return null; }
}

function previewCsp(previewHost: string, previewPort: number): string {
  return `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://${previewHost}:${previewPort}; media-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'`;
}


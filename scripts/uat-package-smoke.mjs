import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageDir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass the UAT package directory as the first argument.');
if (existsSync(join(packageDir, '.env'))) throw new Error('The UAT package must not contain a .env file.');
const dataDir = await mkdtemp(join(tmpdir(), 'agent-office-uat-package-'));
const port = await findPort();
const env = { ...process.env,
  OFFICE_HOST: '127.0.0.1',
  OFFICE_PORT: String(port),
  OFFICE_DATA_DIR: dataDir,
  OFFICE_CONFIG_DIR: packageDir,
  OFFICE_EXECUTION_MODE: 'disabled',
};
for (const key of [
  'MODEL_PRIMARY_BASE_URL', 'MODEL_PRIMARY_API_KEY', 'MODEL_PRIMARY_NAME',
  'MODEL_RESPONSES_BASE_URL', 'MODEL_RESPONSES_API_KEY', 'MODEL_RESPONSES_NAME',
  'RESEARCH_BRAVE_API_KEY',
]) delete env[key];

let server;
let serverOutput = '';
try {
  const validation = await runCli(packageDir, 'dist/server/platform-cli.js', ['validate'], env);
  if (validation.code !== 0 || !validation.stdout.includes('registry')) {
    throw new Error(`Offline config validation failed: ${validation.stderr || validation.stdout}`);
  }
  server = spawn(process.execPath, ['dist/server/platform.js'], { cwd: packageDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-8_000); });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-8_000); });
  const health = await waitForHealth(server, port, serverOutput);
  const office = await fetch(`http://127.0.0.1:${port}/office`, { signal: AbortSignal.timeout(5_000) });
  if (!office.ok) throw new Error(`Office page returned HTTP ${office.status}.`);
  const officeHtml = await office.text();
  const staticReferences = [...officeHtml.matchAll(/\b(?:src|href)="(\/(?:bundle|assets)\/[^\"]+)"/g)]
    .map((match) => match[1]);
  if (staticReferences.length === 0 || !staticReferences.some((path) => path.startsWith('/bundle/'))) {
    throw new Error('Office entry page did not contain its bundled scripts and assets.');
  }
  const staticResponses = await Promise.all(staticReferences.map((path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000) })));
  const failedStaticReferences = staticReferences.filter((_, index) => !staticResponses[index].ok);
  if (failedStaticReferences.length > 0) throw new Error(`Office static assets were not served: ${failedStaticReferences.join(', ')}.`);
  const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  if (root.status !== 302 || root.headers.get('location') !== '/office') throw new Error('Root URL did not redirect to the Agent Office page.');
  const legacyPage = await fetch(`http://127.0.0.1:${port}/index.html`, { signal: AbortSignal.timeout(5_000) });
  if (legacyPage.status !== 404) throw new Error(`Legacy Habblaud page remained exposed at HTTP ${legacyPage.status}.`);
  const traversalPaths = [
    '/bundle/..%5Cindex.html',
    '/assets/..%5cindex.html',
    '/bundle/%2e%2e%5cindex.html',
    '/bundle/..%2findex.html',
  ];
  const traversalResponses = await Promise.all(traversalPaths.map((path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000) })));
  const exposedTraversal = traversalPaths.flatMap((path, index) => traversalResponses[index].status !== 404
    ? [`${path} returned HTTP ${traversalResponses[index].status}`]
    : []);
  if (exposedTraversal.length > 0) throw new Error(`Encoded path traversal exposed a page: ${exposedTraversal.join(', ')}.`);
  const doctorResult = await runCli(packageDir, 'dist/server/platform-cli.js', ['doctor'], env);
  if (doctorResult.code !== 0) throw new Error(`Doctor failed: ${doctorResult.stderr || doctorResult.stdout}`);
  const doctor = parseJson(doctorResult.stdout);
  if (doctor.ok !== true
    || doctor.storage?.schemaVersion !== 15
    || doctor.storage?.integrity !== 'ok'
    || doctor.storage?.requiredTables !== 'ok'
    || doctor.storage?.foreignKeyViolations !== 0
    || doctor.readiness?.chatConfigured !== false
    || doctor.readiness?.executionMode !== 'disabled') {
    throw new Error(`Doctor returned unexpected isolated UAT state: ${JSON.stringify(doctor)}`);
  }
  await stopServer(server);
  server = undefined;
  const portReleased = await isPortReleased(port);
  if (!portReleased) throw new Error(`Port ${port} remained occupied after server shutdown.`);
  console.log(JSON.stringify({
    ok: true,
    packageDir,
    packageEnvAbsent: true,
    configValidation: 'passed offline',
    healthStatus: health,
    officeStatus: office.status,
    staticAssetCount: staticReferences.length,
    rootRedirect: root.headers.get('location'),
    legacyHabblaudPageStatus: legacyPage.status,
    encodedLegacyTraversalStatuses: traversalResponses.map(({ status }) => status),
    doctor: doctor.storage,
    modelUnconfigured: !doctor.readiness.chatConfigured,
    executionMode: doctor.readiness.executionMode,
    portReleased,
    externalProviderCalls: 0,
  }));
} catch (error) {
  if (server) await stopServer(server).catch(() => undefined);
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    serverOutput,
  }));
  process.exitCode = 1;
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

async function runCli(cwd, entry, args, childEnv) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  return { code, stdout, stderr };
}

async function waitForHealth(child, port, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Production server exited before becoming healthy: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/platform/v1/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.status;
    } catch { /* Keep waiting until the server is ready or the deadline is reached. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Production health endpoint did not become ready: ${output}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exit = await Promise.race([
    waitForExit(child),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 5_000)),
  ]);
  if (exit === null) {
    child.kill('SIGKILL');
    await Promise.race([
      waitForExit(child),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 5_000)),
    ]);
    throw new Error('Production server did not stop after SIGTERM.');
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => child.once('exit', () => resolveExit(true)));
}

async function findPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate an isolated smoke-test port.');
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function isPortReleased(port) {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolveResult(false); });
    socket.once('error', () => resolveResult(true));
  });
}

function parseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`CLI did not return JSON: ${text}`);
  return JSON.parse(text.slice(start));
}

import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const newerDir = resolve(option('--newer', 'release/agent-office-0.1.0-uat-r25-20261026'));
const olderDir = resolve(option('--older', 'release/agent-office-0.1.0-uat-r22-20261026'));
for (const directory of [newerDir, olderDir]) {
  if (!existsSync(join(directory, 'dist/server/platform.js'))) throw new Error(`No production server bundle exists at ${directory}.`);
  if (existsSync(join(directory, '.env'))) throw new Error(`Refusing to run a package containing .env: ${directory}.`);
}

const dataDir = await mkdtemp(join(tmpdir(), 'agent-office-package-rollback-'));
const port = await findPort();
const baseEnv = { ...process.env,
  OFFICE_HOST: '127.0.0.1',
  OFFICE_PORT: String(port),
  OFFICE_DATA_DIR: dataDir,
  OFFICE_EXECUTION_MODE: 'disabled',
};
for (const key of [
  'MODEL_PRIMARY_BASE_URL', 'MODEL_PRIMARY_API_KEY', 'MODEL_PRIMARY_NAME',
  'MODEL_RESPONSES_BASE_URL', 'MODEL_RESPONSES_API_KEY', 'MODEL_RESPONSES_NAME',
  'RESEARCH_BRAVE_API_KEY',
]) delete baseEnv[key];

let server;
let serverOutput = '';
let createdProject;
try {
  const newerEnv = { ...baseEnv, OFFICE_CONFIG_DIR: newerDir };
  await startPackage(newerDir, newerEnv, 'newer');
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/platform/v1/session`, { signal: AbortSignal.timeout(5_000) });
  if (!sessionResponse.ok) throw new Error(`Newer package session returned HTTP ${sessionResponse.status}.`);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
  if (typeof session.csrfToken !== 'string' || !cookie) throw new Error('Newer package did not issue a local CSRF session.');
  const projectName = `Rollback smoke ${new Date().toISOString()}`;
  const createResponse = await fetch(`http://127.0.0.1:${port}/platform/v1/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
      Cookie: cookie,
      'X-CSRF-Token': session.csrfToken,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ name: projectName, goal: 'Verify a same-schema package rollback preserves owner data.' }),
    signal: AbortSignal.timeout(5_000),
  });
  if (createResponse.status !== 201) throw new Error(`Newer package project creation returned HTTP ${createResponse.status}.`);
  const created = await createResponse.json();
  createdProject = created.project;
  if (!createdProject?.id || createdProject.name !== projectName) throw new Error('Newer package did not persist the rollback fixture room.');
  await stopServer(server);
  server = undefined;
  if (!await isPortReleased(port)) throw new Error('Newer package did not release its port after shutdown.');

  const olderEnv = { ...baseEnv, OFFICE_CONFIG_DIR: olderDir };
  await startPackage(olderDir, olderEnv, 'older');
  const [officeResponse, projectsResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/platform/v1/office`, { signal: AbortSignal.timeout(5_000) }),
    fetch(`http://127.0.0.1:${port}/platform/v1/projects`, { signal: AbortSignal.timeout(5_000) }),
  ]);
  if (!officeResponse.ok || !projectsResponse.ok) throw new Error(`Older package returned HTTP ${officeResponse.status}/${projectsResponse.status} for office/projects.`);
  const office = await officeResponse.json();
  const projectList = await projectsResponse.json();
  const restoredProject = projectList.projects?.find((project) => project.id === createdProject.id);
  if (!restoredProject || restoredProject.name !== createdProject.name) throw new Error('Older package did not preserve the room created by the newer package.');
  if (!office.snapshot?.projects?.some((project) => project.id === createdProject.id)) throw new Error('Older package office snapshot omitted the preserved room.');

  const doctor = await runCli(olderDir, 'dist/server/platform-cli.js', ['doctor'], olderEnv);
  if (doctor.code !== 0) throw new Error(`Older package doctor failed: ${doctor.stderr || doctor.stdout}`);
  const doctorResult = parseJson(doctor.stdout);
  if (doctorResult.ok !== true
    || doctorResult.storage?.schemaVersion !== 15
    || doctorResult.storage?.integrity !== 'ok'
    || doctorResult.storage?.requiredTables !== 'ok'
    || doctorResult.storage?.foreignKeyViolations !== 0
    || doctorResult.readiness?.chatConfigured !== false
    || doctorResult.readiness?.executionMode !== 'disabled') {
    throw new Error(`Older package doctor reported unexpected rollback state: ${JSON.stringify(doctorResult)}`);
  }
  await stopServer(server);
  server = undefined;
  const portReleased = await isPortReleased(port);
  if (!portReleased) throw new Error('Older package did not release its port after shutdown.');
  console.log(JSON.stringify({
    ok: true,
    newerPackage: newerDir,
    olderPackage: olderDir,
    dataDirectoryIsolated: true,
    projectPreserved: { id: createdProject.id, name: createdProject.name },
    healthStatus: 200,
    officeStatus: officeResponse.status,
    projectsStatus: projectsResponse.status,
    doctor: doctorResult.storage,
    executionMode: doctorResult.readiness.executionMode,
    externalProviderCalls: 0,
    portReleased,
  }));
} catch (error) {
  if (server) await stopServer(server).catch(() => undefined);
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), serverOutput }));
  process.exitCode = 1;
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

async function startPackage(directory, env, label) {
  serverOutput = '';
  server = spawn(process.execPath, ['dist/server/platform.js'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-8_000); });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-8_000); });
  await waitForHealth(server, label);
  const office = await fetch(`http://127.0.0.1:${port}/office`, { signal: AbortSignal.timeout(5_000) });
  if (!office.ok) throw new Error(`${label} package office returned HTTP ${office.status}.`);
}

async function waitForHealth(child, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} package exited before becoming healthy: ${serverOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/platform/v1/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* Wait for startup until the bounded deadline. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`${label} package did not become healthy: ${serverOutput}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  if (exited) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  throw new Error('Package server did not stop after SIGTERM.');
}

async function runCli(cwd, entry, args, env) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function findPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate rollback-smoke port.');
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function isPortReleased(candidate) {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: '127.0.0.1', port: candidate });
    socket.once('connect', () => { socket.destroy(); resolveResult(false); });
    socket.once('error', () => resolveResult(true));
  });
}

function parseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`CLI did not return JSON: ${text}`);
  return JSON.parse(text.slice(start));
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a package directory.`);
  return value;
}

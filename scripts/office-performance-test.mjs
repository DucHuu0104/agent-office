import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, totalmem, cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const dataDir = await mkdtemp(join(tmpdir(), 'agent-office-performance-'));
const configDir = join(dataDir, 'config');
const dataPath = join(dataDir, 'data');
await mkdir(configDir, { recursive: true });
for (const entry of ['agents', 'skills', 'config']) await cp(join(root, entry), join(configDir, entry), { recursive: true });

const policyPath = join(configDir, 'config', 'policies.yaml');
const policy = await readFile(policyPath, 'utf8');
if (!policy.includes('maxConcurrentRequestsPerProvider: 2')) throw new Error('Expected the checked-in provider concurrency limit of two before preparing the isolated performance fixture.');
await writeFile(policyPath, policy.replace('maxConcurrentRequestsPerProvider: 2', 'maxConcurrentRequestsPerProvider: 4'));

const port = await findPort();
let fakeProviderRequests = 0;
const fakeModel = createHttpServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  fakeProviderRequests++;
  // Keep each request open at the provider boundary. The runtime holds four
  // real execution slots while no model latency or billable provider is used.
  response.on('close', () => {});
});
await new Promise((resolveListen, reject) => fakeModel.once('error', reject).listen(0, '127.0.0.1', resolveListen));
const providerAddress = fakeModel.address();
if (!providerAddress || typeof providerAddress === 'string') throw new Error('Could not start the local fake provider.');

const childEnv = {
  PATH: process.env.PATH ?? '',
  ...(process.platform === 'win32' ? {
    SystemRoot: process.env.SystemRoot ?? '', WINDIR: process.env.WINDIR ?? '', TEMP: dataDir, TMP: dataDir,
  } : { HOME: dataDir, TMPDIR: dataDir }),
  OFFICE_HOST: '127.0.0.1',
  OFFICE_PORT: String(port),
  OFFICE_DATA_DIR: dataPath,
  OFFICE_CONFIG_DIR: configDir,
  OFFICE_DEFAULT_LOCALE: 'en',
  OFFICE_EXECUTION_MODE: 'disabled',
  OFFICE_MAX_RUNNING_EXECUTIONS: '4',
  OFFICE_MAX_SPECIALIST_EXECUTIONS: '3',
  MODEL_PRIMARY_BASE_URL: `http://127.0.0.1:${providerAddress.port}/v1`,
  MODEL_PRIMARY_API_KEY: 'local-performance-fixture-key',
  MODEL_PRIMARY_NAME: 'local-performance-fixture',
  RESEARCH_BRAVE_API_KEY: '',
};

const child = spawn(process.execPath, [resolve(root, 'dist/server/platform.js')], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let childOutput = '';
let spawnError;
child.once('error', (error) => { spawnError = error; });
child.stdout.setEncoding('utf8').on('data', (chunk) => { childOutput = (childOutput + chunk).slice(-12_000); });
child.stderr.setEncoding('utf8').on('data', (chunk) => { childOutput = (childOutput + chunk).slice(-12_000); });

let browser;
let sessionCookie;
let csrfToken;
let runIds = [];
try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(child, baseUrl, () => childOutput, () => spawnError);
  const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
  if (!sessionResponse.ok) throw new Error(`Session endpoint returned HTTP ${sessionResponse.status}.`);
  sessionCookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
  csrfToken = (await sessionResponse.json()).csrfToken;
  if (!sessionCookie || !csrfToken) throw new Error('Isolated server did not create an HTTP session and CSRF token.');

  const createProject = async (name, key) => {
    const response = await api('POST', '/projects', { name, goal: 'Local performance fixture; no workspace writes.' }, key);
    if (response.status !== 201) throw new Error(`Project creation returned HTTP ${response.status}.`);
    return response.body.project;
  };
  const initialProjects = [];
  for (let index = 0; index < 10; index++) initialProjects.push(await createProject(`Performance room ${index + 1}`, `performance-project-${index}-initial`));

  for (const [index, project] of initialProjects.slice(0, 4).entries()) {
    const sent = await api('POST', `/conversations/${encodeURIComponent(project.conversationId)}/messages`, {
      text: `Hold this execution at the local fake provider for performance sample ${index + 1}.`,
    }, `performance-run-${index}-message`);
    if (sent.status !== 202) throw new Error(`Run creation returned HTTP ${sent.status}.`);
    runIds.push(sent.body.runId);
  }
  await waitFor(async () => fakeProviderRequests === 4, 15_000, 'four concurrent requests to reach the local fake provider');
  const activeSnapshot = await fetch(`${baseUrl}/platform/v1/office`).then((response) => response.json());
  if (activeSnapshot.snapshot.activeRuns !== 4) throw new Error(`Expected four active runs, saw ${activeSnapshot.snapshot.activeRuns}.`);

  const timings = { projectListMs: [], officeSnapshotMs: [], projectReadMs: [], projectCreateMs: [], projectArchiveMs: [], projectRestoreMs: [] };
  const measure = async (target, action) => {
    const start = performance.now();
    const response = await action();
    const duration = performance.now() - start;
    if (!response.ok) throw new Error(`${target} returned HTTP ${response.status}.`);
    target.push(Number(duration.toFixed(2)));
    return response;
  };
  // Warm the same public HTTP/API and SQLite paths without mixing warm-up into p95.
  for (const action of [
    () => fetch(`${baseUrl}/platform/v1/projects`),
    () => fetch(`${baseUrl}/platform/v1/office`),
    () => fetch(`${baseUrl}/platform/v1/projects/${initialProjects[4].id}`),
  ]) {
    const response = await action();
    if (!response.ok) throw new Error(`API warm-up returned HTTP ${response.status}.`);
  }

  for (let index = 0; index < 30; index++) {
    await measure(timings.projectListMs, () => fetch(`${baseUrl}/platform/v1/projects`));
    await measure(timings.officeSnapshotMs, () => fetch(`${baseUrl}/platform/v1/office`));
    const createResponse = await measure(timings.projectCreateMs, () => api('POST', '/projects', {
      name: `CRUD sample ${index + 1}`, goal: 'Temporary benchmark record.',
    }, `performance-crud-${index}`));
    const project = createResponse.body.project;
    await measure(timings.projectReadMs, () => fetch(`${baseUrl}/platform/v1/projects/${project.id}`));
    await measure(timings.projectArchiveMs, () => api('POST', `/projects/${project.id}/archive`));
    await measure(timings.projectRestoreMs, () => api('POST', `/projects/${project.id}/restore`));
    // Leave each sample archived so active-room count and snapshot size stay bounded.
    const finalArchive = await api('POST', `/projects/${project.id}/archive`);
    if (finalArchive.status !== 200) throw new Error(`Final sample cleanup returned HTTP ${finalArchive.status}.`);
  }
  const apiStats = Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, summarize(values)]));
  const apiP95 = percentile(Object.values(timings).flat(), 0.95);
  const maximumOperationP95 = Math.max(...Object.values(timings).map((values) => percentile(values, 0.95)));
  if (apiP95 >= 300 || maximumOperationP95 >= 300) throw new Error(`Four-run CRUD performance exceeded the 300 ms p95 target (overall=${apiP95} ms, operation maximum=${maximumOperationP95} ms).`);

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.addInitScript(() => {
    window.__officePerfEvents = [];
    const original = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function (type, listener, options) {
      if (type !== 'office.event' || typeof listener !== 'function') return original.call(this, type, listener, options);
      const wrapped = function (event) {
        try {
          const envelope = JSON.parse(event.data);
          if (envelope.type === 'agent.draining' || envelope.type === 'agent.resumed') {
            window.__officePerfEvents.push({
              type: envelope.type,
              agentId: envelope.payload.agentInstanceId,
              draining: envelope.payload.draining,
              occurredAt: envelope.occurredAt,
              receivedAt: Date.now(),
              uiAt: null,
            });
          }
        } catch { /* The application owns normal SSE validation and recovery. */ }
        return listener.call(this, event);
      };
      return original.call(this, type, wrapped, options);
    };
    const observe = new MutationObserver(() => {
      for (const event of window.__officePerfEvents) {
        if (event.uiAt !== null) continue;
        const button = document.querySelector(`[data-agent-drain="${CSS.escape(event.agentId)}"]`);
        if (button && button.dataset.draining === String(event.draining)) event.uiAt = Date.now();
      }
    });
    const startObserving = () => observe.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-draining'] });
    if (document.documentElement) startObserving();
    else document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  });
  await page.goto(`${baseUrl}/office`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  const targetAgentId = 'developer-01';
  await page.locator(`[data-agent-drain="${targetAgentId}"]`).waitFor({ state: 'visible', timeout: 10_000 });
  const eventLatencyMs = [];
  const eventReceiptMs = [];
  for (let index = 0; index < 30; index++) {
    const draining = index % 2 === 0;
    const eventStart = await page.evaluate(() => window.__officePerfEvents.length);
    const response = await page.evaluate(async ({ agentId, draining }) => {
      const session = await fetch('/platform/v1/session').then((item) => item.json());
      const response = await fetch(`/platform/v1/agents/${encodeURIComponent(agentId)}/drain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ draining }),
      });
      return { status: response.status, body: await (response.ok ? response.json() : response.text()) };
    }, { agentId: targetAgentId, draining });
    if (response.status !== 200) throw new Error(`Agent drain request returned HTTP ${response.status}.`);
    await page.waitForFunction(({ agentId, draining }) => {
      const button = document.querySelector(`[data-agent-drain="${CSS.escape(agentId)}"]`);
      return button?.dataset.draining === String(draining);
    }, { agentId: targetAgentId, draining }, { timeout: 5_000 });
    const sample = await page.evaluate(({ eventStart, agentId, draining }) => window.__officePerfEvents
      .slice(eventStart)
      .findLast((event) => event.agentId === agentId && event.draining === draining && event.uiAt !== null), { eventStart, agentId: targetAgentId, draining });
    if (!sample) throw new Error(`The Agent Office UI did not render the committed agent.${draining ? 'draining' : 'resumed'} event.`);
    const latency = sample.uiAt - Date.parse(sample.occurredAt);
    const receipt = sample.receivedAt - Date.parse(sample.occurredAt);
    if (!Number.isFinite(latency) || latency < 0 || !Number.isFinite(receipt) || receipt < 0) throw new Error(`Invalid event timing sample: ${JSON.stringify(sample)}.`);
    eventLatencyMs.push(Number(latency.toFixed(2)));
    eventReceiptMs.push(Number(receipt.toFixed(2)));
  }
  const eventStats = summarize(eventLatencyMs);
  if (eventStats.p95 >= 1_000) throw new Error(`Committed-event-to-visible-UI p95 exceeded 1,000 ms (${eventStats.p95} ms).`);
  if (browserErrors.length) throw new Error(`Performance browser smoke reported errors: ${browserErrors.join('\n')}`);

  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    environment: {
      platform: `${process.platform} ${release()}`,
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      ramGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
      browser: browser.version(),
      headless: true,
    },
    workload: { activeExecutions: activeSnapshot.snapshot.activeRuns, heldFakeProviderRequests: fakeProviderRequests, apiSamplesPerOperation: 30, eventSamples: eventLatencyMs.length, activeProjectsDuringApiBenchmark: 10 },
    api: { overallP95Ms: apiP95, maximumOperationP95Ms: maximumOperationP95, operations: apiStats },
    committedEventToUi: { p95Ms: eventStats.p95, p50Ms: eventStats.p50, maxMs: eventStats.max, eventCommitTimestampBasis: 'DomainEvent.occurredAt is stamped immediately before the SQLite transaction; measured until the visible agent drain control reflects that durable event.' },
    eventCommitToSseHandler: summarize(eventReceiptMs),
    thresholds: { apiCrudP95Ms: 300, eventToVisibleUiP95Ms: 1_000 },
    result: 'pass',
  };
  const reportDir = join(root, 'evals', 'results');
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `office-performance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, reportPath, ...report }, null, 2));

  async function api(method, path, body, key) {
    const headers = { Cookie: sessionCookie, 'X-CSRF-Token': csrfToken };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(`${baseUrl}${`/platform/v1${path}`}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let parsed;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { status: response.status, ok: response.ok, body: parsed };
  }
} finally {
  await browser?.close().catch(() => undefined);
  if (runIds.length && sessionCookie && csrfToken) {
    await Promise.allSettled(runIds.map((runId) => fetch(`http://127.0.0.1:${port}/platform/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST', headers: { Cookie: sessionCookie, 'X-CSRF-Token': csrfToken }, signal: AbortSignal.timeout(5_000),
    })));
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    if (!await waitForExit(child, 5_000)) {
      child.kill('SIGKILL');
      if (!await waitForExit(child, 5_000)) console.error(`Temporary server did not stop cleanly; data retained at ${dataDir}.`);
    }
  }
  fakeModel.closeAllConnections();
  await new Promise((resolveClose) => fakeModel.close(() => resolveClose()));
  if (child.exitCode !== null || child.signalCode !== null) await rm(dataDir, { recursive: true, force: true });
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: Number((sorted.at(-1) ?? 0).toFixed(2)),
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return Number((sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0).toFixed(2));
}

async function findPort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port.');
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForHealth(child, baseUrl, getOutput, getSpawnError) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (getSpawnError()) throw getSpawnError();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Temporary server exited before health: ${getOutput()}`);
    try {
      const response = await fetch(`${baseUrl}/platform/v1/health`, { signal: AbortSignal.timeout(700) });
      if (response.ok) return;
    } catch { /* The child may still be initializing SQLite and migrations. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Temporary server did not become healthy: ${getOutput()}`);
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveResult) => {
    const timer = setTimeout(() => resolveResult(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolveResult(true); });
  });
}

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = process.cwd();
const dataDir = await mkdtemp(join(tmpdir(), 'agent-office-browser-'));
const configDir = join(dataDir, 'config');
await mkdir(configDir, { recursive: true });
for (const entry of ['agents', 'skills', 'config']) await cp(join(root, entry), join(configDir, entry), { recursive: true });
const port = await findPort();
let releaseWriterCall = () => {};
let markWriterCallStarted = () => {};
const writerCallStarted = new Promise((resolve) => { markWriterCallStarted = resolve; });
const writerCallGate = new Promise((resolve) => { releaseWriterCall = resolve; });
let releaseFinalResponse = () => {};
let markFinalResponseStarted = () => {};
const finalResponseStarted = new Promise((resolve) => { markFinalResponseStarted = resolve; });
const finalResponseGate = new Promise((resolve) => { releaseFinalResponse = resolve; });
let releaseDesignerCall = () => {};
let markDesignerCallStarted = () => {};
const designerCallStarted = new Promise((resolve) => { markDesignerCallStarted = resolve; });
const designerCallGate = new Promise((resolve) => { releaseDesignerCall = resolve; });
let releaseDesignerFinalResponse = () => {};
let markDesignerFinalResponseStarted = () => {};
const designerFinalResponseStarted = new Promise((resolve) => { markDesignerFinalResponseStarted = resolve; });
const designerFinalResponseGate = new Promise((resolve) => { releaseDesignerFinalResponse = resolve; });
let releaseRapidWriterTool = () => {};
let markRapidWriterToolStarted = () => {};
const rapidWriterToolStarted = new Promise((resolve) => { markRapidWriterToolStarted = resolve; });
const rapidWriterToolGate = new Promise((resolve) => { releaseRapidWriterTool = resolve; });
let releaseRapidDesignerTool = () => {};
let markRapidDesignerToolStarted = () => {};
const rapidDesignerToolStarted = new Promise((resolve) => { markRapidDesignerToolStarted = resolve; });
const rapidDesignerToolGate = new Promise((resolve) => { releaseRapidDesignerTool = resolve; });
let fakeModelRequestCount = 0;
const fakeModelTrace = [];
const fakeModelServer = createHttpServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    void (async () => {
      fakeModelRequestCount++;
      const payload = JSON.parse(raw);
      const toolNames = (payload.tools ?? []).map((tool) => tool.function?.name ?? '');
      const messages = payload.messages ?? [];
      const rapidWriterRequest = messages.some((message) => typeof message.content === 'string'
        && (message.content.includes('RAPID_WRITER_E2E_REQUEST') || message.content.includes('RAPID_WRITER_TOOL_GATE')));
      const rapidDesignerRequest = messages.some((message) => typeof message.content === 'string'
        && (message.content.includes('RAPID_DESIGNER_E2E_REQUEST') || message.content.includes('RAPID_DESIGNER_TOOL_GATE')));
      const isDesignerRequest = messages.some((message) => typeof message.content === 'string'
        && (message.content.includes('DESIGNER_E2E_REQUEST') || message.content.includes('DESIGNER_E2E_AGENT_MARKER')))
        || rapidDesignerRequest;
      fakeModelTrace.push({
        toolNames,
        markerSeen: isDesignerRequest,
        messages: messages.slice(-4).map((message) => ({ role: message.role, content: typeof message.content === 'string' ? message.content.slice(0, 240) : typeof message.content })),
      });
      const responseId = `browser-model-${fakeModelRequestCount}`;
      if (toolNames.includes('submit_plan')) {
        const plan = isDesignerRequest ? {
          goal: 'Prepare a design brief with a reviewable artifact.',
          successCriteria: ['The config-added Designer creates the requested markdown artifact.'],
          tasks: [{ key: 'design',
            title: rapidDesignerRequest ? 'Create the concurrent design brief' : 'Create the design brief',
            objective: rapidDesignerRequest
              ? 'RAPID_DESIGNER_TOOL_GATE: Create a concise design brief and save it as a markdown artifact.'
              : 'Create a concise design brief and save it as a markdown artifact.',
            capability: 'design.layout', dependsOn: [] }],
        } : {
          goal: 'Create a short project introduction with a reviewable artifact.',
          successCriteria: ['Writer creates the requested markdown artifact.'],
          tasks: [{ key: 'writing',
            title: rapidWriterRequest ? 'Draft the concurrent project introduction' : 'Draft the project introduction',
            objective: rapidWriterRequest
              ? 'RAPID_WRITER_TOOL_GATE: Write a short project introduction and save it as a markdown artifact.'
              : 'Write a short project introduction and save it as a markdown artifact.',
            capability: 'writing.draft', dependsOn: [] }],
        };
        return sendModelStream(response, [
          { id: responseId, choices: [{ delta: { tool_calls: [{ index: 0, id: `${responseId}-plan`, type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(plan) } }] }, finish_reason: null }] },
          { id: responseId, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
        ]);
      }
      if (toolNames.includes('create_artifact') && !messages.some((message) => message.role === 'tool')) {
        if (isDesignerRequest) {
          if (rapidDesignerRequest) {
            markRapidDesignerToolStarted();
            await rapidDesignerToolGate;
          } else {
            markDesignerCallStarted();
            await designerCallGate;
          }
          return sendModelStream(response, [
            { id: responseId, choices: [{ delta: { tool_calls: [{ index: 0, id: `${responseId}-designer-artifact`, type: 'function', function: { name: 'create_artifact', arguments: JSON.stringify({ name: 'design-brief.md', content: '# Design brief\n\nPrepared by the config-added Designer.', mimeType: 'text/markdown' }) } }] }, finish_reason: null }] },
            { id: responseId, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } },
          ]);
        }
        if (rapidWriterRequest) {
          markRapidWriterToolStarted();
          await rapidWriterToolGate;
        } else {
          markWriterCallStarted();
          await writerCallGate;
        }
        return sendModelStream(response, [
          { id: responseId, choices: [{ delta: { tool_calls: [{ index: 0, id: `${responseId}-artifact`, type: 'function', function: { name: 'create_artifact', arguments: JSON.stringify({ name: 'browser-assignment.md', content: '# Browser assignment smoke\n\nCreated by the assigned Writer.\n\n<script>window.previewExecuted = true</script>', mimeType: 'text/markdown' }) } }] }, finish_reason: null }] },
          { id: responseId, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } },
        ]);
      }
      const content = isDesignerRequest
        ? 'The Designer created and verified the design brief artifact.'
        : messages.some((message) => message.role === 'tool')
          ? 'The Writer created and verified the project introduction artifact.'
          : 'The assigned writing task completed successfully.';
      if (isDesignerRequest && messages.some((message) => message.role === 'tool')) {
        markDesignerFinalResponseStarted();
        await designerFinalResponseGate;
      } else if (messages.some((message) => message.role === 'tool')) {
        markFinalResponseStarted();
        await finalResponseGate;
      }
      return sendModelStream(response, [
        { id: responseId, choices: [{ delta: { content }, finish_reason: null }] },
        { id: responseId, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 28, completion_tokens: 10, total_tokens: 38 } },
      ]);
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'Fake browser-test model failed.');
    });
  });
});
await new Promise((resolveListen, reject) => fakeModelServer.once('error', reject).listen(0, '127.0.0.1', resolveListen));
const modelAddress = fakeModelServer.address();
if (!modelAddress || typeof modelAddress === 'string') throw new Error('Could not start the fake local model provider.');
const childEnv = {
  PATH: process.env.PATH ?? '',
  ...(process.platform === 'win32' ? {
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TEMP: dataDir,
    TMP: dataDir,
  } : {
    HOME: dataDir,
    TMPDIR: dataDir,
  }),
  OFFICE_HOST: '127.0.0.1',
  OFFICE_PORT: String(port),
  OFFICE_DATA_DIR: join(dataDir, 'data'),
  OFFICE_CONFIG_DIR: configDir,
  OFFICE_DEFAULT_LOCALE: 'en',
  OFFICE_EXECUTION_MODE: 'disabled',
  MODEL_PRIMARY_BASE_URL: `http://127.0.0.1:${modelAddress.port}/v1`,
  MODEL_PRIMARY_API_KEY: 'browser-test-only-key',
  MODEL_PRIMARY_NAME: 'browser-test-fake-model',
  RESEARCH_BRAVE_API_KEY: '',
};
const child = spawn(process.execPath, [resolve(root, 'dist/server/platform.js')], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let spawned = false;
let spawnError;
child.once('spawn', () => { spawned = true; });
child.on('error', (error) => { spawnError = error; });
child.stdout.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-20_000); });
child.stderr.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-20_000); });

let browser;
let liveWorkingScreenshot = null;
try {
  await waitForHealth(child, port, join(dataDir, 'data', 'agent-office.sqlite'), () => output, () => spawnError);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const projectCreateTrace = [];
  let intentionalOffline = false;
  let intentionalApprovalConflict = false;
  let expectedOfflineResourceErrors = 0;
  let expectedApprovalConflictErrors = 0;
  let eventStreamRequests = 0;
  const chatSubmitTrace = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  page.on('request', (request) => {
    if (request.url().includes('/platform/v1/events?')) eventStreamRequests++;
    try {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/messages')) chatSubmitTrace.push(`${request.method()} ${url.pathname} requested`);
    } catch { /* Ignore non-URL request values from browser internals. */ }
  });
  page.on('response', (response) => {
    try {
      const url = new URL(response.url());
      if (url.pathname.endsWith('/messages')) chatSubmitTrace.push(`${response.status()} ${url.pathname} response`);
      if (url.pathname === '/platform/v1/projects' && response.request().method() === 'POST') projectCreateTrace.push(`${response.status()} POST ${url.pathname}`);
    } catch { /* Ignore non-URL response values from browser internals. */ }
  });
  page.on('requestfailed', (request) => {
    try {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/messages')) chatSubmitTrace.push(`${url.pathname} failed: ${request.failure()?.errorText ?? 'unknown'}`);
      const failure = request.failure()?.errorText ?? '';
      if (!intentionalOffline && failure.includes('ERR_NO_BUFFER_SPACE')) errors.push(`${request.method()} ${request.url()} failed: ${failure}`);
    } catch { /* Ignore non-URL request values from browser internals. */ }
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (intentionalOffline && message.text().includes('net::ERR_INTERNET_DISCONNECTED')) expectedOfflineResourceErrors++;
    else if (intentionalApprovalConflict && message.text().includes('409 (Conflict)')) expectedApprovalConflictErrors++;
    else errors.push(message.text());
  });
  await page.addInitScript(() => {
    window.__officeNetworkEvents = { online: 0, offline: 0, onlineAt: null };
    window.addEventListener('online', () => { window.__officeNetworkEvents.online++; window.__officeNetworkEvents.onlineAt = performance.now(); });
    window.addEventListener('offline', () => window.__officeNetworkEvents.offline++);
  });

  await page.goto(`http://127.0.0.1:${port}/office`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  await page.locator('#project-content .empty-state').waitFor();

  await page.locator('.world-toolbar').waitFor();
  if (!await page.locator('#world-stats').getByText('agents', { exact: false }).count()) throw new Error('The world toolbar did not show live office counters.');
  await page.locator('#world-settings-toggle').click();
  const showNamesSetting = page.locator('#world-settings [data-world-option="showNames"]');
  await showNamesSetting.waitFor({ state: 'visible' });
  await showNamesSetting.uncheck();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('agent-office:visual-settings:v1') ?? '{}').showNames === false);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  await page.locator('#world-settings-toggle').click();
  await page.locator('#world-settings [data-world-option="showNames"]').waitFor({ state: 'visible' });
  if (await page.locator('#world-settings [data-world-option="showNames"]').isChecked()) throw new Error('The world visual settings did not persist across a browser reload.');
  await page.locator('#world-settings [data-world-option="showNames"]').check();
  await page.locator('#world-settings-toggle').click();
  const languageButton = page.locator('#language');
  if (await languageButton.innerText() !== 'EN') throw new Error('The browser smoke did not start in English.');
  await Promise.all([page.waitForFunction(() => document.documentElement.lang === 'vi'), languageButton.click()]);
  await page.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  await page.locator('#world-settings-toggle').click();
  const vietnameseAuto = await page.locator('#world-settings [data-world-option="theme"] option[value="auto"]').innerText();
  if (vietnameseAuto !== 'Tự động') throw new Error(`The seasonal-theme setting was not translated in Vietnamese: ${vietnameseAuto}.`);
  await page.locator('#world-settings-toggle').click();
  await Promise.all([page.waitForFunction(() => document.documentElement.lang === 'en'), languageButton.click()]);
  await page.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  await page.locator('#world-feed-toggle').click();
  await page.locator('#activity-feed').waitFor({ state: 'visible' });
  await page.locator('[data-close-feed]').click();
  await page.locator('#activity-feed').waitFor({ state: 'hidden' });

  if (await page.locator('#pool-count').innerText() !== '5') throw new Error('The roster should expose five ready specialists at startup.');
  const drainResponse = page.waitForResponse((response) => response.url().endsWith('/platform/v1/agents/developer-01/drain') && response.request().method() === 'POST');
  await page.locator('[data-agent-drain="developer-01"]').click();
  if ((await drainResponse).status() !== 200) throw new Error('The owner UI could not drain the Developer.');
  await page.waitForFunction(() => document.querySelector('[data-agent-drain="developer-01"]')?.getAttribute('data-draining') === 'true');
  if (await page.locator('#pool-count').innerText() !== '4') throw new Error('A draining specialist was still counted as ready.');
  await page.locator('[data-agent-drain="developer-01"]').click();
  await page.waitForFunction(() => document.querySelector('[data-agent-drain="developer-01"]')?.getAttribute('data-draining') === 'false');
  if (await page.locator('#pool-count').innerText() !== '5') throw new Error('The resumed Developer did not return to the ready pool.');

  const names = Array.from({ length: 10 }, (_, index) => `Browser smoke ${index + 1}`);
  for (const name of names) {
    await page.locator('#new-project').click();
    await page.locator('input[name="name"]').fill(name);
    await page.locator('textarea[name="goal"]').fill(`Browser test for ${name}.`);
    await page.locator('#new-project-form button[type="submit"]').click();
    try {
      await page.locator('.project-title h1').getByText(name, { exact: true }).waitFor({ timeout: 10_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        url: location.href,
        dialogOpen: document.querySelector('#new-project-dialog')?.open,
        dialogText: document.querySelector('#new-project-dialog')?.textContent?.slice(0, 500),
        banner: document.querySelector('.banner')?.textContent,
        projectTitle: document.querySelector('.project-title h1')?.textContent,
        sidebar: document.querySelector('.project-list')?.textContent?.slice(0, 500),
      }));
      throw new Error(`Project creation did not select ${JSON.stringify(name)}. Browser state: ${JSON.stringify(state)}. POST trace: ${JSON.stringify(projectCreateTrace)}. Server output: ${output}. Cause: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const projectsBeforeReload = await page.locator('[data-project]').count();
  if (projectsBeforeReload !== names.length) throw new Error(`Expected ${names.length} visible projects, found ${projectsBeforeReload}.`);
  const projectReply = await (await page.request.get(`http://127.0.0.1:${port}/platform/v1/projects`)).json();
  const projectIdByName = new Map(projectReply.projects.map((project) => [project.name, project.id]));
  const projectCard = (name) => {
    const id = projectIdByName.get(name);
    if (!id) throw new Error(`Project ID is missing for ${name}.`);
    return page.locator(`[data-project="${id}"]`);
  };
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  const projectsAfterReload = await page.locator('[data-project]').count();
  if (projectsAfterReload !== names.length) throw new Error(`Expected ${names.length} projects after reload, found ${projectsAfterReload}.`);

  await page.locator('[data-project]').filter({ hasText: names[1] }).focus();
  await page.keyboard.press('Enter');
  await page.locator('.project-title h1').getByText(names[1], { exact: true }).waitFor();

  const secondPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  secondPage.on('pageerror', (error) => errors.push(`second tab: ${error.stack ?? error.message}`));
  secondPage.on('console', (message) => {
    if (message.type() === 'error') errors.push(`second tab: ${message.text()}`);
  });
  await secondPage.goto(`http://127.0.0.1:${port}/office`, { waitUntil: 'networkidle', timeout: 30_000 });
  await secondPage.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  const sharedProjectId = projectIdByName.get(names[1]);
  if (!sharedProjectId) throw new Error('The shared multi-tab project ID was not found.');
  await secondPage.locator(`[data-project="${sharedProjectId}"]`).click();
  await secondPage.locator('.project-title h1').getByText(names[1], { exact: true }).waitFor();
  const crossTabMemory = 'This note was added in the second browser tab.';
  await secondPage.locator('#memory-form textarea[name="content"]').fill(crossTabMemory);
  await secondPage.locator('#memory-form button[type="submit"]').click();
  await page.locator('.memory-card').filter({ hasText: crossTabMemory }).waitFor({ timeout: 10_000 });
  await secondPage.close();

  for (const name of names) {
    const button = projectCard(name);
    await button.click();
    await page.locator('.project-title h1').getByText(name, { exact: true }).waitFor();
  }

  const memoryBefore = 'Keep project memory edits owner-controlled.';
  const memoryAfter = 'Keep project memory edits revision-controlled.';
  await page.locator('#memory-form textarea[name="content"]').fill(memoryBefore);
  await page.locator('#memory-form button[type="submit"]').click();
  await page.locator('.memory-card').filter({ hasText: memoryBefore }).waitFor();
  const markdownDownloadPromise = page.waitForEvent('download');
  await page.locator('#project-memory-markdown-export').click();
  const markdownDownload = await markdownDownloadPromise;
  if (markdownDownload.suggestedFilename() !== 'memory.md') throw new Error('Project memory export did not download as memory.md.');
  const markdownStream = await markdownDownload.createReadStream();
  if (!markdownStream) throw new Error('The downloaded project memory.md could not be read.');
  let downloadedMarkdown = '';
  for await (const chunk of markdownStream) downloadedMarkdown += chunk.toString();
  if (!downloadedMarkdown.includes(memoryBefore) || !downloadedMarkdown.includes('agent-office-memory-record:v1')) {
    throw new Error('The downloaded project memory.md omitted its note or revision metadata.');
  }
  const editedMarkdown = downloadedMarkdown.replace(memoryBefore, memoryAfter);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.locator('#project-memory-markdown-import-file').setInputFiles({ name: 'memory.md', mimeType: 'text/markdown', buffer: Buffer.from(editedMarkdown) });
  await page.locator('.memory-card').filter({ hasText: memoryAfter }).waitFor({ timeout: 10_000 });

  const selectedBeforeReconnect = names.at(-1);
  const eventStreamsBeforeReconnect = eventStreamRequests;
  const networkEventsBefore = await page.evaluate(() => ({ ...window.__officeNetworkEvents }));
  intentionalOffline = true;
  await page.context().setOffline(true);
  await page.waitForFunction((previous) => window.__officeNetworkEvents.offline > previous.offline, networkEventsBefore, { timeout: 5_000 });
  await page.locator('#connection-status.is-offline').waitFor({ timeout: 5_000 });
  const reconnectSessionResponse = await fetch(`http://127.0.0.1:${port}/platform/v1/session`);
  if (!reconnectSessionResponse.ok) throw new Error('Could not create a local API session during the browser disconnect.');
  const reconnectCookie = reconnectSessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
  const reconnectSession = await reconnectSessionResponse.json();
  if (!reconnectCookie || !reconnectSession.csrfToken) throw new Error('Reconnect fixture did not receive a session cookie and CSRF token.');
  const offlineStateChange = await fetch(`http://127.0.0.1:${port}/platform/v1/agents/developer-01/drain`, {
    method: 'POST',
    headers: { Cookie: reconnectCookie, 'X-CSRF-Token': reconnectSession.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ draining: true }),
  });
  if (offlineStateChange.status !== 200) throw new Error(`Could not commit the offline recovery fixture (HTTP ${offlineStateChange.status}).`);
  await page.context().setOffline(false);
  await page.waitForFunction((previous) => window.__officeNetworkEvents.online > previous.online, networkEventsBefore, { timeout: 5_000 });
  const reconnectStartedAt = await page.evaluate(() => window.__officeNetworkEvents.onlineAt);
  const reconnectDeadline = Date.now() + 10_000;
  while (eventStreamRequests <= eventStreamsBeforeReconnect && Date.now() < reconnectDeadline) await page.waitForTimeout(50);
  if (eventStreamRequests <= eventStreamsBeforeReconnect) {
    const networkDebug = await page.evaluate(() => ({ online: navigator.onLine, events: window.__officeNetworkEvents, connection: document.querySelector('#connection-status')?.className }));
    throw new Error(`The live event stream did not reconnect after network restoration (${eventStreamsBeforeReconnect} initial, ${eventStreamRequests} after recovery, ${JSON.stringify(networkDebug)}).`);
  }
  await page.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('[data-agent-drain="developer-01"]')?.dataset.draining === 'true'
    && document.querySelector('#pool-count')?.textContent === '4', undefined, { timeout: 5_000 });
  await page.locator('.project-title h1').getByText(selectedBeforeReconnect, { exact: true }).waitFor();
  const reconnectRecoveryMs = await page.evaluate((startedAt) => Number((performance.now() - startedAt).toFixed(2)), reconnectStartedAt);
  if (reconnectRecoveryMs >= 5_000) throw new Error(`Snapshot and agent counters recovered in ${reconnectRecoveryMs} ms; target is under 5,000 ms.`);
  await page.locator('[data-agent-drain="developer-01"]').click();
  await page.waitForFunction(() => document.querySelector('[data-agent-drain="developer-01"]')?.dataset.draining === 'false'
    && document.querySelector('#pool-count')?.textContent === '5', undefined, { timeout: 5_000 });
  intentionalOffline = false;

  await page.locator('#archive-project').click();
  try {
    await page.waitForFunction((remainingNames) => {
      const title = document.querySelector('.project-title h1')?.textContent?.trim();
      return remainingNames.includes(title) && document.querySelectorAll('[data-project]').length === remainingNames.length;
    }, names.slice(0, -1), { timeout: 10_000 });
  } catch (error) {
    const archiveState = await page.evaluate(async () => {
      const response = await fetch('/platform/v1/projects');
      const projects = response.ok ? (await response.json()).projects : [];
      return {
        title: document.querySelector('.project-title h1')?.textContent?.trim(),
        sidebar: [...document.querySelectorAll('[data-project]')].map((item) => ({ id: item.getAttribute('data-project'), title: item.textContent?.trim(), selected: item.classList.contains('is-selected') })),
        projects: projects.map((item) => ({ id: item.id, name: item.name, status: item.status })),
        panel: document.querySelector('#project-panel')?.className,
        archiveButton: Boolean(document.querySelector('#archive-project')),
      };
    });
    throw new Error(`Archive did not select a remaining active room: ${JSON.stringify(archiveState)}. Cause: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (await page.locator('[data-project]').count() !== names.length - 1) throw new Error('Archiving a room did not remove it from the active project list.');
  await page.locator('#archive-toggle').click();
  await projectCard(names.at(-1)).waitFor();
  await page.locator('.project-title h1').getByText(names.at(-1), { exact: true }).waitFor();
  const restoredProjectId = projectIdByName.get(names.at(-1));
  if (!restoredProjectId) throw new Error('The archived project ID was not found before restore.');
  const restoreResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/platform/v1/projects/${restoredProjectId}/restore`);
  await page.locator('#restore-project').click();
  if ((await restoreResponse).status() !== 200) throw new Error('Restoring the archived room did not return HTTP 200.');
  await page.waitForFunction((expected) => document.querySelectorAll('[data-project]').length === expected, names.length, { timeout: 10_000 });
  await page.locator('.project-title h1').getByText(names.at(-1), { exact: true }).waitFor();

  const assignmentProjectName = names.at(-1);
  const assignmentProjectId = projectIdByName.get(assignmentProjectName);
  if (!assignmentProjectId) throw new Error('The assignment smoke project ID was not found.');
  await projectCard(assignmentProjectName).click();
  await page.locator('.project-title h1').getByText(assignmentProjectName, { exact: true }).waitFor();
  const messageResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/messages')
    && new URL(response.url()).pathname.includes('/conversations/'));
  const assignmentMessage = 'Write a short project introduction and save it as a markdown artifact.';
  await page.locator('#message-input').fill(assignmentMessage);
  await projectCard(names[0]).click();
  await page.locator('.project-title h1').getByText(names[0], { exact: true }).waitFor();
  if (await page.locator('#message-input').inputValue()) throw new Error('A project message draft leaked into another room.');
  await projectCard(assignmentProjectName).click();
  await page.locator('.project-title h1').getByText(assignmentProjectName, { exact: true }).waitFor();
  if (await page.locator('#message-input').inputValue() !== assignmentMessage) throw new Error('The project message draft did not survive switching rooms.');
  await page.locator('#message-form button[type="submit"]').click();
  const acceptedMessage = await messageResponse.catch((error) => {
    return page.evaluate((detail) => {
      const input = document.querySelector('#message-input');
      const button = document.querySelector('#message-form button[type="submit"]');
      return {
        error: detail.error,
        chatSubmitTrace: detail.trace,
        pageErrors: detail.pageErrors,
        formExists: Boolean(document.querySelector('#message-form')),
        formConnected: document.querySelector('#message-form')?.isConnected ?? false,
        inputValue: input?.value,
        inputValidity: input instanceof HTMLTextAreaElement ? input.validity.valid : null,
        inputValidationMessage: input instanceof HTMLTextAreaElement ? input.validationMessage : null,
        buttonDisabled: button instanceof HTMLButtonElement ? button.disabled : null,
        buttonVisible: button instanceof HTMLElement ? button.getBoundingClientRect().width > 0 : null,
        projectHeading: document.querySelector('.project-title h1')?.textContent?.trim(),
      };
    }, { error: error instanceof Error ? error.message : String(error), trace: chatSubmitTrace, pageErrors: errors.slice(-5) }).then((state) => {
      throw new Error(`Chat submission did not reach the server: ${JSON.stringify(state)}. Server output: ${output}.`);
    });
  });
  if (acceptedMessage.status() !== 202) throw new Error(`The browser assignment message was rejected with HTTP ${acceptedMessage.status()}.`);
  const { runId } = await acceptedMessage.json();
  await waitForSignal(writerCallStarted, 10_000, 'The fake model did not reach the assigned Writer.');
  await page.waitForFunction(async (projectId) => {
    const response = await fetch('/platform/v1/office');
    const { snapshot } = await response.json();
    const writer = snapshot.agents.find((agent) => agent.id === 'writer-01');
    return writer?.projectId === projectId && writer.availability === 'busy' && writer.execution === 'running';
  }, assignmentProjectId, { timeout: 10_000 });
  const assignedOffice = await (await page.request.get(`http://127.0.0.1:${port}/platform/v1/office`)).json();
  const assignedWriter = assignedOffice.snapshot.agents.find((agent) => agent.id === 'writer-01');
  if (assignedWriter?.projectId !== assignmentProjectId || assignedWriter.availability !== 'busy' || assignedWriter.execution !== 'running') {
    throw new Error(`The real scheduler assignment was not reflected in the office snapshot: ${JSON.stringify(assignedWriter)}.`);
  }
  const assignedProject = await (await page.request.get(`http://127.0.0.1:${port}/platform/v1/projects/${assignmentProjectId}`)).json();
  const writingTask = assignedProject.tasks.find((task) => task.key === 'writing');
  if (writingTask?.status !== 'running' || writingTask.assignedAgentId !== 'writer-01') {
    throw new Error(`The writing task was not assigned to the configured Writer: ${JSON.stringify(writingTask)}.`);
  }
  await page.locator('.agent-card-activity').filter({ hasText: 'Draft the project introduction' }).waitFor({ timeout: 10_000 });
  await page.locator('[data-project-agent="writer-01"] .agent-card-activity').filter({ hasText: 'Draft the project introduction' }).waitFor({ timeout: 10_000 });
  if (await page.locator('#agent-list [data-agent-main="writer-01"]').count()) throw new Error('A project-assigned Writer was still rendered in the shared agent pool.');
  if (await page.locator(`[data-project-group="${assignmentProjectId}"] .project-agent-row`).count() < 2) throw new Error('The project sidebar did not show its Coordinator and assigned specialist together.');
  if (!await page.locator('#activity-feed-list [data-feed-event]').count()) throw new Error('Live execution events did not appear in the activity feed.');
  await page.locator('.project-stats div:nth-child(2) strong').getByText('1', { exact: true }).waitFor();
  await page.locator('.room-members .member-chip').filter({ hasText: 'Mai' }).locator('small').getByText('Working', { exact: true }).waitFor();
  const workingScreenshotBase = process.env.OFFICE_BROWSER_SCREENSHOT;
  if (workingScreenshotBase) {
    await mkdir(dirname(resolve(workingScreenshotBase)), { recursive: true });
    liveWorkingScreenshot = `${resolve(workingScreenshotBase)}-working.png`;
    await page.screenshot({ path: liveWorkingScreenshot });
  }
  releaseWriterCall();
  await waitForSignal(finalResponseStarted, 10_000, 'The fake model did not reach its final answer after the artifact tool.');
  const artifactActivity = 'Creating artifact browser-assignment.md';
  await page.locator('[data-project-agent="writer-01"] .agent-card-activity').filter({ hasText: artifactActivity }).waitFor({ timeout: 10_000 });
  await page.locator('#world-feed-toggle').click();
  await page.locator('#activity-feed').waitFor({ state: 'visible' });
  await page.locator('#activity-feed-list [data-feed-event]').filter({ hasText: artifactActivity }).waitFor({ timeout: 10_000 });
  await page.locator('#world-feed-toggle').click();
  releaseFinalResponse();
  await page.waitForFunction(async (id) => {
    const response = await fetch(`/platform/v1/runs/${encodeURIComponent(id)}`);
    const result = await response.json();
    return result.run?.status === 'succeeded'
      && result.tasks.some((task) => task.key === 'writing' && task.status === 'succeeded')
      && result.artifacts.some((artifact) => artifact.logicalName === 'browser-assignment.md');
  }, runId, { timeout: 15_000 });
  await page.locator('#artifact-list').getByText('browser-assignment.md', { exact: true }).waitFor({ timeout: 10_000 });
  await page.locator('[data-artifact-preview]').first().click();
  const previewDialog = page.locator('.artifact-preview-dialog');
  await previewDialog.waitFor({ state: 'visible' });
  const previewFrame = page.locator('.artifact-preview-frame');
  const previewPath = await previewFrame.getAttribute('src');
  if (!previewPath) throw new Error('Artifact preview iframe has no session URL.');
  if (await previewFrame.getAttribute('sandbox') !== '') throw new Error('Artifact preview iframe did not use an empty sandbox.');
  const previewBody = page.frameLocator('.artifact-preview-frame');
  const previewText = await previewBody.locator('pre').textContent();
  if (!previewText?.includes('<script>window.previewExecuted = true</script>')) throw new Error('Text artifact preview did not preserve the content as escaped text.');
  if (await previewBody.locator('body').evaluate((body) => (body.ownerDocument.defaultView).previewExecuted === true)) throw new Error('Artifact content executed inside the preview.');
  await previewDialog.getByRole('button', { name: 'Close preview' }).click();
  await previewDialog.waitFor({ state: 'detached' });
  const closedPreviewResponse = await fetch(new URL(previewPath, `http://127.0.0.1:${port}`));
  if (closedPreviewResponse.status !== 404) throw new Error(`Artifact preview token remained active after close (HTTP ${closedPreviewResponse.status}).`);

  let renderedAgentCount = 0;
  let fixtureProjectAndAgentCount = 0;
  await page.route('**/platform/v1/office', async (route) => {
    const response = await route.fetch();
    const office = await response.json();
    const specialist = office.snapshot.agents.find((agent) => agent.role === 'specialist');
    const fixtures = office.snapshot.projects.flatMap((project, roomIndex) => [0, 1].map((memberIndex) => ({
      id: `browser-fixture-${roomIndex}-${memberIndex}`,
      definitionId: specialist?.definitionId ?? 'developer',
      displayName: `Perf ${roomIndex + 1}-${memberIndex + 1}`,
      role: 'specialist',
      capabilities: specialist?.capabilities ?? [],
      availability: 'ready',
      execution: 'ready',
      location: { kind: 'project', projectId: project.id },
      projectId: project.id,
      currentTaskId: null,
      modelProfile: specialist?.modelProfile ?? 'coding',
      appearanceSeed: 100_000 + roomIndex * 2 + memberIndex,
      updatedAt: new Date().toISOString(),
    })));
    office.snapshot.agents.push(...fixtures);
    renderedAgentCount = office.snapshot.agents.length;
    fixtureProjectAndAgentCount = office.snapshot.projects.length + fixtures.length;
    await route.fulfill({ response, json: office });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  for (const name of names) {
    const button = projectCard(name);
    await button.click();
    await page.locator('.project-title h1').getByText(name, { exact: true }).waitFor();
  }

  await page.locator('#new-project').click();
  await page.locator('input[name="name"]').fill('');
  await page.locator('#new-project-form button[type="submit"]').click();
  if (!await page.locator('#new-project-dialog').evaluate((dialog) => dialog.open)) throw new Error('The project form accepted a missing required name.');
  if (await page.locator('[data-project]').count() !== names.length) throw new Error('Submitting an invalid project form changed the project list.');
  await page.locator('#cancel-project-dialog-secondary').click();

  const approvalDecisions = [];
  const activeApprovals = new Set(['browser-approval-deny', 'browser-approval-approve']);
  let denyAttempts = 0;
  await page.route('**/platform/v1/projects/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !/^\/platform\/v1\/projects\/[^/]+$/.test(url.pathname)) return route.continue();
    const response = await route.fetch();
    const detail = await response.json();
    const now = new Date().toISOString();
    detail.tasks = [...detail.tasks.filter((task) => task.id !== 'browser-failed-task'), {
      id: 'browser-failed-task',
      runId: 'browser-failed-run',
      key: 'browser-failed-task',
      title: 'Browser failure fixture',
      objective: 'Verify that the task panel exposes a failed task and its diagnostic output.',
      requiredCapabilities: ['review'],
      dependencies: [],
      status: 'failed',
      assignedAgentId: null,
      output: 'Fixture error: expected browser failure detail.',
      createdAt: now,
      updatedAt: now,
    }];
    detail.approvals = [
      ...detail.approvals.filter((approval) => activeApprovals.has(approval.id)),
      ...Array.from(activeApprovals, (id) => ({
        id,
        runId: 'browser-approval-run',
        taskId: 'browser-failed-task',
        summary: 'Write a reviewed browser fixture artifact.',
        toolId: 'workspace.write_file',
        argumentsHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        arguments: {
          path: `reports/${id}.md`,
          content: `Approved content for ${id}.`,
          expectedChecksum: id === 'browser-approval-approve' ? 'b'.repeat(64) : null,
          previewBaseContent: id === 'browser-approval-approve' ? 'Previous approved report.\n' : '',
          previewBaseAvailable: true,
        },
      })),
    ];
    await route.fulfill({ response, json: detail });
  });
  await page.route('**/platform/v1/approvals/browser-approval-*/decision', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const decision = route.request().postDataJSON();
    approvalDecisions.push({ id, decision: decision.decision });
    if (id === 'browser-approval-deny' && ++denyAttempts === 1) {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Approval decision is stale.' } }) });
    }
    activeApprovals.delete(id);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await projectCard(names.at(-1)).click();
  const failedTask = page.locator('.task-card').filter({ hasText: 'Browser failure fixture' });
  await failedTask.locator('.task-state.failed').waitFor();
  await failedTask.locator('summary').click();
  await failedTask.getByText('Fixture error: expected browser failure detail.').waitFor();
  const denyApprovalButton = page.locator('[data-approval-id="browser-approval-deny"][data-decision="deny"]');
  const reviewApprovalCard = page.locator('.approval-card').filter({ hasText: 'reports/browser-approval-approve.md' });
  await reviewApprovalCard.locator('.approval-diff-line.deletion').getByText('Previous approved report.').waitFor();
  await reviewApprovalCard.locator('.approval-diff-line.addition').getByText('Approved content for browser-approval-approve.').waitFor();
  if (await reviewApprovalCard.locator('.approval-diff-line.context').count()) throw new Error('The replacement diff displayed unexpected unchanged lines.');
  intentionalApprovalConflict = true;
  await denyApprovalButton.click();
  await page.locator('#banner').getByText('Approval decision is stale.').waitFor();
  intentionalApprovalConflict = false;
  await denyApprovalButton.waitFor({ state: 'visible' });
  if (await denyApprovalButton.isDisabled()) throw new Error('A rejected approval decision left the action disabled.');
  await denyApprovalButton.click();
  await page.locator('[data-approval-id="browser-approval-deny"][data-decision="deny"]').waitFor({ state: 'detached' });
  const approveButton = page.locator('[data-approval-id="browser-approval-approve"][data-decision="approve"]');
  await approveButton.click();
  await page.locator('[data-approval-id="browser-approval-approve"][data-decision="approve"]').waitFor({ state: 'detached' });
  if (expectedApprovalConflictErrors !== 1) throw new Error(`Expected one browser console entry for the fixture's HTTP 409, found ${expectedApprovalConflictErrors}.`);
  if (JSON.stringify(approvalDecisions) !== JSON.stringify([
    { id: 'browser-approval-deny', decision: 'deny' },
    { id: 'browser-approval-deny', decision: 'deny' },
    { id: 'browser-approval-approve', decision: 'approve' },
  ])) throw new Error(`Approval controls sent unexpected decisions: ${JSON.stringify(approvalDecisions)}.`);

  const office = await (await page.request.get(`http://127.0.0.1:${port}/platform/v1/office`)).json();
  const coordinators = office.snapshot.agents.filter((agent) => agent.role === 'coordinator');
  if (coordinators.length !== names.length) throw new Error(`Expected one Coordinator per project, found ${coordinators.length}.`);
  if (fixtureProjectAndAgentCount !== names.length * 3) throw new Error(`Expected ${names.length * 3} project agents, found ${fixtureProjectAndAgentCount}.`);
  if (renderedAgentCount < fixtureProjectAndAgentCount) throw new Error(`Expected the canvas to render at least ${fixtureProjectAndAgentCount} agents, found ${renderedAgentCount}.`);

  const definitionDir = join(configDir, 'agents', 'definitions');
  await cp(join(definitionDir, 'writer'), join(definitionDir, 'designer'), { recursive: true });
  const designerManifestPath = join(definitionDir, 'designer', 'agent.yaml');
  const designerManifest = (await readFile(designerManifestPath, 'utf8'))
    .replace(/^id: writer$/m, 'id: designer')
    .replace(/^version: .+$/m, 'version: 1.0.0')
    .replace(/^displayName: Writer$/m, 'displayName: Designer')
    .replace(/^capabilities: .+$/m, 'capabilities: [design.layout]');
  await writeFile(designerManifestPath, designerManifest, 'utf8');
  await writeFile(join(definitionDir, 'designer', 'system.md'), 'DESIGNER_E2E_AGENT_MARKER. Create a clear design brief and deliver it as a reviewable artifact.', 'utf8');
  await appendFile(join(configDir, 'agents', 'roster.yaml'), '\n  - id: designer-01\n    definition: designer\n    displayName: Designer\n    enabled: true\n    appearanceSeed: 74001\n', 'utf8');
  let registryConfirmation = '';
  page.once('dialog', async (dialog) => {
    registryConfirmation = dialog.message();
    await dialog.accept();
  });
  await page.locator('#reload-agents').click();
  await page.locator('#agent-list [data-agent-main="designer-01"] .office-avatar').waitFor({ timeout: 10_000 });
  const registryBanner = page.locator('#banner');
  await registryBanner.waitFor({ state: 'visible', timeout: 5_000 });
  if (!await registryBanner.evaluate((element) => element.classList.contains('banner--success'))
    || !await registryBanner.innerText().then((text) => text.includes('Loaded 1 new agents into the office.'))) {
    throw new Error(`Adding a valid specialist did not show a success banner: ${await registryBanner.innerText()}.`);
  }
  if (!registryConfirmation.includes('designer-01')) throw new Error(`The new-agent confirmation omitted the added roster entry: ${registryConfirmation}.`);
  if (await page.locator('#pool-count').innerText() !== '6') throw new Error('The config-added Designer did not join the shared specialist pool.');
  const extensionReply = await (await page.request.get(`http://127.0.0.1:${port}/platform/v1/agents`)).json();
  const designer = extensionReply.agents.find((agent) => agent.id === 'designer-01');
  if (!extensionReply.definitions.some((definition) => definition.id === 'designer')
    || designer?.availability !== 'ready'
    || designer?.location.kind !== 'pool'
    || designer?.projectId !== null) {
    throw new Error(`The config-added Designer was not loaded as an available pool agent: ${JSON.stringify({ designer, definitions: extensionReply.definitions.map((definition) => definition.id) })}.`);
  }
  const extendedOffice = await (await page.request.get(`http://127.0.0.1:${port}/platform/v1/office`)).json();
  if (extendedOffice.snapshot.agents.filter((agent) => agent.role === 'coordinator').length !== names.length
    || extendedOffice.snapshot.agents.filter((agent) => agent.id === 'designer-01').length !== 1) {
    throw new Error('Adding the Designer changed project Coordinator count or created duplicate roster instances.');
  }

  const designerProjectName = names[0];
  const designerProjectId = projectIdByName.get(designerProjectName);
  if (!designerProjectId) throw new Error('The Designer assignment project ID was not found.');
  await projectCard(designerProjectName).click();
  await page.locator('.project-title h1').getByText(designerProjectName, { exact: true }).waitFor();
  const designerMessageResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/messages')
    && new URL(response.url()).pathname.includes('/conversations/'));
  await page.locator('#message-input').fill('DESIGNER_E2E_REQUEST: Prepare a design brief and save it as a markdown artifact.');
  await page.locator('#message-form button[type="submit"]').click();
  const acceptedDesignerMessage = await designerMessageResponse;
  if (acceptedDesignerMessage.status() !== 202) throw new Error(`The Designer assignment message was rejected with HTTP ${acceptedDesignerMessage.status()}.`);
  const { runId: designerRunId } = await acceptedDesignerMessage.json();
  await waitForSignal(designerCallStarted, 10_000, `The fake model did not reach the config-added Designer. Recent requests: ${JSON.stringify(fakeModelTrace.slice(-6))}`);
  await page.waitForFunction(async (projectId) => {
    const response = await fetch('/platform/v1/office');
    const { snapshot } = await response.json();
    const designer = snapshot.agents.find((agent) => agent.id === 'designer-01');
    return designer?.projectId === projectId && designer.availability === 'busy' && designer.execution === 'running';
  }, designerProjectId, { timeout: 10_000 });
  await page.locator(`[data-project-group="${designerProjectId}"] [data-project-agent="designer-01"] .agent-card-activity`).filter({ hasText: 'Create the design brief' }).waitFor({ timeout: 10_000 });
  await page.locator('.room-members .member-chip').filter({ hasText: 'Designer' }).locator('small').getByText('Working', { exact: true }).waitFor();
  releaseDesignerCall();
  await waitForSignal(designerFinalResponseStarted, 10_000, 'The fake model did not reach its final Designer answer.');
  const designerArtifactActivity = 'Creating artifact design-brief.md';
  await page.locator('[data-project-agent="designer-01"] .agent-card-activity').filter({ hasText: designerArtifactActivity }).waitFor({ timeout: 10_000 });
  await page.locator('#world-feed-toggle').click();
  await page.locator('#activity-feed').waitFor({ state: 'visible' });
  await page.locator('#activity-feed-list [data-feed-event]').filter({ hasText: designerArtifactActivity }).waitFor({ timeout: 10_000 });
  await page.locator('#world-feed-toggle').click();
  releaseDesignerFinalResponse();
  await page.waitForFunction(async (id) => {
    const response = await fetch(`/platform/v1/runs/${encodeURIComponent(id)}`);
    const result = await response.json();
    return result.run?.status === 'succeeded'
      && result.tasks.some((task) => task.key === 'design' && task.status === 'succeeded' && task.assignedAgentId === 'designer-01')
      && result.artifacts.some((artifact) => artifact.logicalName === 'design-brief.md');
  }, designerRunId, { timeout: 15_000 });
  await page.waitForFunction(async () => {
    const response = await fetch('/platform/v1/office');
    const { snapshot } = await response.json();
    const designer = snapshot.agents.find((agent) => agent.id === 'designer-01');
    return designer?.location.kind === 'pool' && designer.availability === 'ready';
  }, { timeout: 10_000 });
  await page.locator('#agent-list [data-agent-main="designer-01"] .office-avatar').waitFor({ timeout: 10_000 });
  if (await page.locator('#project-list [data-project]').count() !== names.length) throw new Error('Assigning the Designer created or removed a project room.');

  const rapidWriterProjectId = projectIdByName.get(names[1]);
  const rapidDesignerProjectId = projectIdByName.get(names[2]);
  if (!rapidWriterProjectId || !rapidDesignerProjectId) throw new Error('The rapid-assignment project IDs were not found.');
  await projectCard(names[1]).click();
  await page.locator('.project-title h1').getByText(names[1], { exact: true }).waitFor();
  const rapidWriterMessageResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/messages')
    && new URL(response.url()).pathname.includes('/conversations/'));
  await page.locator('#message-input').fill('RAPID_WRITER_E2E_REQUEST: Draft a short project introduction and save it as a markdown artifact.');
  await page.locator('#message-form button[type="submit"]').click();
  const acceptedRapidWriterMessage = await rapidWriterMessageResponse.catch(async (error) => {
    const composerState = await page.evaluate(() => ({
      title: document.querySelector('.project-title h1')?.textContent?.trim(),
      inputValue: document.querySelector('#message-input')?.value,
      inputDisabled: document.querySelector('#message-input')?.disabled,
      submitDisabled: document.querySelector('#message-form button[type="submit"]')?.disabled,
      banner: document.querySelector('.banner')?.textContent?.trim(),
      runs: document.querySelector('#project-panel')?.textContent?.slice(-800),
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)} Rapid Writer composer state: ${JSON.stringify(composerState)}. Chat trace: ${JSON.stringify(chatSubmitTrace)}. Server output: ${output}.`);
  });
  if (acceptedRapidWriterMessage.status() !== 202) throw new Error(`The rapid Writer message was rejected with HTTP ${acceptedRapidWriterMessage.status()}.`);
  const { runId: rapidWriterRunId } = await acceptedRapidWriterMessage.json();

  await projectCard(names[2]).click();
  await page.locator('.project-title h1').getByText(names[2], { exact: true }).waitFor();
  const rapidDesignerMessageResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/messages')
    && new URL(response.url()).pathname.includes('/conversations/'));
  await page.locator('#message-input').fill('RAPID_DESIGNER_E2E_REQUEST: Prepare a design brief and save it as a markdown artifact.');
  await page.locator('#message-form button[type="submit"]').click();
  const acceptedRapidDesignerMessage = await rapidDesignerMessageResponse;
  if (acceptedRapidDesignerMessage.status() !== 202) throw new Error(`The rapid Designer message was rejected with HTTP ${acceptedRapidDesignerMessage.status()}.`);
  const { runId: rapidDesignerRunId } = await acceptedRapidDesignerMessage.json();

  await Promise.all([
    waitForSignal(rapidWriterToolStarted, 10_000, 'The rapid Writer assignment did not reach its artifact tool.'),
    waitForSignal(rapidDesignerToolStarted, 10_000, 'The rapid Designer assignment did not reach its artifact tool.'),
  ]);
  await page.waitForFunction(async ({ writerProjectId, designerProjectId }) => {
    const response = await fetch('/platform/v1/office');
    const { snapshot } = await response.json();
    const writer = snapshot.agents.find((agent) => agent.id === 'writer-01');
    const designer = snapshot.agents.find((agent) => agent.id === 'designer-01');
    return writer?.projectId === writerProjectId && writer.availability === 'busy' && writer.execution === 'running'
      && designer?.projectId === designerProjectId && designer.availability === 'busy' && designer.execution === 'running';
  }, { writerProjectId: rapidWriterProjectId, designerProjectId: rapidDesignerProjectId }, { timeout: 10_000 });

  if (await page.locator('#agent-list [data-agent-main="writer-01"]').count()
    || await page.locator('#agent-list [data-agent-main="designer-01"]').count()) {
    throw new Error('A concurrently assigned specialist was still shown in the shared pool.');
  }
  await projectCard(names[1]).click();
  await page.locator('.project-title h1').getByText(names[1], { exact: true }).waitFor();
  const rapidWriterProjectState = await (await page.request.get(`http://127.0.0.1:${port}/platform/v1/projects/${rapidWriterProjectId}`)).json();
  const rapidWriterActivityRow = page.locator(`[data-project-group="${rapidWriterProjectId}"] [data-project-agent="writer-01"] .agent-card-activity`);
  const rapidWriterActivityText = await rapidWriterActivityRow.textContent().catch(() => null);
  if (!rapidWriterActivityText?.includes('Draft the concurrent project')) {
    throw new Error(`The Writer sidebar did not show its active task: ${JSON.stringify({ task: rapidWriterProjectState.tasks.find((task) => task.key === 'writing'), rowText: rapidWriterActivityText })}.`);
  }
  await rapidWriterActivityRow.filter({ hasText: 'Draft the concurrent project' }).waitFor({ timeout: 10_000 });
  await page.locator('.room-members .member-chip').filter({ hasText: 'Mai' }).locator('small').getByText('Working', { exact: true }).waitFor();
  await projectCard(names[2]).click();
  await page.locator('.project-title h1').getByText(names[2], { exact: true }).waitFor();
  await page.locator(`[data-project-group="${rapidDesignerProjectId}"] [data-project-agent="designer-01"] .agent-card-activity`)
    .filter({ hasText: 'Create the concurrent design' }).waitFor({ timeout: 10_000 });
  await page.locator('.room-members .member-chip').filter({ hasText: 'Designer' }).locator('small').getByText('Working', { exact: true }).waitFor();
  const rapidProjectCount = await page.locator('#project-list [data-project]').count();
  if (rapidProjectCount !== names.length) throw new Error('Concurrent assignment changed the number of project rooms.');

  releaseRapidWriterTool();
  releaseRapidDesignerTool();
  await Promise.all([
    page.waitForFunction(async (id) => {
      const response = await fetch(`/platform/v1/runs/${encodeURIComponent(id)}`);
      const result = await response.json();
      return result.run?.status === 'succeeded'
        && result.tasks.some((task) => task.key === 'writing' && task.status === 'succeeded' && task.assignedAgentId === 'writer-01')
        && result.artifacts.some((artifact) => artifact.logicalName === 'browser-assignment.md');
    }, rapidWriterRunId, { timeout: 15_000 }),
    page.waitForFunction(async (id) => {
      const response = await fetch(`/platform/v1/runs/${encodeURIComponent(id)}`);
      const result = await response.json();
      return result.run?.status === 'succeeded'
        && result.tasks.some((task) => task.key === 'design' && task.status === 'succeeded' && task.assignedAgentId === 'designer-01')
        && result.artifacts.some((artifact) => artifact.logicalName === 'design-brief.md');
    }, rapidDesignerRunId, { timeout: 15_000 }),
  ]);
  await page.waitForFunction(async () => {
    const response = await fetch('/platform/v1/office');
    const { snapshot } = await response.json();
    const writer = snapshot.agents.find((agent) => agent.id === 'writer-01');
    const designer = snapshot.agents.find((agent) => agent.id === 'designer-01');
    return writer?.location.kind === 'pool' && writer.availability === 'ready'
      && designer?.location.kind === 'pool' && designer.availability === 'ready';
  }, { timeout: 10_000 });
  await page.locator('#agent-list [data-agent-main="writer-01"] .office-avatar').waitFor({ timeout: 10_000 });
  await page.locator('#agent-list [data-agent-main="designer-01"] .office-avatar').waitFor({ timeout: 10_000 });
  const rapidConcurrentAssignment = true;

  const visualScreenshotBase = process.env.OFFICE_BROWSER_SCREENSHOT;
  const visualScreenshots = liveWorkingScreenshot ? [liveWorkingScreenshot] : [];
  await page.locator('#world-overview').click();
  await page.waitForTimeout(500);
  const desktopOfficeLayout = await page.evaluate(() => {
    const panel = document.querySelector('.world-panel');
    const ticker = document.querySelector('#activity-collapse');
    const canvas = document.querySelector('#office-canvas');
    if (!(panel instanceof HTMLElement) || !(ticker instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return null;
    const panelRect = panel.getBoundingClientRect();
    const tickerRect = ticker.getBoundingClientRect();
    const style = getComputedStyle(ticker);
    const ctx = canvas.getContext('2d');
    const px = Math.max(0, Math.min(canvas.width - 1, Math.floor(canvas.width / 2)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.floor(canvas.height / 2)));
    const center = ctx?.getImageData(px, py, 1, 1).data;
    const tickerPoint = document.elementFromPoint(tickerRect.left + tickerRect.width / 2, tickerRect.top + tickerRect.height / 2);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      panelRect: { x: panelRect.x, y: panelRect.y, width: panelRect.width, height: panelRect.height },
      tickerRect: { x: tickerRect.x, y: tickerRect.y, width: tickerRect.width, height: tickerRect.height, bottom: tickerRect.bottom },
      tickerStyle: { display: style.display, visibility: style.visibility, opacity: style.opacity, zIndex: style.zIndex },
      tickerTopElement: tickerPoint?.id ?? tickerPoint?.tagName ?? null,
      tickerVisible: style.display !== 'none' && style.visibility !== 'hidden' && tickerRect.width > 0 && tickerRect.height > 0,
      tickerInsidePanel: tickerRect.left >= panelRect.left && tickerRect.right <= panelRect.right && tickerRect.bottom <= panelRect.bottom && tickerRect.bottom <= innerHeight,
      tickerHitTest: ticker.contains(tickerPoint),
      centerPixel: center ? [center[0], center[1], center[2]] : null,
      centerAlpha: center?.[3] ?? null,
    };
  });
  if (!desktopOfficeLayout?.tickerVisible || !desktopOfficeLayout.tickerInsidePanel || !desktopOfficeLayout.tickerHitTest || desktopOfficeLayout.panelRect.height > desktopOfficeLayout.viewport.height) {
    throw new Error(`The bottom activity ticker is not visible inside the office: ${JSON.stringify(desktopOfficeLayout)}.`);
  }
  if (desktopOfficeLayout.centerAlpha !== 255) throw new Error(`The centered office overview is blank: ${JSON.stringify(desktopOfficeLayout)}.`);
  if (desktopOfficeLayout.centerPixel && desktopOfficeLayout.centerPixel[1] > desktopOfficeLayout.centerPixel[0] * 1.2
    && desktopOfficeLayout.centerPixel[1] > desktopOfficeLayout.centerPixel[2] * 1.15) {
    throw new Error(`The initial overview still shows lawn at the center instead of the office: ${JSON.stringify(desktopOfficeLayout)}.`);
  }
  console.log(JSON.stringify({ desktopOfficeLayout }));
  if (visualScreenshotBase) {
    await mkdir(dirname(resolve(visualScreenshotBase)), { recursive: true });
    await page.locator('#world-feed-toggle').click();
    await page.locator('#activity-feed').waitFor({ state: 'visible' });
    const activityOverlay = await page.evaluate(() => {
      const feed = document.querySelector('#activity-feed');
      const rect = feed.getBoundingClientRect();
      const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const panel = document.querySelector('.world-panel').getBoundingClientRect();
      return { hidden: feed.hidden, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, topElement: at?.id ?? at?.tagName ?? null, insidePanel: rect.left >= panel.left && rect.right <= panel.right && rect.bottom <= panel.bottom && rect.bottom <= innerHeight, hitTest: feed.contains(at) };
    });
    if (activityOverlay.hidden || activityOverlay.rect.width === 0 || activityOverlay.rect.height === 0 || !activityOverlay.insidePanel || !activityOverlay.hitTest) throw new Error(`Recent activity feed did not render inside the office: ${JSON.stringify(activityOverlay)}.`);
    const activityScreenshot = `${resolve(visualScreenshotBase)}-activity.png`;
    await page.screenshot({ path: activityScreenshot });
    visualScreenshots.push(activityScreenshot);
    await page.locator('#world-feed-toggle').click();
    await page.locator('#world-settings-toggle').click();
    await page.locator('#world-settings').waitFor({ state: 'visible' });
    const settingsScreenshot = `${resolve(visualScreenshotBase)}-settings.png`;
    await page.screenshot({ path: settingsScreenshot });
    visualScreenshots.push(settingsScreenshot);
    await page.locator('#world-settings-toggle').click();
  }

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#connection-status:not(.is-offline)').waitFor({ timeout: 10_000 });
  await page.waitForFunction((expected) => document.querySelectorAll('#project-list [data-project]').length === expected, names.length, { timeout: 10_000 });
  await page.waitForTimeout(500);
  const startupOverview = await page.evaluate(() => {
    const panel = document.querySelector('.world-panel');
    const canvas = document.querySelector('#office-canvas');
    const rect = panel.getBoundingClientRect();
    const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return { panelHeight: rect.height, viewportHeight: innerHeight, centerAlpha: pixel[3] };
  });
  if (startupOverview.panelHeight > startupOverview.viewportHeight || startupOverview.centerAlpha !== 255) {
    throw new Error(`Reloading with existing rooms did not open on a visible office overview: ${JSON.stringify(startupOverview)}.`);
  }

  const canvas = page.locator('#office-canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Office canvas is not visible for the pan/zoom check.');
  const frameProbe = page.evaluate(() => new Promise((resolveFrame) => {
    const intervals = [];
    const start = performance.now();
    let previous = 0;
    const tick = (time) => {
      if (previous) intervals.push(time - previous);
      previous = time;
      if (time - start < 1500) requestAnimationFrame(tick);
      else {
        intervals.sort((a, b) => a - b);
        const measuredMs = Math.max(1, time - start);
        resolveFrame({
          frames: intervals.length,
          measuredMs: Number(measuredMs.toFixed(2)),
          fps: Number((intervals.length * 1000 / measuredMs).toFixed(2)),
          p95FrameMs: Number((intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))] ?? 0).toFixed(2)),
          maxFrameMs: Number((intervals.at(-1) ?? 0).toFixed(2)),
        });
      }
    };
    requestAnimationFrame(tick);
  }));
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(center.x, center.y);
  for (let index = 0; index < 8; index++) await page.mouse.wheel(0, index % 2 ? 180 : -180);
  await page.mouse.down();
  await page.mouse.move(center.x + 80, center.y + 45, { steps: 8 });
  await page.mouse.up();
  const panZoomFrames = await frameProbe;
  if (panZoomFrames.fps < 30) throw new Error(`Pan/zoom canvas rendered ${panZoomFrames.fps} FPS over ${panZoomFrames.measuredMs} ms; target is at least 30 FPS.`);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotionDuration = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.className = 'typing-cursor';
    document.body.append(probe);
    const duration = getComputedStyle(probe).animationDuration;
    probe.remove();
    return duration;
  });
  const durationValue = Number.parseFloat(reducedMotionDuration) * (reducedMotionDuration.endsWith('ms') ? 1 : 1000);
  if (!Number.isFinite(durationValue) || durationValue > 0.01) throw new Error(`Reduced-motion preference did not suppress UI animation (${reducedMotionDuration}).`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#close-project-panel').click();
  await page.locator('.project-panel.is-collapsed').waitFor({ state: 'hidden' });
  const officeAfterClosingProject = await page.locator('#office-canvas').boundingBox();
  if (!officeAfterClosingProject || officeAfterClosingProject.width < 389) throw new Error('Closing the project drawer did not return the full office canvas on mobile.');
  const mobileOfficeControls = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    return {
      sidebarRight: sidebar.right,
      settingsLeft: document.querySelector('#world-settings-toggle').getBoundingClientRect().left,
      activityLeft: document.querySelector('#world-feed-toggle').getBoundingClientRect().left,
      tickerLeft: document.querySelector('#activity-collapse').getBoundingClientRect().left,
    };
  });
  if (mobileOfficeControls.settingsLeft < mobileOfficeControls.sidebarRight || mobileOfficeControls.activityLeft < mobileOfficeControls.sidebarRight || mobileOfficeControls.tickerLeft < mobileOfficeControls.sidebarRight) {
    throw new Error(`The office settings and bottom activity were obscured by the project sidebar: ${JSON.stringify(mobileOfficeControls)}.`);
  }
  await page.locator('#project-panel-toggle').click();
  await page.locator('.project-panel:not(.is-collapsed)').waitFor();
  const mobileLayout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    shellDisplay: getComputedStyle(document.querySelector('.app-shell')).display,
    sidebarPosition: getComputedStyle(document.querySelector('.sidebar')).position,
    canvasWidth: document.querySelector('#office-canvas').getBoundingClientRect().width,
    projectPanelWidth: document.querySelector('.project-panel').getBoundingClientRect().width,
  }));
  if (mobileLayout.shellDisplay !== 'block' || mobileLayout.sidebarPosition !== 'absolute' || mobileLayout.canvasWidth < 389 || mobileLayout.projectPanelWidth <= 0) throw new Error(`Mobile office overlay did not render its room, sidebar and project drawer: ${JSON.stringify(mobileLayout)}.`);
  if (mobileLayout.scrollWidth > mobileLayout.width + 1) throw new Error(`Mobile layout overflows horizontally: ${JSON.stringify(mobileLayout)}.`);

  const devServerSmoke = await smokeDevelopmentServer(dataDir);
  const workspacePreviewSmoke = await smokeManagedWorkspacePreview(browser, dataDir, root, childEnv);

  if (errors.length) throw new Error(`Browser reported errors:\n${errors.join('\n')}`);
  await browser.close();
  browser = undefined;
  const shutdownRestart = await smokeRestartAfterTermination(child, port, dataDir, root, childEnv, projectsAfterReload);
  const browserSmokeResult = {
    ok: true,
    projects: projectsAfterReload,
    archivedAndRestored: 1,
    coordinators: coordinators.length,
    configAddedAgent: 'designer-01',
    configAgentInPool: designer?.location.kind === 'pool',
    configDesignerAssignment: true,
    designerReturnedToPool: true,
    rapidConcurrentAssignment,
    multiTabSync: true,
    agentDrainLifecycle: true,
    settingsTranslations: { en: 'Automatic', vi: 'Tự động' },
    realAssignmentLifecycle: true,
    fakeModelRequests: fakeModelRequestCount,
    projectAgents: fixtureProjectAndAgentCount,
    renderedAgents: renderedAgentCount,
    approvals: approvalDecisions.length,
    staleApprovalRecovery: true,
    expectedApprovalConflictErrors,
    failedTaskDetails: true,
    panZoomFrames: panZoomFrames.frames,
    panZoomMeasuredMs: panZoomFrames.measuredMs,
    panZoomFps: panZoomFrames.fps,
    panZoomFrameP95Ms: panZoomFrames.p95FrameMs,
    reconnects: eventStreamRequests - eventStreamsBeforeReconnect,
    reconnectRecoveryMs,
    reconnectRecoveryWithin5s: reconnectRecoveryMs < 5_000,
    reconnectStatePreserved: true,
    expectedOfflineResourceErrors,
    reducedMotion: true,
    mobileViewport: `${mobileLayout.width}px`,
    mobileOfficeOverlay: true,
    mobileHorizontalOverflow: false,
    visualScreenshots,
    developmentServer: devServerSmoke,
    workspacePreview: workspacePreviewSmoke,
    restartAfterTermination: shutdownRestart,
    browserErrors: errors.length,
  };
  const reportDirectory = join(root, 'evals', 'results');
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = join(reportDirectory, `office-browser-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(reportPath, `${JSON.stringify(browserSmokeResult, null, 2)}\n`);
  console.log(JSON.stringify({ ...browserSmokeResult, reportPath }));
} finally {
  releaseWriterCall();
  releaseFinalResponse();
  releaseDesignerCall();
  releaseDesignerFinalResponse();
  releaseRapidWriterTool();
  releaseRapidDesignerTool();
  await browser?.close().catch(() => undefined);
  if (spawned && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    if (!await waitForExit(child, 5_000)) {
      child.kill('SIGKILL');
      if (!await waitForExit(child, 5_000)) throw new Error('Temporary Agent Office server could not be stopped; its data directory was retained.');
    }
  }
  await new Promise((resolveClose) => fakeModelServer.close(() => resolveClose()));
  if (!spawned || child.exitCode !== null || child.signalCode !== null) await rm(dataDir, { recursive: true, force: true });
}

async function smokeRestartAfterTermination(child, port, dataDir, appRoot, baseEnv, expectedProjects) {
  child.kill('SIGTERM');
  if (!await waitForExit(child, 5_000)) throw new Error('The smoke server did not stop before restart.');
  const baseUrl = `http://127.0.0.1:${port}`;
  const restarted = spawn(process.execPath, [resolve(appRoot, 'dist/server/platform.js')], {
    cwd: appRoot,
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let restartedOutput = '';
  let restartedError;
  restarted.once('error', (error) => { restartedError = error; });
  restarted.stdout.setEncoding('utf8').on('data', (chunk) => { restartedOutput = (restartedOutput + chunk).slice(-20_000); });
  restarted.stderr.setEncoding('utf8').on('data', (chunk) => { restartedOutput = (restartedOutput + chunk).slice(-20_000); });
  try {
    await waitForHealth(restarted, port, join(dataDir, 'data', 'agent-office.sqlite'), () => restartedOutput, () => restartedError);
    const [projectsResponse, officeResponse] = await Promise.all([
      fetch(`${baseUrl}/platform/v1/projects`),
      fetch(`${baseUrl}/platform/v1/office`),
    ]);
    const { projects } = await projectsResponse.json();
    const { snapshot } = await officeResponse.json();
    if (projects.length !== expectedProjects || snapshot.projects.length !== expectedProjects) {
      throw new Error(`The project roster changed across shutdown/restart: projects=${projects.length}, snapshot=${snapshot.projects.length}, expected=${expectedProjects}.`);
    }
    if (projects.some((project) => project.name === 'Must not be created during shutdown')) {
      throw new Error('A write request made during shutdown was committed.');
    }
    return { samePortRestart: true, projectsPreserved: expectedProjects };
  } finally {
    if (restarted.exitCode === null && restarted.signalCode === null) {
      restarted.kill('SIGTERM');
      if (!await waitForExit(restarted, 5_000)) {
        restarted.kill('SIGKILL');
        if (!await waitForExit(restarted, 5_000)) throw new Error('The restarted Agent Office server could not be stopped.');
      }
    }
  }
}

async function smokeManagedWorkspacePreview(browser, parentDataDir, appRoot, baseEnv) {
  const workspaceRoot = join(parentDataDir, 'preview-workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'browser-preview-fixture', version: '1.0.0',
    scripts: { prepreview: `node -e "console.log('preview-hook-ran')"`, preview: 'node server.mjs' },
  }));
  await writeFile(join(workspaceRoot, 'server.mjs'), `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
writeFileSync('preview-snapshot-only.txt', 'temporary');
createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'preview_cookie=must_be_removed' });
  res.end('<!doctype html><html><body><h1>Isolated website preview</h1><p>cookie=' + (req.headers.cookie ? 'present' : 'absent') + '</p><script>document.body.dataset.previewScriptRan = "yes"</script></body></html>');
}).listen(Number(process.env.PORT), process.env.HOST);
`);

  const port = await findPort();
  const previewDataDir = join(parentDataDir, 'preview-office-data');
  const env = { ...baseEnv, OFFICE_PORT: String(port), OFFICE_DATA_DIR: previewDataDir, OFFICE_EXECUTION_MODE: 'local-trusted' };
  const serverProcess = spawn(process.execPath, [resolve(appRoot, 'dist/server/platform.js')], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let spawned = false;
  let spawnError;
  serverProcess.once('spawn', () => { spawned = true; });
  serverProcess.on('error', (error) => { spawnError = error; });
  serverProcess.stdout.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-20_000); });
  serverProcess.stderr.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-20_000); });
  let page;
  let previewPage;
  let previewUrl;
  try {
    await waitForHealth(serverProcess, port, join(previewDataDir, 'agent-office.sqlite'), () => output, () => spawnError);
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/office`, { waitUntil: 'networkidle' });
    await page.locator('#new-project').click();
    await page.locator('#new-project-form input[name="name"]').fill('Managed preview smoke');
    await page.locator('#new-project-form input[name="workspaceRoot"]').fill(workspaceRoot);
    await page.locator('#new-project-form button[type="submit"]').click();
    await page.locator('#workspace-preview-start').waitFor({ timeout: 10_000 });
    const setupResponsePromise = page.waitForResponse((response) => response.url().includes('/workspace-preview') && response.request().method() === 'GET');
    await page.locator('#workspace-preview-start').click();
    const setupResponse = await setupResponsePromise;
    const setupRaw = await setupResponse.text();
    let setupBody;
    try { setupBody = JSON.parse(setupRaw); }
    catch { throw new Error(`The preview setup route returned non-JSON: ${setupResponse.status()} ${setupResponse.url()} ${setupRaw.slice(0, 1000)}.`); }
    if (setupResponse.status() !== 200 || !setupBody.scripts.some((script) => script.name === 'preview')) {
      throw new Error(`The attached workspace did not expose its preview script: HTTP ${setupResponse.status()} ${JSON.stringify(setupBody)}.`);
    }
    const setup = page.locator('dialog.workspace-preview-setup-dialog');
    await setup.waitFor({ state: 'visible' });
    if (!(await setup.locator('#workspace-preview-command').innerText()).includes('npm run preview')) throw new Error('The preview review dialog did not show the selected npm command.');
    if (!(await setup.locator('.preview-hook-list').innerText()).includes('prepreview')) throw new Error('The preview review dialog did not show the lifecycle hook.');
    await setup.locator('button[type="submit"]').click();
    await page.locator('#banner').getByText('Check the box to confirm network access.').waitFor();
    if (!(await setup.isVisible())) throw new Error('Preview started without explicit network consent.');
    await setup.locator('input[name="networkConsent"]').check();
    const startedResponse = page.waitForResponse((response) => response.url().endsWith('/workspace-preview') && response.request().method() === 'POST');
    await setup.locator('button[type="submit"]').click();
    const started = await startedResponse;
    if (started.status() !== 201) throw new Error('The workspace preview API did not start the reviewed script.');
    const startedBody = await started.json();
    await page.locator('dialog.workspace-preview-dialog').waitFor({ state: 'visible', timeout: 15_000 });
    const link = page.locator('dialog.workspace-preview-dialog a[target="_blank"]');
    if (await link.getAttribute('rel') !== 'noopener noreferrer') throw new Error('The preview tab link does not isolate its opener.');
    previewUrl = await link.getAttribute('href');
    if (!previewUrl?.startsWith('http://127.0.0.2:')) throw new Error(`The preview URL is not on its isolated loopback origin: ${previewUrl}.`);

    const upstreamResponse = await fetch(previewUrl, { headers: { Cookie: 'office_session=should-not-forward' } });
    const contentSecurityPolicy = upstreamResponse.headers.get('content-security-policy') ?? '';
    if (!contentSecurityPolicy.includes("frame-ancestors 'none'")) throw new Error('The website preview CSP allows embedding.');
    if (upstreamResponse.headers.get('set-cookie')) throw new Error('The preview proxy passed a workspace Set-Cookie header to the browser.');
    if (!(await upstreamResponse.text()).includes('cookie=absent')) throw new Error('An Office cookie reached the workspace website process.');

    const newPage = page.context().waitForEvent('page');
    await link.click();
    previewPage = await newPage;
    await previewPage.waitForLoadState('domcontentloaded');
    if (await previewPage.evaluate(() => window.opener !== null)) throw new Error('The preview tab retained a window.opener reference.');
    await previewPage.getByRole('heading', { name: 'Isolated website preview' }).waitFor();
    if (await previewPage.locator('body').getAttribute('data-preview-script-ran') !== 'yes') throw new Error('The preview page did not run its app script in the standalone tab.');

    await page.locator('dialog.workspace-preview-dialog button[aria-label="Close"]').click();
    const stoppedResponse = page.waitForResponse((response) => response.url().endsWith(`/workspace-previews/${startedBody.preview.id}`) && response.request().method() === 'DELETE');
    await page.locator('[data-workspace-preview-stop]').click();
    if ((await stoppedResponse).status() !== 200) throw new Error('The owner UI could not stop the workspace preview.');
    await page.locator('[data-workspace-preview-stop]').waitFor({ state: 'detached' });
    const afterStop = await fetch(previewUrl).catch(() => null);
    if (afterStop) throw new Error('The workspace preview proxy remained reachable after stop.');
    if (pageErrors.length) throw new Error(`Workspace preview browser errors: ${pageErrors.join('; ')}`);
    return { projectWorkspace: true, networkConsentRequired: true, lifecycleVisible: true, separateTab: true, openerIsolated: true, frameBlocked: true, cookiesStripped: true, ownerStop: true };
  } finally {
    await previewPage?.close().catch(() => undefined);
    await page?.close().catch(() => undefined);
    if (spawned && serverProcess.exitCode === null && serverProcess.signalCode === null) {
      serverProcess.kill('SIGTERM');
      if (!await waitForExit(serverProcess, 5_000)) {
        serverProcess.kill('SIGKILL');
        if (!await waitForExit(serverProcess, 5_000)) throw new Error(`Preview smoke server could not be stopped; output: ${output}`);
      }
    }
  }
}

async function smokeDevelopmentServer(parentDataDir) {
  const devPort = await findPort();
  const devDataDir = join(parentDataDir, 'development-data');
  const devEnv = { ...childEnv, OFFICE_PORT: String(devPort), OFFICE_DATA_DIR: devDataDir };
  const serverProcess = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'server/platform/index.ts'), '--dev'], {
    cwd: root,
    env: devEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let spawned = false;
  let spawnError;
  serverProcess.once('spawn', () => { spawned = true; });
  serverProcess.on('error', (error) => { spawnError = error; });
  serverProcess.stdout.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-20_000); });
  serverProcess.stderr.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-20_000); });
  try {
    await waitForHealth(serverProcess, devPort, join(devDataDir, 'agent-office.sqlite'), () => output, () => spawnError);
    const response = await fetch(`http://127.0.0.1:${devPort}/office`, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5_000) });
    const html = await response.text();
    if (!response.ok || !html.includes('office-app') || !html.includes('/src/platform/main.ts')) {
      throw new Error(`Development server did not render the Vite office entry (${response.status}).\n${output}`);
    }
    if (output.includes('server.hmr') && output.includes('deprecated')) throw new Error(`Development server emitted a deprecated HMR configuration warning.\n${output}`);
    return { pageStatus: response.status, viteEntry: true, deprecatedHmrWarning: false };
  } finally {
    if (spawned && serverProcess.exitCode === null && serverProcess.signalCode === null) {
      serverProcess.kill('SIGTERM');
      if (!await waitForExit(serverProcess, 5_000)) {
        serverProcess.kill('SIGKILL');
        if (!await waitForExit(serverProcess, 5_000)) throw new Error('Temporary development server could not be stopped; its data directory was retained.');
      }
    }
  }
}

async function findPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port.');
  const { port: available } = address;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return available;
}

function sendModelStream(response, chunks) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
}

async function waitForSignal(signal, timeoutMs, message) {
  let timer;
  try {
    await Promise.race([signal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

async function waitForHealth(process, listenPort, dbFile, getOutput, getSpawnError) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (getSpawnError()) throw new Error(`Could not start Agent Office.\n${getSpawnError().message}`);
    if (process.exitCode !== null) throw new Error(`Agent Office exited before becoming ready.\n${getOutput()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${listenPort}/platform/v1/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json()).ok
        && getOutput().includes(`[office] listening at http://127.0.0.1:${listenPort}/office`)) {
        await stat(dbFile);
        return;
      }
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Agent Office did not become ready in 30 seconds.\n${getOutput()}`);
}

async function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null || process.signalCode !== null) return true;
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => { process.off('exit', onExit); resolveWait(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolveWait(true); };
    process.once('exit', onExit);
  });
}

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { createPlatformHandler } from './http';
import { MemoryService } from './memory';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import type { AgentRuntime } from './runtime';

interface StreamClient {
  request: http.ClientRequest;
  response?: http.IncomingMessage;
  ids: number[];
  wire: string;
  close(): void;
}

const enabled = process.env.OFFICE_SOAK_TESTS === '1';
const durationMs = parseDuration(process.env.OFFICE_SOAK_DURATION_MS);
const intervalMs = parseInterval(process.env.OFFICE_SOAK_INTERVAL_MS);

describe.skipIf(!enabled)('Agent Office eight-hour SSE and reconnect soak', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let server: http.Server;
  let baseUrl: string;
  let cookie: string;
  const streams: StreamClient[] = [];
  let agent: http.Agent;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-http-soak-'));
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    const registry = await loadRegistry(process.cwd());
    const projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    const handler = createPlatformHandler({
      config: loadAppConfig({ OFFICE_DATA_DIR: dataDir }),
      db,
      events,
      projects,
      runtime: { enqueue: vi.fn(), updateRegistry: vi.fn() } as unknown as AgentRuntime,
      artifacts: new ArtifactService(db, events, dataDir),
      memory: new MemoryService(db, events),
      registry,
    });
    server = http.createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    expect(cookie).toBeTruthy();
    agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  });

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    agent?.destroy();
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps reconnect and slow-client resources bounded while rotating durable fixtures', async () => {
    const hub = events as unknown as { listeners: Set<unknown>; transientListeners: Set<unknown> };
    const baseline = { durable: hub.listeners.size, transient: hub.transientListeners.size };
    const start = Date.now();
    const deadline = start + durationMs;
    const initialRss = process.memoryUsage().rss;
    let cursor = (await db.one<{ sequence: number | null }>('SELECT MAX(sequence) AS sequence FROM domain_events WHERE workspace_id = ?', ['local-workspace']))?.sequence ?? 0;
    let rounds = 0;
    let replayRounds = 0;
    let liveRounds = 0;
    let slowClientDrops = 0;

    while (Date.now() < deadline) {
      const replay = rounds % 2 === 0;
      let expectedId: number | undefined;
      if (replay) {
        const event = await events.transact('test.soak', 'bounded-sse-soak', null, { round: rounds, mode: 'replay', fixture: fixtureFor(rounds) });
        expectedId = event.sequence;
      }

      const healthy = await connect(cursor);
      await vi.waitFor(() => expect(hub.listeners.size).toBe(baseline.durable + 1), { timeout: 5_000 });
      if (!replay) {
        const event = await events.transact('test.soak', 'bounded-sse-soak', null, { round: rounds, mode: 'live', fixture: fixtureFor(rounds) });
        expectedId = event.sequence;
      }
      expect(expectedId).toBeDefined();
      await vi.waitFor(() => expect(healthy.ids).toContain(expectedId!), { timeout: 5_000 });
      expect(healthy.ids.filter((id) => id === expectedId)).toHaveLength(1);
      cursor = expectedId!;
      if (replay) replayRounds++;
      else liveRounds++;
      healthy.close();

      if (rounds % 20 === 0) {
        const slow = await connect(cursor, true);
        await vi.waitFor(() => expect(hub.listeners.size).toBe(baseline.durable + 1), { timeout: 5_000 });
        events.transient('task.delta', { runId: 'soak-fixture', taskId: 'soak-fixture', delta: 'x'.repeat(300_000) });
        await vi.waitFor(() => {
          expect(hub.listeners.size).toBe(baseline.durable);
          expect(hub.transientListeners.size).toBe(baseline.transient);
        }, { timeout: 5_000 });
        await vi.waitFor(() => expect(slow.response?.destroyed || slow.request.destroyed).toBe(true), { timeout: 5_000 });
        slowClientDrops++;
        slow.close();
      }

      rounds++;
      await vi.waitFor(() => {
        expect(hub.listeners.size).toBe(baseline.durable);
        expect(hub.transientListeners.size).toBe(baseline.transient);
      }, { timeout: 5_000 });
      if (rounds % 60 === 0 || Date.now() >= deadline) {
        const elapsedSeconds = Math.round((Date.now() - start) / 1000);
        const rssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const heapMiB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        console.info(`[office soak] ${elapsedSeconds}s elapsed; rounds=${rounds}; replay=${replayRounds}; live=${liveRounds}; slowDrops=${slowClientDrops}; rss=${rssMiB}MiB (start ${Math.round(initialRss / 1024 / 1024)}MiB); heap=${heapMiB}MiB`);
      }
      if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    expect(rounds).toBeGreaterThan(0);
    expect(replayRounds).toBeGreaterThan(0);
    expect(liveRounds).toBeGreaterThan(0);
    expect(slowClientDrops).toBeGreaterThan(0);
    expect(hub.listeners.size).toBe(baseline.durable);
    expect(hub.transientListeners.size).toBe(baseline.transient);
    const recorded = await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ? AND type = 'test.soak' AND aggregate_id = 'bounded-sse-soak'", ['local-workspace']);
    expect(recorded?.count).toBe(rounds);
  }, durationMs + 60_000);

  function connect(lastEventId: number, slow = false): Promise<StreamClient> {
    return new Promise((resolve, reject) => {
      const client: StreamClient = {
        request: undefined as unknown as http.ClientRequest,
        ids: [],
        wire: '',
        close() {
          this.response?.destroy();
          this.request.destroy();
          const index = streams.indexOf(this);
          if (index >= 0) streams.splice(index, 1);
        },
      };
      client.request = http.get(`${baseUrl}/platform/v1/events?since=${lastEventId}`, {
        agent,
        headers: { Cookie: cookie, 'Last-Event-ID': String(lastEventId) },
      }, (response) => {
        client.response = response;
        if (slow) response.pause();
        else {
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            client.wire += chunk;
            let index: number;
            while ((index = client.wire.indexOf('\n\n')) >= 0) {
              const frame = client.wire.slice(0, index);
              client.wire = client.wire.slice(index + 2);
              const id = /^id: (\d+)$/m.exec(frame)?.[1];
              if (id && /^event: office\.event$/m.test(frame)) client.ids.push(Number(id));
            }
          });
        }
        streams.push(client);
        resolve(client);
      });
      client.request.once('error', (error) => { if (!client.response) reject(error); });
    });
  }
});

function fixtureFor(round: number): string {
  return ['project-update', 'run-progress', 'agent-status', 'approval-state'][round % 4]!;
}

function parseDuration(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 8 * 60 * 60 * 1000 ? parsed : 8 * 60 * 60 * 1000;
}

function parseInterval(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 60_000 ? parsed : 5_000;
}

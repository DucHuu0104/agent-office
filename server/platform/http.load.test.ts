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

describe('SSE reconnect under concurrent slow-client load', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-http-load-'));
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
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('drops backpressured listeners, keeps healthy streams current, and replays every missed durable event once', async () => {
    const sessionResponse = await fetch(`${baseUrl}/platform/v1/session`);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    const initial = await db.one<{ sequence: number | null }>('SELECT MAX(sequence) AS sequence FROM domain_events WHERE workspace_id = ?', ['local-workspace']);
    const cursor = initial?.sequence ?? 0;
    const hub = events as unknown as { listeners: Set<unknown>; transientListeners: Set<unknown> };
    const baseline = { durable: hub.listeners.size, transient: hub.transientListeners.size };
    const agent = new http.Agent({ keepAlive: true, maxSockets: 48 });

    const connect = (options: { slow?: boolean; lastEventId?: number } = {}): Promise<StreamClient> => new Promise((resolve, reject) => {
      const client: StreamClient = {
        request: undefined as unknown as http.ClientRequest,
        ids: [],
        wire: '',
        close() { this.response?.destroy(); this.request.destroy(); },
      };
      client.request = http.get(`${baseUrl}/platform/v1/events?since=${cursor}`, {
        agent,
        headers: { Cookie: cookie!, ...(options.lastEventId === undefined ? {} : { 'Last-Event-ID': String(options.lastEventId) }) },
      }, (response) => {
        client.response = response;
        if (options.slow) response.pause();
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
        resolve(client);
      });
      client.request.once('error', (error) => { if (!client.response) reject(error); });
    });

    const slowClients: StreamClient[] = [];
    const healthyClients: StreamClient[] = [];
    const recovered: StreamClient[] = [];
    try {
      slowClients.push(...await Promise.all(Array.from({ length: 16 }, () => connect({ slow: true }))));
      await vi.waitFor(() => {
        expect(hub.listeners.size).toBe(baseline.durable + 16);
        expect(hub.transientListeners.size).toBe(baseline.transient + 16);
      }, { timeout: 5_000 });

      events.transient('task.delta', { runId: 'load-fixture', taskId: 'load-fixture', delta: 'x'.repeat(300_000) });
      await vi.waitFor(() => {
        expect(hub.listeners.size).toBe(baseline.durable);
        expect(hub.transientListeners.size).toBe(baseline.transient);
      }, { timeout: 5_000 });

      const expectedIds: number[] = [];
      for (let index = 0; index < 32; index++) {
        const event = await events.transact('test.load', 'concurrent-client-load', null, { index, detail: 'fixture' });
        expectedIds.push(event.sequence);
      }
      healthyClients.push(...await Promise.all(Array.from({ length: 8 }, () => connect())));
      recovered.push(await connect({ lastEventId: cursor }));
      await vi.waitFor(() => {
        expect(hub.listeners.size).toBe(baseline.durable + healthyClients.length + recovered.length);
        expect(hub.transientListeners.size).toBe(baseline.transient + healthyClients.length + recovered.length);
      }, { timeout: 5_000 });
      await vi.waitFor(() => {
        for (const client of healthyClients) expect(client.ids).toEqual(expectedIds);
      }, { timeout: 5_000 });

      const recovery = recovered[0]!;
      for (let index = 32; index < 42; index++) {
        const event = await events.transact('test.load', 'concurrent-client-load', null, { index, detail: 'live' });
        expectedIds.push(event.sequence);
      }
      await vi.waitFor(() => {
        for (const client of [...healthyClients, recovery]) expect(client.ids).toEqual(expectedIds);
      }, { timeout: 5_000 });

      expect(slowClients.every((client) => client.response?.destroyed || client.request.destroyed)).toBe(true);
      expect([...healthyClients, recovery].every((client) => client.ids.length === expectedIds.length && new Set(client.ids).size === expectedIds.length)).toBe(true);
      expect(recovery.ids).toEqual(expectedIds);
    } finally {
      for (const client of [...slowClients, ...healthyClients, ...recovered]) client.close();
      agent.destroy();
      await vi.waitFor(() => {
        expect(hub.listeners.size).toBe(baseline.durable);
        expect(hub.transientListeners.size).toBe(baseline.transient);
      }, { timeout: 5_000 });
    }
  }, 20_000);
});

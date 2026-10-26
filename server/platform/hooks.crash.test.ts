import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { HookRunner } from './hooks';
import { MemoryService } from './memory';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';

describe('hard process termination during durable hook delivery', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;
  let memory: MemoryService;
  let hooks: HookRunner;
  let registry: Awaited<ReturnType<typeof loadRegistry>>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-hook-crash-'));
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    registry = await loadRegistry(process.cwd());
    projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    memory = new MemoryService(db, events);
    hooks = new HookRunner({ db, events, memory, projects });
  });

  afterEach(async () => {
    await db?.close().catch(() => undefined);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('replays a committed lifecycle event once and clears its pending payload after restart', async () => {
    const project = await projects.createProject({ name: 'Hard-kill hook recovery', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Check durable hook recovery.');
    const revisionBefore = await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'");
    const agentInstanceId = registry.roster.find((agent) => agent.definition === 'developer')!.id;
    const markerPath = join(dataDir, 'hook-crash-marker.json');
    await db.close();

    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./hook-outbox-crash-child.ts', import.meta.url)),
      dataDir, request.runId, project.id, agentInstanceId, markerPath,
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const childExit = new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code }));
    });

    let killed = false;
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try { await access(markerPath); break; } catch { /* wait for the durable event commit marker */ }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Hook child exited before the event commit: ${output}`);
        await delay(20);
      }
      await expect(access(markerPath)).resolves.toBeUndefined();
      expect(child.kill('SIGKILL')).toBe(true);
      killed = true;
      const exit = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error('Hook child did not exit after SIGKILL.'); }),
      ]);
      expect(exit.code).not.toBe(0);
    } finally {
      if (!killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (!killed) await Promise.race([childExit.catch(() => undefined), delay(5_000)]);
    }

    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    memory = new MemoryService(db, events);
    hooks = new HookRunner({ db, events, memory, projects });

    const eventCountBeforeReplay = await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'agent.lifecycle_hook'");
    const pending = await db.one<{ status: string; payload_json: string | null; attempts: number }>(
      "SELECT status, payload_json, attempts FROM hook_outbox WHERE event_id = 'hard-kill-lifecycle-audit'",
    );
    const revisionAfterCommit = await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'");
    expect(eventCountBeforeReplay).toEqual({ count: 1 });
    expect(pending).toMatchObject({ status: 'pending', attempts: 1 });
    expect(pending?.payload_json).not.toContain('hook-outbox-private-prompt');
    expect(JSON.stringify(await events.listSince(0))).not.toContain('hook-outbox-private-prompt');
    expect(revisionAfterCommit?.revision).toBe((revisionBefore?.revision ?? 0) + 1);

    await hooks.replayPending();
    await hooks.replayPending();

    expect((await events.listSince(0)).filter((event) => event.type === 'agent.lifecycle_hook')).toHaveLength(1);
    expect(await db.one<{ revision: number }>("SELECT revision FROM workspaces WHERE id = 'local-workspace'")).toEqual(revisionAfterCommit);
    expect(await db.one<{ status: string; payload_json: string | null; attempts: number }>(
      "SELECT status, payload_json, attempts FROM hook_outbox WHERE event_id = 'hard-kill-lifecycle-audit'",
    )).toMatchObject({ status: 'completed', payload_json: null, attempts: 2 });
  }, 30_000);
});

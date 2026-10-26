import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';

describe('artifact operation process-crash recovery', () => {
  let dataDir: string | undefined;
  let db: DatabaseClient | undefined;
  let runtime: AgentRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop().catch(() => undefined);
    await db?.close().catch(() => undefined);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    db = undefined;
    runtime = undefined;
  });

  it('quarantines an artifact committed before the tool receipt without creating a second artifact', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-artifact-crash-'));
    db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const registry = await loadRegistry(process.cwd());
    const projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    const project = await projects.createProject({ name: 'Artifact process crash', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Create a durable artifact');
    const taskId = randomUUID();
    const operationId = randomUUID();
    const toolCallId = 'call-artifact-crash';
    const taskTime = new Date().toISOString();
    const args = JSON.stringify({ name: 'crash-evidence.txt', content: 'Durable artifact before tool receipt commit.' });
    const argsHash = createHash('sha256').update(args).digest('hex');
    await db.batch([
      { mode: 'run', sql: `INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
        VALUES (?, ?, 'artifact', 'specialist', 'Create artifact', 'Persist the artifact once', '["software-development"]', 'running', ?, ?)`, params: [taskId, request.runId, taskTime, taskTime] },
      { mode: 'run', sql: `INSERT INTO tool_operations(id, run_id, task_id, tool_id, arguments_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, 'artifacts.create', ?, 'dispatched', ?, ?)`, params: [operationId, request.runId, taskId, argsHash, taskTime, taskTime] },
      { mode: 'run', sql: `INSERT INTO checkpoints(id, execution_id, position, state_json, schema_version, created_at)
        VALUES (?, ?, 1, ?, 2, ?)`, params: [randomUUID(), taskId, JSON.stringify({
        schemaVersion: 2, definitionId: 'developer',
        messages: [{ role: 'assistant', tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'create_artifact', arguments: args } }] }],
        nextTurn: 1, totalToolCalls: 1,
        pendingToolCalls: [{ operationId, toolCallId, toolName: 'artifacts.create' }],
      }), taskTime] },
    ], true);
    await projects.updateRun(request.runId, 'executing');
    await db.close();
    db = undefined;

    const markerPath = join(dataDir, 'artifact-created.json');
    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./artifact-crash-child.ts', import.meta.url)),
      dataDir, project.id, taskId, markerPath,
    ], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let killed = false;
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try { await access(markerPath); break; } catch { /* The marker is written after the artifact transaction commits. */ }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Crash helper exited before committing the artifact: ${output}`);
        await delay(20);
      }
      await expect(access(markerPath)).resolves.toBeUndefined();
      expect(child.kill('SIGKILL')).toBe(true);
      killed = true;
      const result = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error('Artifact crash helper did not exit after SIGKILL.'); }),
      ]);
      expect(result.code).not.toBe(0);
    } finally {
      if (!killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (!killed) await Promise.race([childExit.catch(() => undefined), delay(5_000)]);
    }

    db = await DatabaseClient.open(dataDir, true);
    const recoveredEvents = new EventHub(db);
    const recoveredArtifacts = new ArtifactService(db, recoveredEvents, dataDir);
    expect(await recoveredArtifacts.recoverOrphans()).toBe(1);
    const artifactList = await recoveredArtifacts.list(project.id);
    expect(artifactList).toHaveLength(1);
    expect((await recoveredArtifacts.content(artifactList[0]!.versionId))?.content.toString('utf8'))
      .toBe('Durable artifact before tool receipt commit.');
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'artifact.version_created' AND project_id = ?", [project.id]))
      .toEqual({ count: 1 });

    const recoveredRegistry = await loadRegistry(process.cwd());
    runtime = new AgentRuntime(db, recoveredEvents, new ProjectService(db, recoveredEvents, recoveredRegistry), recoveredRegistry, recoveredArtifacts, loadAppConfig({ OFFICE_DATA_DIR: dataDir }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    await runtime.recover();

    expect(await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [operationId]))
      .toMatchObject({ status: 'outcome_unknown', receipt_json: expect.stringContaining('marked unknown') });
    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
      .toEqual({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
    expect(await db.one<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])).toEqual({ status: 'failed' });
    const checkpoint = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [taskId]);
    expect(JSON.parse(checkpoint!.state_json).pendingToolCalls).toHaveLength(1);
    expect((await recoveredArtifacts.list(project.id))).toHaveLength(1);
  }, 30_000);
});

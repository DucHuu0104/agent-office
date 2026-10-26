import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';

describe('live task assignment invariant', () => {
  let dataDir: string;
  let db: DatabaseClient;

  afterEach(async () => {
    if (db) await db.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('migrates the assignment index and rejects two live agents for one task', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-assignments-'));
    db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const registry = await loadRegistry(process.cwd());
    const projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    const project = await projects.createProject({ name: 'Assignment race', goal: '' });
    const message = await projects.createUserMessage(project.id, project.conversationId, 'Run one task.');
    const taskId = 'assignment-task';
    const now = new Date().toISOString();
    await db.run("UPDATE runs SET status = 'executing' WHERE id = ?", [message.runId]);
    await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
      VALUES (?, ?, 'one', 'specialist', 'One task', 'Do one task', '[]', 'ready', ?, ?)`, [taskId, message.runId, now, now]);
    const schema = await db.one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations');
    expect(schema?.version).toBe(15);

    await db.run("INSERT INTO assignments(id, agent_instance_id, project_id, task_id, status, reserved_at, lease_owner, lease_expires_at, fence_token) VALUES ('assignment-a', 'writer-01', ?, ?, 'reserved', ?, 'worker-a', ?, 1)", [project.id, taskId, now, new Date(Date.now() + 60_000).toISOString()]);
    await expect(db.run("INSERT INTO assignments(id, agent_instance_id, project_id, task_id, status, reserved_at, lease_owner, lease_expires_at, fence_token) VALUES ('assignment-b', 'researcher-01', ?, ?, 'active', ?, 'worker-b', ?, 1)", [project.id, taskId, now, new Date(Date.now() + 60_000).toISOString()]))
      .rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });

    await db.run("UPDATE assignments SET status = 'released', released_at = ? WHERE id = 'assignment-a'", [now]);
    await db.run("INSERT INTO assignments(id, agent_instance_id, project_id, task_id, status, reserved_at, lease_owner, lease_expires_at, fence_token) VALUES ('assignment-c', 'researcher-01', ?, ?, 'reserved', ?, 'worker-b', ?, 1)", [project.id, taskId, now, new Date(Date.now() + 60_000).toISOString()]);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('reserved','active','releasing')", [taskId])).toEqual({ count: 1 });
  });
});

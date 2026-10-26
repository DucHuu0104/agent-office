import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

if (!parentPort) throw new Error('DB worker phải chạy trong Worker thread.');

type Operation = { mode: 'exec' | 'run' | 'get' | 'all'; sql: string; params?: unknown[] } | { mode: 'assert_changes'; sql: string; params?: unknown[] };
type Request = { id: number; kind: 'init'; file: string; readonly?: boolean } | { id: number; kind: 'batch'; transaction: boolean; operations: Operation[] } | { id: number; kind: 'backup'; file: string } | { id: number; kind: 'close' };
let db: Database.Database | null = null;
const CURRENT_SCHEMA_VERSION = 15;

parentPort.on('message', async (request: Request) => {
  try {
    if (request.kind === 'init') {
      if (request.readonly) {
        db = new Database(request.file, { readonly: true, fileMustExist: true });
      } else {
        mkdirSync(dirname(request.file), { recursive: true });
        const existed = existsSync(request.file);
        db = new Database(request.file);
        db.pragma('journal_mode = WAL');
        if (existed) await createPreMigrationBackup(db, request.file);
      }
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      if (!request.readonly) migrate(db);
      parentPort!.postMessage({ id: request.id, ok: true, result: true });
      return;
    }
    if (request.kind === 'close') {
      db?.close();
      db = null;
      parentPort!.postMessage({ id: request.id, ok: true, result: true });
      return;
    }
    if (!db) throw new Error('DB chưa được khởi tạo.');
    if (request.kind === 'backup') {
      await db.backup(request.file);
      parentPort!.postMessage({ id: request.id, ok: true, result: true });
      return;
    }
    const perform = () => request.operations.map((op) => {
      if (op.mode === 'assert_changes') {
        const result = db!.prepare('SELECT changes() AS changes').get() as { changes?: number } | undefined;
        if (!result?.changes) throw Object.assign(new Error('Conditional transaction guard did not update any rows.'), { code: 'REVISION_CONFLICT' });
        return result;
      }
      if (op.mode === 'exec') { db!.exec(op.sql); return null; }
      const statement = db!.prepare(op.sql);
      if (op.mode === 'run') return statement.run(...(op.params ?? []));
      if (op.mode === 'get') return statement.get(...(op.params ?? [])) ?? null;
      return statement.all(...(op.params ?? []));
    });
    const result = request.transaction ? db.transaction(perform)() : perform();
    parentPort!.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    const e = error as Error & { code?: string };
    parentPort!.postMessage({ id: request.id, ok: false, error: { message: e.message, code: e.code } });
  }
});

async function createPreMigrationBackup(database: Database.Database, file: string): Promise<void> {
  const sourceVersion = schemaVersion(database);
  if (sourceVersion >= CURRENT_SCHEMA_VERSION) return;

  const suffix = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + `-${randomUUID().slice(0, 8)}`;
  const backupFile = join(dirname(file), `agent-office.pre-migration-v${sourceVersion}-to-v${CURRENT_SCHEMA_VERSION}-${suffix}.sqlite`);
  await database.backup(backupFile);

  const snapshot = new Database(backupFile, { readonly: true, fileMustExist: true });
  try {
    const integrity = snapshot.pragma('integrity_check', { simple: true });
    const backupVersion = schemaVersion(snapshot);
    if (integrity !== 'ok' || backupVersion !== sourceVersion) {
      throw new Error(`Pre-migration backup verification failed for schema ${sourceVersion}.`);
    }
  } finally {
    snapshot.close();
  }
}

function schemaVersion(database: Database.Database): number {
  const migrations = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!migrations) return 0;
  const current = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
  return current.version;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const current = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
  if (current.version > CURRENT_SCHEMA_VERSION) throw new Error(`Database schema ${current.version} is newer than this application supports.`);
  if (current.version === CURRENT_SCHEMA_VERSION) return;
  if (current.version === 13) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE hook_outbox (
          hook_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          event TEXT NOT NULL,
          handler TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          task_id TEXT,
          agent_instance_id TEXT NOT NULL,
          payload_json TEXT,
          payload_hash TEXT NOT NULL,
          timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 50 AND 30000),
          on_error TEXT NOT NULL CHECK (on_error IN ('fail','warn')),
          status TEXT NOT NULL CHECK (status IN ('pending','completed','abandoned')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          result_json TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX hook_outbox_pending ON hook_outbox(status, created_at) WHERE status = 'pending';
      `);
      database.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (14, 'agent-office-schema-v14-durable-hook-outbox', ?)").run(new Date().toISOString());
    })();
    migrate(database);
    return;
  }
  if (current.version === 14) {
    database.transaction(() => {
      const hasRuns = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get();
      const columns = new Set(hasRuns ? (database.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((column) => column.name) : []);
      if (hasRuns && !columns.has('pause_requested')) database.exec('ALTER TABLE runs ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0,1))');
      if (hasRuns && !columns.has('pause_reason')) database.exec("ALTER TABLE runs ADD COLUMN pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('user','budget'))");
      database.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (15, 'agent-office-schema-v15-user-pause-checkpoint', ?)").run(new Date().toISOString());
    })();
    migrate(database);
    return;
  }
  if (current.version === 12) {
    database.transaction(() => {
      const hasAgentInstances = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_instances'").get();
      const columns = new Set((database.prepare('PRAGMA table_info(agent_instances)').all() as Array<{ name: string }>).map((column) => column.name));
      if (hasAgentInstances && !columns.has('draining')) database.exec('ALTER TABLE agent_instances ADD COLUMN draining INTEGER NOT NULL DEFAULT 0 CHECK (draining IN (0,1))');
      database.exec("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (13, 'agent-office-schema-v13-agent-drain-state', '" + new Date().toISOString() + "')");
    })();
    migrate(database);
    return;
  }
  if (current.version === 11) {
    database.transaction(() => {
      const hasReservations = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_call_reservations'").get();
      const hasRuns = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get();
      const reservationColumns = new Set(hasReservations ? (database.prepare('PRAGMA table_info(model_call_reservations)').all() as Array<{ name: string }>).map((column) => column.name) : []);
      const runColumns = new Set(hasRuns ? (database.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((column) => column.name) : []);
      if (hasReservations && !reservationColumns.has('pricing_model')) database.exec('ALTER TABLE model_call_reservations ADD COLUMN pricing_model TEXT');
      if (hasReservations && !reservationColumns.has('pricing_version')) database.exec('ALTER TABLE model_call_reservations ADD COLUMN pricing_version TEXT');
      if (hasReservations && !reservationColumns.has('input_rate_usd_per_million')) database.exec('ALTER TABLE model_call_reservations ADD COLUMN input_rate_usd_per_million REAL');
      if (hasReservations && !reservationColumns.has('output_rate_usd_per_million')) database.exec('ALTER TABLE model_call_reservations ADD COLUMN output_rate_usd_per_million REAL');
      if (hasReservations && !reservationColumns.has('reserved_cost_microusd')) database.exec('ALTER TABLE model_call_reservations ADD COLUMN reserved_cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_microusd >= 0)');
      if (hasReservations && !reservationColumns.has('actual_cost_microusd')) database.exec('ALTER TABLE model_call_reservations ADD COLUMN actual_cost_microusd INTEGER CHECK (actual_cost_microusd IS NULL OR actual_cost_microusd >= 0)');
      if (hasRuns && !runColumns.has('money_budget_microusd')) database.exec('ALTER TABLE runs ADD COLUMN money_budget_microusd INTEGER CHECK (money_budget_microusd IS NULL OR money_budget_microusd > 0)');
      database.exec("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (12, 'agent-office-schema-v12-priced-usage-budget', '" + new Date().toISOString() + "')");
    })();
    migrate(database);
    return;
  }
  if (current.version === 10) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE message_attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL CHECK (mime_type IN ('text/plain','text/markdown','text/csv','application/json')),
          size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 65536),
          checksum TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(message_id, ordinal)
        );
        CREATE INDEX message_attachments_message ON message_attachments(message_id, ordinal);
        INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (11, 'agent-office-schema-v11-message-attachments', '${new Date().toISOString()}');
      `);
    })();
    migrate(database);
    return;
  }
  if (current.version === 9) {
    database.transaction(() => {
      const runColumns = new Set((database.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((column) => column.name));
      if (!runColumns.has('version')) database.exec('ALTER TABLE runs ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)');
      database.exec("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (10, 'agent-office-schema-v10-run-version', '" + new Date().toISOString() + "')");
    })();
    migrate(database);
    return;
  }
  if (current.version === 8) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE run_steering (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
          sequence INTEGER NOT NULL,
          target_task_id TEXT REFERENCES tasks(id),
          status TEXT NOT NULL CHECK (status IN ('pending','acknowledged')) DEFAULT 'pending',
          created_at TEXT NOT NULL,
          acknowledged_at TEXT,
          UNIQUE(run_id, sequence)
        );
        CREATE INDEX run_steering_pending ON run_steering(run_id, sequence) WHERE status = 'pending';
        INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (9, 'agent-office-schema-v9-run-steering-commands', '${new Date().toISOString()}');
      `);
    })();
    migrate(database);
    return;
  }
  if (current.version === 7) {
    database.transaction(() => {
      const hasAgentInstances = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_instances'").get();
      const agentColumns = new Set(hasAgentInstances ? (database.prepare('PRAGMA table_info(agent_instances)').all() as Array<{ name: string }>).map((column) => column.name) : []);
      const assignmentColumns = new Set((database.prepare('PRAGMA table_info(assignments)').all() as Array<{ name: string }>).map((column) => column.name));
      if (hasAgentInstances && !agentColumns.has('fence_token')) database.exec('ALTER TABLE agent_instances ADD COLUMN fence_token INTEGER NOT NULL DEFAULT 0 CHECK (fence_token >= 0)');
      if (!assignmentColumns.has('lease_owner')) database.exec('ALTER TABLE assignments ADD COLUMN lease_owner TEXT');
      if (!assignmentColumns.has('lease_expires_at')) database.exec('ALTER TABLE assignments ADD COLUMN lease_expires_at TEXT');
      if (!assignmentColumns.has('fence_token')) database.exec('ALTER TABLE assignments ADD COLUMN fence_token INTEGER NOT NULL DEFAULT 0 CHECK (fence_token >= 0)');
      if (!assignmentColumns.has('worker_acknowledged_at')) database.exec('ALTER TABLE assignments ADD COLUMN worker_acknowledged_at TEXT');
      database.exec(`
        CREATE INDEX IF NOT EXISTS assignments_live_lease_expiry ON assignments(status, lease_expires_at) WHERE status IN ('reserved','active','releasing');
        INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (8, 'agent-office-schema-v8-assignment-leases-and-fencing', '${new Date().toISOString()}');
      `);
    })();
    migrate(database);
    return;
  }
  if (current.version === 6) {
    database.transaction(() => {
      const duplicate = database.prepare("SELECT task_id, COUNT(*) AS count FROM assignments WHERE status IN ('reserved','active','releasing') GROUP BY task_id HAVING COUNT(*) > 1 LIMIT 1").get() as { task_id: string; count: number } | undefined;
      if (duplicate) throw new Error(`Cannot migrate assignments: task ${duplicate.task_id} has ${duplicate.count} live assignments; reconcile it before upgrading.`);
      database.exec(`
        CREATE UNIQUE INDEX one_live_assignment_per_task ON assignments(task_id) WHERE status IN ('reserved','active','releasing');
        INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (7, 'agent-office-schema-v7-one-live-assignment-per-task', '${new Date().toISOString()}');
      `);
    })();
    migrate(database);
    return;
  }
  if (current.version === 5) {
    database.transaction(() => {
      const rows = database.prepare(`SELECT m.id, m.workspace_id, m.project_id, m.scope_type, m.scope_id, m.content, m.source_type, m.source_ref,
        m.source_version, m.source_checksum, m.created_by, m.confidence_label, m.expires_at, m.status, m.updated_at
        FROM memory_records m WHERE NOT EXISTS (SELECT 1 FROM memory_record_revisions r WHERE r.memory_id = m.id)`).all() as Array<Record<string, unknown>>;
      const insert = database.prepare(`INSERT INTO memory_record_revisions(id, memory_id, revision, status, content, source_type, source_ref, source_version,
        source_checksum, created_by, confidence_label, expires_at, reason, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'migration_v6_baseline', ?)`);
      const reset = database.prepare('UPDATE memory_records SET revision = 1, content = ?, source_type = ?, source_ref = ?, source_version = ?, source_checksum = ?, created_by = ?, confidence_label = ?, expires_at = ? WHERE id = ?');
      for (const row of rows) {
        const deleted = row.status === 'deleted';
        const content = deleted ? '' : row.content;
        const sourceType = deleted ? 'deleted' : row.source_type;
        const sourceRef = deleted ? null : row.source_ref;
        const sourceVersion = deleted ? null : row.source_version;
        const sourceChecksum = deleted ? null : row.source_checksum;
        const createdBy = deleted ? 'local-user' : row.created_by;
        const confidence = deleted ? 'deleted' : row.confidence_label;
        const expiresAt = deleted ? null : row.expires_at;
        insert.run(randomUUID(), row.id, row.status, content, sourceType, sourceRef, sourceVersion, sourceChecksum, createdBy, confidence, expiresAt, row.updated_at);
        reset.run(content, sourceType, sourceRef, sourceVersion, sourceChecksum, createdBy, confidence, expiresAt, row.id);
      }
      database.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (6, 'agent-office-schema-v6-memory-baseline', ?)").run(new Date().toISOString());
    })();
    migrate(database);
    return;
  }
  if (current.version === 4) {
    database.transaction(() => {
      const hasMemoryTable = !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_records'").get();
      if (!hasMemoryTable) database.exec(`CREATE TABLE memory_records (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT REFERENCES projects(id),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('user','agent','project','run')), scope_id TEXT NOT NULL, content TEXT NOT NULL,
        source_type TEXT NOT NULL, source_ref TEXT, source_version TEXT, source_checksum TEXT, created_by TEXT NOT NULL DEFAULT 'system',
        confidence_label TEXT NOT NULL DEFAULT 'unverified', expires_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','deleted')), revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      const memoryColumns = new Set((database.prepare('PRAGMA table_info(memory_records)').all() as Array<{ name: string }>).map((column) => column.name));
      const addColumn = (name: string, definition: string) => { if (!memoryColumns.has(name)) database.exec(`ALTER TABLE memory_records ADD COLUMN ${name} ${definition}`); };
      addColumn('source_version', 'TEXT');
      addColumn('source_checksum', 'TEXT');
      addColumn('created_by', "TEXT NOT NULL DEFAULT 'system'");
      addColumn('confidence_label', "TEXT NOT NULL DEFAULT 'unverified'");
      addColumn('expires_at', 'TEXT');
      database.exec(`
        CREATE INDEX IF NOT EXISTS memory_scope_status_updated ON memory_records(workspace_id, scope_type, scope_id, status, updated_at DESC);
        CREATE TABLE IF NOT EXISTS memory_record_revisions (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES memory_records(id),
          revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','deleted')),
          content TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_ref TEXT,
          source_version TEXT,
          source_checksum TEXT,
          created_by TEXT NOT NULL,
          confidence_label TEXT NOT NULL,
          expires_at TEXT,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(memory_id, revision)
        );
        INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (5, 'agent-office-schema-v5-memory-revisions', '${new Date().toISOString()}');
      `);
    })();
    migrate(database);
    return;
  }
  if (current.version === 3) {
    database.transaction(() => {
      database.exec(`
        ALTER TABLE runs ADD COLUMN token_budget INTEGER NOT NULL DEFAULT 120000;
        INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (4, 'agent-office-schema-v4-run-token-budget', '${new Date().toISOString()}');
      `);
    })();
    migrate(database);
    return;
  }
  if (current.version === 2) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE model_call_reservations (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          task_id TEXT REFERENCES tasks(id),
          agent_instance_id TEXT REFERENCES agent_instances(id),
          request_id TEXT,
          prompt_reservation INTEGER NOT NULL CHECK (prompt_reservation >= 0),
          output_reservation INTEGER NOT NULL CHECK (output_reservation >= 0),
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          total_tokens INTEGER,
          status TEXT NOT NULL CHECK (status IN ('reserved','settled','unknown')),
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX model_call_reservations_run ON model_call_reservations(run_id, status);
        INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (3, 'agent-office-schema-v3-model-call-reservations', '${new Date().toISOString()}');
      `);
    })();
    migrate(database);
    return;
  }
  if (current.version === 1) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, position INTEGER NOT NULL,
          state_json TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tool_operations (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT REFERENCES tasks(id),
          tool_id TEXT NOT NULL, arguments_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed','pending_approval','authorized','dispatched','succeeded','failed','outcome_unknown','cancelled')),
          receipt_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_usage (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT REFERENCES tasks(id),
          agent_instance_id TEXT REFERENCES agent_instances(id), request_id TEXT,
          prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_records (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT REFERENCES projects(id),
          scope_type TEXT NOT NULL CHECK (scope_type IN ('user','agent','project','run')), scope_id TEXT NOT NULL,
          content TEXT NOT NULL, source_type TEXT NOT NULL, source_ref TEXT,
          status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','deleted')),
          revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (2, 'agent-office-schema-v2-runtime-records', '${new Date().toISOString()}');
      `);
    })();
    migrate(database);
    return;
  }
  const migration = `
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      next_room_ordinal INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      room_ordinal INTEGER NOT NULL,
      workspace_root TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, room_ordinal)
    );
    CREATE INDEX projects_active_order ON projects(workspace_id, status, room_ordinal);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, id)
    );
    CREATE TABLE agent_definitions (
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      system_text TEXT NOT NULL,
      soul_text TEXT NOT NULL,
      tools_text TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(id, version)
    );
    CREATE TABLE agent_instances (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      definition_id TEXT NOT NULL,
      definition_version TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('coordinator', 'specialist')),
      appearance_seed INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(definition_id, definition_version) REFERENCES agent_definitions(id, version)
    );
    CREATE TABLE coordinator_bindings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      instance_id TEXT NOT NULL UNIQUE REFERENCES agent_instances(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      run_id TEXT,
      sequence INTEGER NOT NULL,
      speaker TEXT NOT NULL CHECK (speaker IN ('user', 'coordinator', 'specialist', 'system')),
      agent_instance_id TEXT REFERENCES agent_instances(id),
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'streaming', 'completed', 'failed')),
      created_at TEXT NOT NULL,
      UNIQUE(conversation_id, sequence)
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      status TEXT NOT NULL CHECK (status IN ('queued', 'planning', 'executing', 'waiting_approval', 'paused', 'succeeded', 'failed', 'cancelled', 'interrupted')),
      request_message_id TEXT NOT NULL REFERENCES messages(id),
      plan_revision INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX runs_active_by_conversation ON runs(conversation_id, status);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      task_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('coordinator', 'specialist', 'review')),
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      required_capabilities_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'blocked_dependencies', 'ready', 'assigned', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
      assigned_agent_id TEXT REFERENCES agent_instances(id),
      output TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, task_key)
    );
    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id),
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
      PRIMARY KEY(task_id, depends_on_task_id),
      CHECK(task_id <> depends_on_task_id)
    );
    CREATE TABLE assignments (
      id TEXT PRIMARY KEY,
      agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'active', 'releasing', 'released')),
      reserved_at TEXT NOT NULL,
      released_at TEXT
    );
    CREATE UNIQUE INDEX one_live_assignment_per_agent ON assignments(agent_instance_id) WHERE status IN ('reserved', 'active', 'releasing');
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      logical_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE artifact_versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      task_id TEXT REFERENCES tasks(id),
      storage_key TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      checksum TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      run_id TEXT NOT NULL REFERENCES runs(id),
      task_id TEXT REFERENCES tasks(id),
      operation_id TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
      expires_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tool_operations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      task_id TEXT REFERENCES tasks(id),
      tool_id TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'pending_approval', 'authorized', 'dispatched', 'succeeded', 'failed', 'outcome_unknown', 'cancelled')),
      receipt_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      task_id TEXT REFERENCES tasks(id),
      agent_instance_id TEXT REFERENCES agent_instances(id),
      request_id TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      project_id TEXT REFERENCES projects(id),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'agent', 'project', 'run')),
      scope_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'deleted')),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE domain_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      type TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id),
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX events_workspace_sequence ON domain_events(workspace_id, sequence);
    CREATE TABLE idempotency_keys (
      actor_id TEXT NOT NULL,
      method TEXT NOT NULL,
      route TEXT NOT NULL,
      key TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY(actor_id, method, route, key)
    );
    INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (1, 'agent-office-schema-v1', '${new Date().toISOString()}');
  `;
  database.transaction(() => {
    database.exec(migration);
    database.prepare('INSERT INTO workspaces(id, name, created_at) VALUES (?, ?, ?)').run('local-workspace', 'My workspace', new Date().toISOString());
  })();
  migrate(database);
}

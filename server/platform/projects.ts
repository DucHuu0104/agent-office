import { createHash, randomUUID } from 'node:crypto';
import type { Agent, Message, MessageAttachment, MessageAttachmentInput, OfficeSnapshot, Project, Task } from '../../shared/platform/contracts';
import { agentSchema, messageSchema, officeSnapshotSchema, projectSchema, taskSchema } from '../../shared/platform/contracts';
import type { Registry } from './registry';
import type { DatabaseClient, DbOperation } from './database';
import { EventHub } from './events';

const WORKSPACE_ID = 'local-workspace';
const STALE_RUN_STATES = "('queued','planning','executing','waiting_approval','paused')";

interface ProjectRow {
  id: string; name: string; goal: string; status: 'active' | 'archived'; room_ordinal: number;
  coordinator_instance_id: string; conversation_id: string; created_at: string; updated_at: string;
  workspace_root: string | null;
}
interface AgentRow {
  id: string; definition_id: string; display_name: string; role: 'coordinator' | 'specialist';
  appearance_seed: number; enabled: number; draining: number; capabilities_json: string; model_profile: string;
  manifest_json: string;
  project_id: string | null; task_id: string | null; task_status: string | null; task_title: string | null;
  updated_at: string;
}
interface MessageRow {
  id: string; conversation_id: string; run_id: string | null; speaker: Message['speaker'];
  agent_instance_id: string | null; content: string; status: Message['status']; created_at: string; sequence: number;
}
interface AttachmentRow {
  id: string; message_id: string; name: string; mime_type: MessageAttachment['mimeType'];
  size_bytes: number; checksum: string; content?: string; created_at: string;
}
export interface MessageAttachmentContent extends MessageAttachment { content: string }
export interface FinalRunMessageInput {
  projectId: string;
  conversationId: string;
  runId: string;
  agentId: string;
  content: string;
  status: 'succeeded' | 'failed' | 'waiting_approval';
  errorCode: string | null;
  messageStatus?: Message['status'];
}
interface TaskRow {
  id: string; run_id: string; task_key: string; title: string; objective: string;
  required_capabilities_json: string; status: Task['status']; assigned_agent_id: string | null;
  output: string | null; created_at: string; updated_at: string;
}

export class ProjectService {
  private readonly messageGuards = new Map<string, Promise<void>>();

  constructor(private readonly db: DatabaseClient, private readonly events: EventHub, private readonly registry: Registry) {}

  async seedRegistry(registry: Registry = this.registry): Promise<void> {
    const coordinator = registry.definitions.get('coordinator');
    if (!coordinator) throw new Error('Registry thiếu definition coordinator.');
    const operations: DbOperation[] = [];
    for (const definition of registry.definitions.values()) {
      const saved = await this.db.one<{ config_hash: string }>('SELECT config_hash FROM agent_definitions WHERE id = ? AND version = ?', [definition.manifest.id, definition.manifest.version]);
      if (saved && saved.config_hash !== definition.configHash) throw new Error(`Definition ${definition.manifest.id}@${definition.manifest.version} đã tồn tại với nội dung khác; cần tăng version.`);
      operations.push({ mode: 'run', sql: `INSERT INTO agent_definitions(id, version, config_hash, manifest_json, system_text, soul_text, tools_text, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id, version) DO NOTHING`, params: [
        definition.manifest.id, definition.manifest.version, definition.configHash, JSON.stringify(definition.manifest),
        definition.system, definition.soul, definition.tools,
      ] });
    }
    for (const entry of registry.roster) {
      const def = registry.definitions.get(entry.definition)!;
      operations.push({ mode: 'run', sql: `INSERT INTO agent_instances(id, workspace_id, definition_id, definition_version, display_name, role, appearance_seed, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, 'specialist', ?, ?, ?) ON CONFLICT(id) DO NOTHING`, params: [
        entry.id, WORKSPACE_ID, entry.definition, def.manifest.version, entry.displayName, entry.appearanceSeed, entry.enabled ? 1 : 0, new Date().toISOString(),
      ] });
      operations.push({ mode: 'run', sql: `UPDATE agent_instances SET definition_version = ?, enabled = ?
        WHERE id = ? AND definition_id = ? AND display_name = ?`, params: [def.manifest.version, entry.enabled ? 1 : 0, entry.id, entry.definition, entry.displayName] });
    }
    if (operations.length) await this.db.batch(operations, true);
    for (const entry of registry.roster) {
      const row = await this.db.one<{ definition_id: string; display_name: string }>('SELECT definition_id, display_name FROM agent_instances WHERE id = ?', [entry.id]);
      if (row?.definition_id !== entry.definition || row.display_name !== entry.displayName) throw new Error(`Roster instance ${entry.id} đã tồn tại với cấu hình khác; không ghi đè danh tính.`);
    }
  }

  updateRegistry(registry: Registry): void {
    Object.assign(this.registry, registry);
  }

  async createProject(input: { name: string; goal: string; workspaceRoot?: string }, idempotency?: { key: string; bodyHash: string }): Promise<Project> {
    if (idempotency) {
      const existing = await this.findIdempotentProject(idempotency);
      if (existing) return existing;
    }
    const id = randomUUID();
    const coordinatorId = randomUUID();
    const conversationId = randomUUID();
    const now = new Date().toISOString();
    const coord = this.registry.definitions.get('coordinator')!;
    const operations: DbOperation[] = [
      { mode: 'run', sql: 'UPDATE workspaces SET next_room_ordinal = next_room_ordinal + 1 WHERE id = ?', params: [WORKSPACE_ID] },
      { mode: 'run', sql: `INSERT INTO projects(id, workspace_id, name, goal, status, room_ordinal, workspace_root, created_at, updated_at)
        SELECT ?, id, ?, ?, 'active', next_room_ordinal - 1, ?, ?, ? FROM workspaces WHERE id = ?`, params: [id, input.name, input.goal, input.workspaceRoot ?? null, now, now, WORKSPACE_ID] },
      { mode: 'run', sql: 'INSERT INTO conversations(id, project_id, title, created_at) VALUES (?, ?, ?, ?)', params: [conversationId, id, 'Cuộc trò chuyện chính', now] },
      { mode: 'run', sql: `INSERT INTO agent_instances(id, workspace_id, definition_id, definition_version, display_name, role, appearance_seed, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, 'coordinator', ?, 1, ?)`, params: [coordinatorId, WORKSPACE_ID, 'coordinator', coord.manifest.version, `Coordinator · ${input.name}`, seedFrom(id), now] },
      { mode: 'run', sql: 'INSERT INTO coordinator_bindings(project_id, instance_id, created_at) VALUES (?, ?, ?)', params: [id, coordinatorId, now] },
    ];
    if (idempotency) operations.push({ mode: 'run', sql: `INSERT INTO idempotency_keys(actor_id, method, route, key, body_hash, response_json, expires_at)
      VALUES ('local-user', 'POST', '/projects', ?, ?, ?, ?)`, params: [idempotency.key, idempotency.bodyHash, JSON.stringify({ projectId: id }), new Date(Date.now() + 86_400_000).toISOString()] });
    try {
      await this.events.transact('project.created', id, id, { projectId: id, coordinatorInstanceId: coordinatorId, conversationId }, operations);
    } catch (error) {
      if (idempotency) {
        const committed = await this.findIdempotentProject(idempotency);
        if (committed) return committed;
      }
      throw error;
    }
    const project = await this.getProject(id);
    if (!project) throw new Error('Project không xuất hiện sau khi tạo.');
    return project;
  }

  private async findIdempotentProject(idempotency: { key: string; bodyHash: string }): Promise<Project | null> {
    const prior = await this.db.one<{ body_hash: string; response_json: string }>(
      "SELECT body_hash, response_json FROM idempotency_keys WHERE actor_id = 'local-user' AND method = 'POST' AND route = '/projects' AND key = ?",
      [idempotency.key],
    );
    if (!prior) return null;
    if (prior.body_hash !== idempotency.bodyHash) throw Object.assign(new Error('Idempotency-Key đã được dùng với nội dung khác.'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const saved = JSON.parse(prior.response_json) as { projectId: string };
    const project = await this.getProject(saved.projectId);
    if (!project) throw new Error('Idempotency record points to a missing project.');
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.db.one<ProjectRow>(`SELECT p.id, p.name, p.goal, p.status, p.room_ordinal,
      b.instance_id AS coordinator_instance_id, c.id AS conversation_id, p.created_at, p.updated_at, p.workspace_root
      FROM projects p JOIN coordinator_bindings b ON b.project_id = p.id
      JOIN conversations c ON c.project_id = p.id WHERE p.id = ?`, [id]);
    return row ? projectSchema.parse({
      id: row.id, name: row.name, goal: row.goal, status: row.status, roomOrdinal: row.room_ordinal,
      coordinatorInstanceId: row.coordinator_instance_id, conversationId: row.conversation_id,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }) : null;
  }

  async listProjects(status: 'active' | 'archived' = 'active'): Promise<Project[]> {
    const rows = await this.db.all<ProjectRow>(`SELECT p.id, p.name, p.goal, p.status, p.room_ordinal,
      b.instance_id AS coordinator_instance_id, c.id AS conversation_id, p.created_at, p.updated_at, p.workspace_root
      FROM projects p JOIN coordinator_bindings b ON b.project_id = p.id
      JOIN conversations c ON c.project_id = p.id WHERE p.workspace_id = ? AND p.status = ? ORDER BY p.room_ordinal`, [WORKSPACE_ID, status]);
    return rows.map((row) => projectSchema.parse({
      id: row.id, name: row.name, goal: row.goal, status: row.status, roomOrdinal: row.room_ordinal,
      coordinatorInstanceId: row.coordinator_instance_id, conversationId: row.conversation_id,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  async archiveProject(id: string): Promise<Project | null> {
    const project = await this.getProject(id);
    if (!project) return null;
    const active = await this.db.one<{ count: number }>(`SELECT COUNT(*) AS count FROM runs WHERE project_id = ? AND status IN ${STALE_RUN_STATES}`, [id]);
    if ((active?.count ?? 0) > 0) throw Object.assign(new Error('Hãy kết thúc hoặc hủy các lượt chạy trước khi lưu trữ project.'), { status: 409, code: 'PROJECT_HAS_ACTIVE_RUNS' });
    const now = new Date().toISOString();
    await this.events.transact('project.archived', id, id, { projectId: id }, [
      { mode: 'run', sql: "UPDATE projects SET status = 'archived', version = version + 1, updated_at = ? WHERE id = ? AND status = 'active'", params: [now, id] },
    ]);
    return this.getProject(id);
  }

  async restoreProject(id: string): Promise<Project | null> {
    const project = await this.getProject(id);
    if (!project) return null;
    await this.events.transact('project.restored', id, id, { projectId: id }, [
      { mode: 'run', sql: "UPDATE projects SET status = 'active', version = version + 1, updated_at = ? WHERE id = ? AND status = 'archived'", params: [new Date().toISOString(), id] },
    ]);
    return this.getProject(id);
  }

  async officeSnapshot(): Promise<OfficeSnapshot> {
    const projects = await this.listProjects('active');
    const agentRows = await this.db.all<AgentRow>(`SELECT i.id, i.definition_id, i.display_name, i.role, i.appearance_seed, i.enabled, i.draining,
      d.manifest_json, i.created_at AS updated_at, p.id AS project_id, t.id AS task_id, t.status AS task_status, t.title AS task_title
      FROM agent_instances i JOIN agent_definitions d ON d.id = i.definition_id AND d.version = i.definition_version
      LEFT JOIN coordinator_bindings b ON b.instance_id = i.id LEFT JOIN projects cp ON cp.id = b.project_id AND cp.status = 'active'
      LEFT JOIN assignments a ON a.agent_instance_id = i.id AND a.status IN ('reserved','active','releasing')
      LEFT JOIN projects p ON p.id = COALESCE(a.project_id, cp.id) AND p.status = 'active'
      LEFT JOIN tasks t ON t.id = a.task_id
      WHERE i.workspace_id = ? AND i.enabled = 1 AND (i.role = 'specialist' OR cp.id IS NOT NULL)
      ORDER BY CASE i.role WHEN 'coordinator' THEN 0 ELSE 1 END, i.display_name`, [WORKSPACE_ID]);
    const agents = agentRows.map((row) => {
      const manifest = JSON.parse(row.manifest_json) as { capabilities: string[]; modelProfile: string };
      const assigned = !!row.task_id;
      const availability: Agent['availability'] = !row.enabled ? 'disabled' : row.draining ? 'draining' : assigned ? 'busy' : 'ready';
      const execution: Agent['execution'] = row.task_status === 'running' ? 'running' : row.task_status === 'waiting_approval' ? 'waiting' : assigned ? 'blocked' : 'ready';
      return agentSchema.parse({
        id: row.id, definitionId: row.definition_id, displayName: row.display_name, role: row.role,
        capabilities: manifest.capabilities, availability, execution,
        location: row.project_id ? { kind: 'project', projectId: row.project_id } : { kind: 'pool' },
        projectId: row.project_id, currentTaskId: row.task_id, modelProfile: manifest.modelProfile,
        appearanceSeed: row.appearance_seed, updatedAt: row.updated_at || new Date().toISOString(),
      });
    });
    const counts = await this.db.one<{ active_runs: number; pending_approvals: number; revision: number }>(`SELECT
      (SELECT COUNT(*) FROM runs WHERE status IN ('queued','planning','executing','waiting_approval','paused')) AS active_runs,
      (SELECT COUNT(*) FROM approvals WHERE status = 'pending') AS pending_approvals,
      revision FROM workspaces WHERE id = ?`, [WORKSPACE_ID]);
    return officeSnapshotSchema.parse({
      revision: counts?.revision ?? 0,
      serverTime: new Date().toISOString(),
      projects,
      agents,
      activeRuns: counts?.active_runs ?? 0,
      pendingApprovals: counts?.pending_approvals ?? 0,
    });
  }

  async listMessages(conversationId: string, limit = 100, throughSequence?: number): Promise<Message[]> {
    const rows = await this.db.all<MessageRow>('SELECT id, conversation_id, run_id, speaker, agent_instance_id, content, status, created_at, sequence FROM messages WHERE conversation_id = ? AND (? IS NULL OR sequence <= ?) ORDER BY sequence DESC LIMIT ?', [conversationId, throughSequence ?? null, throughSequence ?? null, Math.max(1, Math.min(200, limit))]);
    const ordered = rows.reverse();
    const attachmentMap = await this.attachmentsForMessageIds(ordered.map((row) => row.id), false);
    return ordered.map((row) => messageSchema.parse({
      id: row.id, conversationId: row.conversation_id, runId: row.run_id, speaker: row.speaker,
      agentInstanceId: row.agent_instance_id, content: row.content, status: row.status, createdAt: row.created_at,
      ...(attachmentMap.get(row.id)?.length ? { attachments: attachmentMap.get(row.id)!.map(({ id, name, mimeType, sizeBytes, checksum }) => ({ id, name, mimeType, sizeBytes, checksum })) } : {}),
    }));
  }

  async attachmentsForMessage(messageId: string): Promise<MessageAttachmentContent[]> {
    const byMessage = await this.attachmentsForMessageIds([messageId], true);
    return byMessage.get(messageId) ?? [];
  }

  async attachmentsForRun(runId: string): Promise<MessageAttachmentContent[]> {
    const request = await this.db.one<{ message_id: string }>('SELECT request_message_id AS message_id FROM runs WHERE id = ?', [runId]);
    return request ? this.attachmentsForMessage(request.message_id) : [];
  }

  private async attachmentsForMessageIds(messageIds: string[], includeContent: boolean): Promise<Map<string, MessageAttachmentContent[]>> {
    if (!messageIds.length) return new Map();
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = await this.db.all<AttachmentRow>(`SELECT id, message_id, name, mime_type, size_bytes, checksum, created_at${includeContent ? ', content' : ''}
      FROM message_attachments WHERE message_id IN (${placeholders}) ORDER BY message_id, ordinal`, messageIds);
    const byMessage = new Map<string, MessageAttachmentContent[]>();
    for (const row of rows) {
      const attachment = {
        id: row.id, name: row.name, mimeType: row.mime_type, sizeBytes: row.size_bytes, checksum: row.checksum,
        ...(includeContent ? { content: row.content ?? '' } : {}),
      } as MessageAttachmentContent;
      byMessage.set(row.message_id, [...(byMessage.get(row.message_id) ?? []), attachment]);
    }
    return byMessage;
  }

  async createUserMessage(projectId: string, conversationId: string, text: string, idempotency?: { key: string; bodyHash: string }, mode: 'new-run' | 'enqueue' = 'new-run', attachments: MessageAttachmentInput[] = []): Promise<{ message: Message; runId: string }> {
    return this.serializeConversation(conversationId, () => this.createUserMessageRecord(projectId, conversationId, text, idempotency, mode, attachments));
  }

  async createSteeringMessage(
    projectId: string,
    conversationId: string,
    text: string,
    idempotency?: { key: string; bodyHash: string },
    targetTaskId?: string,
    options: { runId?: string; expectedVersion?: number; idempotencyRoute?: string; attachments?: MessageAttachmentInput[] } = {},
  ): Promise<{ message: Message; runId: string; steeringId: string; sequence: number }> {
    return this.serializeConversation(conversationId, async () => {
      const project = await this.getProject(projectId);
      if (!project || project.status !== 'active' || project.conversationId !== conversationId) throw Object.assign(new Error('Project hoặc conversation không tồn tại.'), { status: 404, code: 'PROJECT_NOT_FOUND' });
      const idempotencyRoute = options.idempotencyRoute ?? `/conversations/${conversationId}/messages`;
      if (idempotency) {
        const prior = await this.db.one<{ body_hash: string; response_json: string }>("SELECT body_hash, response_json FROM idempotency_keys WHERE actor_id = 'local-user' AND method = 'POST' AND route = ? AND key = ?", [idempotencyRoute, idempotency.key]);
        if (prior) {
          if (prior.body_hash !== idempotency.bodyHash) throw Object.assign(new Error('Idempotency-Key đã được dùng với nội dung khác.'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
          const value = JSON.parse(prior.response_json) as { messageId: string; runId: string; steeringId?: string; sequence?: number };
          const message = (await this.listMessages(conversationId, 200)).find((item) => item.id === value.messageId);
          if (message && value.steeringId && Number.isInteger(value.sequence)) return { message, runId: value.runId, steeringId: value.steeringId, sequence: value.sequence! };
        }
      }
      const run = await this.db.one<{ id: string; status: string; version: number }>(`SELECT id, status, version FROM runs WHERE conversation_id = ? AND project_id = ?
        AND (? IS NULL OR id = ?)
        AND status IN ('planning','executing','waiting_approval','paused') AND COALESCE(error_code, '') <> 'WAITING_FOR_USER_INPUT'
        AND COALESCE(error_code, '') <> 'FINALIZING' ORDER BY created_at LIMIT 1`, [conversationId, projectId, options.runId ?? null, options.runId ?? null]);
      if (!run) throw Object.assign(new Error('Không có lượt chạy đang hoạt động để nhận lệnh điều hướng.'), { status: 409, code: 'RUN_NOT_STEERABLE' });
      if (options.expectedVersion !== undefined && run.version !== options.expectedVersion) throw Object.assign(new Error('Run đã thay đổi; hãy tải lại rồi gửi lệnh điều hướng.'), { status: 409, code: 'RUN_VERSION_CONFLICT' });
      if (targetTaskId) {
        const target = await this.db.one<{ status: string }>("SELECT status FROM tasks WHERE id = ? AND run_id = ?", [targetTaskId, run.id]);
        if (!target) throw Object.assign(new Error('Task điều hướng không thuộc lượt chạy hiện tại.'), { status: 404, code: 'STEERING_TASK_NOT_FOUND' });
        if (['succeeded', 'failed', 'cancelled'].includes(target.status)) throw Object.assign(new Error('Task đã kết thúc nên không thể nhận lệnh điều hướng.'), { status: 409, code: 'STEERING_TASK_FINISHED' });
      }
      const messageId = randomUUID();
      const steeringId = randomUUID();
      const now = new Date().toISOString();
      const sequenceRow = await this.db.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_steering WHERE run_id = ?', [run.id]);
      const sequence = sequenceRow?.sequence ?? 1;
      const responseBody = JSON.stringify({ messageId, runId: run.id, steeringId, sequence });
      const operations: DbOperation[] = [
        { mode: 'run', sql: `UPDATE runs SET version = version + 1, updated_at = ? WHERE id = ? AND project_id = ? AND version = ?
          AND status IN ('planning','executing','waiting_approval','paused') AND COALESCE(error_code, '') NOT IN ('WAITING_FOR_USER_INPUT','FINALIZING')
          AND (? IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE id = ? AND run_id = runs.id AND status NOT IN ('succeeded','failed','cancelled')))`, params: [now, run.id, projectId, run.version, targetTaskId ?? null, targetTaskId ?? null] },
        { mode: 'run', sql: `INSERT INTO messages(id, conversation_id, run_id, sequence, speaker, content, status, created_at)
          SELECT ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, 'user', ?, 'completed', ? FROM messages WHERE conversation_id = ?
          AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND project_id = ? AND version = ? AND status IN ('planning','executing','waiting_approval','paused')
            AND COALESCE(error_code, '') NOT IN ('WAITING_FOR_USER_INPUT','FINALIZING'))`, params: [messageId, conversationId, run.id, text, now, conversationId, run.id, projectId, run.version + 1] },
        ...this.attachmentOperations(messageId, options.attachments ?? [], now),
        { mode: 'run', sql: `INSERT INTO run_steering(id, run_id, message_id, sequence, target_task_id, status, created_at)
          SELECT ?, ?, ?, ?, ?, 'pending', ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND run_id = ?)
            AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND version = ? AND status IN ('planning','executing','waiting_approval','paused')
              AND COALESCE(error_code, '') NOT IN ('WAITING_FOR_USER_INPUT','FINALIZING'))
            AND (? IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE id = ? AND run_id = ? AND status NOT IN ('succeeded','failed','cancelled')))`, params: [steeringId, run.id, messageId, sequence, targetTaskId ?? null, now, messageId, run.id, run.id, run.version + 1, targetTaskId ?? null, targetTaskId ?? null, run.id] },
      ];
      if (idempotency) operations.push({ mode: 'run', sql: `INSERT INTO idempotency_keys(actor_id, method, route, key, body_hash, response_json, expires_at)
        SELECT 'local-user', 'POST', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM run_steering WHERE id = ?)` , params: [idempotencyRoute, idempotency.key, idempotency.bodyHash, responseBody, new Date(Date.now() + 86_400_000).toISOString(), steeringId] });
      try {
        await this.events.transactConditional('run.steering_received', run.id, projectId, { runId: run.id, steeringId, messageId, sequence, targetTaskId: targetTaskId ?? null }, operations);
      } catch (error) {
        if ((error as { code?: string }).code === 'REVISION_CONFLICT') throw Object.assign(new Error('Run đã thay đổi trước khi lệnh điều hướng được lưu; hãy tải lại rồi thử lại.'), { status: 409, code: options.expectedVersion === undefined ? 'RUN_NOT_STEERABLE' : 'RUN_VERSION_CONFLICT' });
        throw error;
      }
      const message = (await this.listMessages(conversationId, 200)).find((item) => item.id === messageId);
      if (!message) throw new Error('Không đọc lại được lệnh điều hướng vừa tạo.');
      return { message, runId: run.id, steeringId, sequence };
    });
  }

  private async serializeConversation<T>(conversationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.messageGuards.get(conversationId);
    let release!: () => void;
    const guard = new Promise<void>((resolve) => { release = resolve; });
    this.messageGuards.set(conversationId, guard);
    if (previous) await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.messageGuards.get(conversationId) === guard) this.messageGuards.delete(conversationId);
    }
  }

  private async createUserMessageRecord(projectId: string, conversationId: string, text: string, idempotency: { key: string; bodyHash: string } | undefined, mode: 'new-run' | 'enqueue', attachments: MessageAttachmentInput[]): Promise<{ message: Message; runId: string }> {
    const project = await this.getProject(projectId);
    if (!project || project.status !== 'active' || project.conversationId !== conversationId) throw Object.assign(new Error('Project hoặc conversation không tồn tại.'), { status: 404, code: 'PROJECT_NOT_FOUND' });
    if (idempotency) {
      const prior = await this.db.one<{ body_hash: string; response_json: string }>("SELECT body_hash, response_json FROM idempotency_keys WHERE actor_id = 'local-user' AND method = 'POST' AND route = ? AND key = ?", [`/conversations/${conversationId}/messages`, idempotency.key]);
      if (prior) {
        if (prior.body_hash !== idempotency.bodyHash) throw Object.assign(new Error('Idempotency-Key đã được dùng với nội dung khác.'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
        const value = JSON.parse(prior.response_json) as { messageId: string; runId: string };
        const saved = (await this.listMessages(conversationId, 200)).find((message) => message.id === value.messageId);
        if (saved) return { message: saved, runId: value.runId };
      }
    }
    const waitingForInput = await this.db.one<{ id: string }>(`SELECT r.id FROM runs r JOIN messages m ON m.id = r.request_message_id
      WHERE r.conversation_id = ? AND r.status = 'waiting_approval' AND r.error_code = 'WAITING_FOR_USER_INPUT'
      ORDER BY m.sequence LIMIT 1`, [conversationId]);
    if (mode === 'new-run') {
      const active = await this.db.one<{ id: string }>(`SELECT id FROM runs WHERE conversation_id = ? AND status IN ${STALE_RUN_STATES}
        AND (? IS NULL OR id <> ?) LIMIT 1`, [conversationId, waitingForInput?.id ?? null, waitingForInput?.id ?? null]);
      if (active) throw Object.assign(new Error('Đã có lượt chạy trong hội thoại này. Hãy xếp tin nhắn vào hàng đợi.'), { status: 409, code: 'RUN_ALREADY_ACTIVE' });
    }
    const messageId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const operations: DbOperation[] = [
      ...(waitingForInput ? [{ mode: 'run' as const, sql: "UPDATE runs SET status = 'succeeded', error_code = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'waiting_approval' AND error_code = 'WAITING_FOR_USER_INPUT'", params: [now, waitingForInput.id] }] : []),
      { mode: 'run', sql: `INSERT INTO messages(id, conversation_id, run_id, sequence, speaker, content, status, created_at)
        SELECT ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, 'user', ?, 'completed', ? FROM messages WHERE conversation_id = ?`, params: [messageId, conversationId, runId, text, now, conversationId] },
      ...this.attachmentOperations(messageId, attachments, now),
      { mode: 'run', sql: "INSERT INTO runs(id, conversation_id, project_id, status, request_message_id, token_budget, money_budget_microusd, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)", params: [runId, conversationId, projectId, messageId, this.registry.policy.limits.maxTokensPerRun, this.registry.policy.limits.moneyBudgetUsd === null ? null : Math.floor(this.registry.policy.limits.moneyBudgetUsd * 1_000_000), now, now] },
    ];
    if (idempotency) operations.push({ mode: 'run', sql: `INSERT INTO idempotency_keys(actor_id, method, route, key, body_hash, response_json, expires_at)
      VALUES ('local-user', 'POST', ?, ?, ?, ?, ?)`, params: [`/conversations/${conversationId}/messages`, idempotency.key, idempotency.bodyHash, JSON.stringify({ messageId, runId }), new Date(Date.now() + 86_400_000).toISOString()] });
    await this.events.transact(waitingForInput ? 'run.input_received' : 'run.created', runId, projectId, { runId, conversationId, messageId, ...(waitingForInput ? { resolvedInputRunId: waitingForInput.id } : {}) }, operations);
    const message = (await this.listMessages(conversationId, 200)).find((item) => item.id === messageId);
    if (!message) throw new Error('Không đọc lại được message vừa tạo.');
    return { message, runId };
  }

  async createAssistantMessage(conversationId: string, runId: string, agentId: string, speaker: 'coordinator' | 'specialist', content: string, status: Message['status'] = 'completed'): Promise<Message> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.events.transact('message.completed', id, null, { messageId: id, runId, agentInstanceId: agentId }, [
      { mode: 'run', sql: `INSERT INTO messages(id, conversation_id, run_id, sequence, speaker, agent_instance_id, content, status, created_at)
        SELECT ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ? FROM messages WHERE conversation_id = ?`, params: [id, conversationId, runId, speaker, agentId, content, status, now, conversationId] },
    ]);
    return { id, conversationId, runId, speaker, agentInstanceId: agentId, content, status, createdAt: now };
  }

  async finalizeRunWithAssistantMessage(input: FinalRunMessageInput): Promise<Message> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const messageStatus = input.messageStatus ?? (input.status === 'failed' ? 'failed' : 'completed');
    await this.events.transactConditional('run.status_changed', input.runId, input.projectId, {
      runId: input.runId, status: input.status, errorCode: input.errorCode, messageId: id, agentInstanceId: input.agentId,
    }, [
      { mode: 'run', sql: `UPDATE runs SET status = ?, error_code = ?, pause_requested = 0, pause_reason = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND project_id = ? AND conversation_id = ? AND status IN ('planning','executing') AND error_code = 'FINALIZING'`,
      params: [input.status, input.errorCode, now, input.runId, input.projectId, input.conversationId] },
      { mode: 'run', sql: `INSERT INTO messages(id, conversation_id, run_id, sequence, speaker, agent_instance_id, content, status, created_at)
        SELECT ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, 'coordinator', ?, ?, ?, ? FROM messages WHERE conversation_id = ?`,
      params: [id, input.conversationId, input.runId, input.agentId, input.content, messageStatus, now, input.conversationId] },
      { mode: 'run', sql: `UPDATE run_steering SET status = 'acknowledged', acknowledged_at = ? WHERE run_id = ? AND status = 'pending'`,
      params: [now, input.runId] },
    ]);
    return {
      id, conversationId: input.conversationId, runId: input.runId, speaker: 'coordinator',
      agentInstanceId: input.agentId, content: input.content, status: messageStatus, createdAt: now,
    };
  }

  async updateRun(runId: string, status: string, errorCode: string | null = null): Promise<void> {
    const row = await this.db.one<{ project_id: string }>('SELECT project_id FROM runs WHERE id = ?', [runId]);
    if (!row) return;
    const now = new Date().toISOString();
    await this.events.transact('run.status_changed', runId, row.project_id, { runId, status, errorCode }, [
      { mode: 'run', sql: "UPDATE runs SET status = ?, error_code = ?, pause_requested = CASE WHEN ? IN ('succeeded','failed','cancelled','interrupted','waiting_approval') THEN 0 ELSE pause_requested END, pause_reason = CASE WHEN ? IN ('succeeded','failed','cancelled','interrupted','waiting_approval') THEN NULL ELSE pause_reason END, version = version + 1, updated_at = ? WHERE id = ?", params: [status, errorCode, status, status, now, runId] },
    ]);
  }

  async getTasks(runId: string): Promise<Task[]> {
    const rows = await this.db.all<TaskRow>('SELECT id, run_id, task_key, title, objective, required_capabilities_json, status, assigned_agent_id, output, created_at, updated_at FROM tasks WHERE run_id = ? ORDER BY created_at, task_key', [runId]);
    const deps = await this.db.all<{ task_id: string; depends_on_task_id: string }>('SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)', [runId]);
    const byTask = new Map<string, string[]>();
    for (const dep of deps) byTask.set(dep.task_id, [...(byTask.get(dep.task_id) ?? []), dep.depends_on_task_id]);
    return rows.map((row) => taskSchema.parse({
      id: row.id, runId: row.run_id, key: row.task_key, title: row.title, objective: row.objective,
      requiredCapabilities: JSON.parse(row.required_capabilities_json), dependencies: byTask.get(row.id) ?? [],
      status: row.status, assignedAgentId: row.assigned_agent_id, output: row.output,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  async runForMessage(runId: string): Promise<{ id: string; projectId: string; conversationId: string; request: string; requestMessageId: string; requestSequence: number; status: string; version: number; coordinatorId: string } | null> {
    const row = await this.db.one<{ id: string; project_id: string; conversation_id: string; content: string; request_message_id: string; request_sequence: number; status: string; version: number; coordinator_id: string }>(`SELECT r.id, r.project_id, r.conversation_id, r.status, r.version, m.id AS request_message_id, m.content, m.sequence AS request_sequence,
      b.instance_id AS coordinator_id FROM runs r JOIN messages m ON m.id = r.request_message_id
      JOIN coordinator_bindings b ON b.project_id = r.project_id WHERE r.id = ?`, [runId]);
    return row ? { id: row.id, projectId: row.project_id, conversationId: row.conversation_id, request: row.content, requestMessageId: row.request_message_id, requestSequence: row.request_sequence, status: row.status, version: row.version, coordinatorId: row.coordinator_id } : null;
  }

  private attachmentOperations(messageId: string, inputs: MessageAttachmentInput[], createdAt: string): DbOperation[] {
    const attachments = validateMessageAttachments(inputs);
    return attachments.map((attachment, ordinal) => ({
      mode: 'run',
      sql: `INSERT INTO message_attachments(id, message_id, ordinal, name, mime_type, size_bytes, checksum, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [randomUUID(), messageId, ordinal, attachment.name, attachment.mimeType, attachment.sizeBytes, attachment.checksum, attachment.content, createdAt],
    }));
  }

  async hasEarlierActiveRun(conversationId: string, requestSequence: number): Promise<boolean> {
    const earlier = await this.db.one<{ id: string }>(`SELECT prior.id FROM runs prior
      JOIN messages prior_request ON prior_request.id = prior.request_message_id
      WHERE prior.conversation_id = ? AND prior_request.sequence < ? AND prior.status IN ${STALE_RUN_STATES} LIMIT 1`, [conversationId, requestSequence]);
    return !!earlier;
  }

  async projectContext(projectId: string, throughSequence?: number): Promise<{ project: Project; workspaceRoot: string | null; history: Message[] } | null> {
    const project = await this.getProject(projectId);
    if (!project) return null;
    const row = await this.db.one<{ workspace_root: string | null }>('SELECT workspace_root FROM projects WHERE id = ?', [projectId]);
    const history = await this.listMessages(project.conversationId, 40, throughSequence);
    return { project, workspaceRoot: row?.workspace_root ?? null, history };
  }

  async enabledSpecialists(): Promise<Agent[]> {
    const snapshot = await this.officeSnapshot();
    return snapshot.agents.filter((agent) => agent.role === 'specialist' && agent.availability === 'ready');
  }

  async setSpecialistDraining(agentId: string, draining: boolean): Promise<void> {
    const current = await this.db.one<{ role: string; enabled: number; draining: number }>('SELECT role, enabled, draining FROM agent_instances WHERE id = ?', [agentId]);
    if (!current || current.role !== 'specialist' || !current.enabled) throw Object.assign(new Error('Không tìm thấy specialist đang hoạt động.'), { status: 404, code: 'AGENT_NOT_FOUND' });
    if (Boolean(current.draining) === draining) return;
    await this.events.transactConditional(draining ? 'agent.draining' : 'agent.resumed', agentId, null, { agentInstanceId: agentId, draining }, [
      { mode: 'run', sql: 'UPDATE agent_instances SET draining = ? WHERE id = ? AND role = \'specialist\' AND enabled = 1 AND draining = ?', params: [draining ? 1 : 0, agentId, current.draining] },
    ]);
  }

  async currentAgentInstances(): Promise<Array<{ id: string; definitionId: string; displayName: string; definitionVersion: string }>> {
    return this.db.all('SELECT id, definition_id AS definitionId, display_name AS displayName, definition_version AS definitionVersion FROM agent_instances WHERE role = \'specialist\' AND enabled = 1');
  }
}

export function hashBody(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function validateMessageAttachments(inputs: MessageAttachmentInput[]): Array<Pick<MessageAttachmentContent, 'name' | 'mimeType' | 'sizeBytes' | 'checksum' | 'content'>> {
  if (inputs.length > 5) throw Object.assign(new Error('Tối đa 5 tệp cho mỗi tin nhắn.'), { status: 400, code: 'TOO_MANY_ATTACHMENTS' });
  let totalBytes = 0;
  return inputs.map((input) => {
    const rawName = input.name.trim().replace(/\\/g, '/').split('/').at(-1) ?? '';
    const name = rawName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').slice(0, 120);
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
    const expectedMime: Record<string, MessageAttachment['mimeType']> = {
      '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
    };
    if (!name || !expectedMime[extension] || input.mimeType !== expectedMime[extension]) {
      throw Object.assign(new Error('Chỉ hỗ trợ tệp .txt, .md, .csv và .json.'), { status: 415, code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    }
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');
    if (sizeBytes > 65_536) throw Object.assign(new Error('Mỗi tệp đính kèm không được vượt quá 64 KB.'), { status: 413, code: 'ATTACHMENT_TOO_LARGE' });
    totalBytes += sizeBytes;
    if (totalBytes > 160_000) throw Object.assign(new Error('Tổng tệp đính kèm không được vượt quá 160 KB.'), { status: 413, code: 'ATTACHMENTS_TOO_LARGE' });
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.content)) {
      throw Object.assign(new Error('Tệp đính kèm phải là văn bản UTF-8 hợp lệ.'), { status: 400, code: 'ATTACHMENT_NOT_TEXT' });
    }
    return { name, mimeType: input.mimeType, sizeBytes, checksum: createHash('sha256').update(input.content, 'utf8').digest('hex'), content: input.content };
  });
}

function seedFrom(value: string): number { return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) & 0x7fffffff; }

import { createHash, randomUUID } from 'node:crypto';
import type { MemoryRecord, MemoryScopeType, ProjectMemoryRecord } from '../../shared/platform/contracts';
import type { DatabaseClient, DbOperation } from './database';
import { EventHub } from './events';
import { z } from 'zod';

const WORKSPACE_ID = 'local-workspace';
const MAX_MEMORY_BYTES = 8_000;
const MAX_SEARCH_RESULTS = 8;
const MAX_CONTEXT_BYTES = 16_000;
const MAX_MEMORY_EXPORT_RECORDS = 2_000;
const MAX_MEMORY_EXPORT_REVISIONS = 20_000;
const MAX_MEMORY_BUNDLE_BYTES = 10_000_000;
const MAX_PROJECT_MARKDOWN_RECORDS = 2_000;
const MAX_PROJECT_MARKDOWN_BYTES = 20_000_000;

const memoryRevisionSchema = z.object({
  revision: z.number().int().min(1).max(MAX_MEMORY_EXPORT_REVISIONS),
  status: z.enum(['proposed', 'accepted', 'rejected']),
  content: z.string().max(MAX_MEMORY_BYTES),
  sourceType: z.string().min(1).max(80),
  sourceRef: z.string().max(500).nullable(),
  sourceVersion: z.string().max(160).nullable(),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  createdBy: z.string().min(1).max(160),
  confidenceLabel: z.string().min(1).max(80),
  expiresAt: z.string().datetime().nullable(),
  reason: z.string().min(1).max(120),
  createdAt: z.string().datetime(),
}).strict();

const memoryExportRecordSchema = z.object({
  id: z.string().uuid(),
  scopeType: z.enum(['user', 'agent', 'project']),
  scopeId: z.string().min(1).max(160),
  projectId: z.string().max(160).nullable(),
  content: z.string().max(MAX_MEMORY_BYTES),
  sourceType: z.string().min(1).max(80),
  sourceRef: z.string().max(500).nullable(),
  sourceVersion: z.string().max(160).nullable(),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  createdBy: z.string().min(1).max(160),
  confidenceLabel: z.string().min(1).max(80),
  expiresAt: z.string().datetime().nullable(),
  status: z.enum(['proposed', 'accepted', 'rejected']),
  revision: z.number().int().min(1).max(MAX_MEMORY_EXPORT_REVISIONS),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revisions: z.array(memoryRevisionSchema).min(1).max(MAX_MEMORY_EXPORT_REVISIONS),
}).strict();

const memoryExportBundleSchema = z.object({
  format: z.literal('agent-office.memory-export'),
  schemaVersion: z.literal(1),
  exportId: z.string().uuid(),
  exportedAt: z.string().datetime(),
  records: z.array(memoryExportRecordSchema).max(MAX_MEMORY_EXPORT_RECORDS),
}).strict();

const projectMarkdownRecordMetadataSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().min(1),
  status: z.enum(['proposed', 'accepted', 'rejected']),
  sourceType: z.string().min(1).max(80),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type MemoryExportRevision = z.infer<typeof memoryRevisionSchema>;
type MemoryExportRecord = z.infer<typeof memoryExportRecordSchema>;
export type MemoryExportBundle = z.infer<typeof memoryExportBundleSchema>;

export interface ProjectMemoryMarkdownChange {
  id: string;
  revision: number;
  nextRevision: number;
  before: string;
  after: string;
}

export interface ProjectMemoryMarkdownPreview {
  projectId: string;
  expectedRevision: string;
  recordCount: number;
  changedCount: number;
  changes: ProjectMemoryMarkdownChange[];
}

interface MemoryRevisionRow {
  memory_id: string; revision: number; status: MemoryExportRevision['status']; content: string; source_type: string;
  source_ref: string | null; source_version: string | null; source_checksum: string | null; created_by: string;
  confidence_label: string; expires_at: string | null; reason: string; created_at: string;
}

interface MemoryRow {
  id: string; project_id: string | null; scope_type: MemoryScopeType; scope_id: string; content: string; source_type: string; source_ref: string | null;
  source_version: string | null; source_checksum: string | null; created_by: string; confidence_label: string; expires_at?: string | null;
  status: ProjectMemoryRecord['status'] | 'deleted'; revision: number; created_at: string; updated_at: string;
}

export interface ScopedMemoryHit {
  id: string;
  scopeType: 'user' | 'agent' | 'project' | 'run';
  content: string;
  sourceType: string;
  sourceRef: string | null;
  confidenceLabel: string;
  revision: number;
  updatedAt: string;
}

export class MemoryService {
  constructor(private readonly db: DatabaseClient, private readonly events: EventHub) {}

  async listProject(projectId: string): Promise<ProjectMemoryRecord[]> {
    const rows = await this.db.all<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, status, revision, created_at, updated_at FROM memory_records
      WHERE workspace_id = ? AND scope_type = 'project' AND scope_id = ? AND project_id = ? AND status <> 'deleted'
      ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, updated_at DESC LIMIT 200`,
    [WORKSPACE_ID, projectId, projectId]);
    return rows.map(toProjectRecord);
  }

  async exportProjectMarkdown(projectId: string): Promise<{ revision: string; markdown: string }> {
    const rows = await this.projectMarkdownRows(projectId);
    const revision = projectMemoryRevision(projectId, rows);
    const records = rows.map((row) => {
      const metadata = Buffer.from(JSON.stringify({ id: row.id, revision: row.revision, status: row.status, sourceType: row.source_type, checksum: hash(row.content) }), 'utf8').toString('base64url');
      return `<!-- agent-office-memory-record:v1 ${metadata} -->\n${escapeMemoryMarkdownContent(row.content)}\n<!-- /agent-office-memory-record -->`;
    });
    const markdown = [`<!-- agent-office-memory:v1 project=${Buffer.from(projectId, 'utf8').toString('base64url')} revision=${revision} -->`, '# Project memory', ...records].join('\n\n') + '\n';
    if (Buffer.byteLength(markdown, 'utf8') > MAX_PROJECT_MARKDOWN_BYTES) throw memoryMarkdownTooLarge();
    return { revision, markdown };
  }

  async previewProjectMarkdown(projectId: string, markdown: string): Promise<ProjectMemoryMarkdownPreview> {
    const parsed = parseProjectMemoryMarkdown(projectId, markdown);
    const rows = await this.projectMarkdownRows(projectId);
    const currentRevision = projectMemoryRevision(projectId, rows);
    if (parsed.revision !== currentRevision) throw memoryMarkdownConflict();
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (parsed.records.length !== rows.length) throw invalidMemoryMarkdown('Không được thêm hoặc bỏ ghi chú trong memory.md; hãy dùng các thao tác ghi nhớ trong project.');

    const changes: ProjectMemoryMarkdownChange[] = [];
    for (const candidate of parsed.records) {
      const current = byId.get(candidate.id);
      if (!current) throw invalidMemoryMarkdown('memory.md chứa ghi chú không thuộc project này.');
      if (candidate.revision !== current.revision || candidate.status !== current.status || candidate.sourceType !== current.source_type || candidate.checksum !== hash(current.content)) {
        throw memoryMarkdownConflict();
      }
      const normalized = validateContent(candidate.content);
      if (normalized === current.content) continue;
      if (current.status !== 'accepted' || current.source_type !== 'owner_note') {
        throw Object.assign(new Error('Chỉ ghi chú do bạn tạo và đã chấp nhận mới được sửa trong memory.md.'), { status: 409, code: 'MEMORY_NOT_EDITABLE' });
      }
      changes.push({ id: current.id, revision: current.revision, nextRevision: current.revision + 1, before: current.content.slice(0, 240), after: normalized.slice(0, 240) });
    }
    return { projectId, expectedRevision: currentRevision, recordCount: rows.length, changedCount: changes.length, changes };
  }

  async importProjectMarkdown(projectId: string, expectedRevision: string, markdown: string): Promise<ProjectMemoryMarkdownPreview> {
    const preview = await this.previewProjectMarkdown(projectId, markdown);
    if (preview.expectedRevision !== expectedRevision) throw memoryMarkdownConflict();
    if (!preview.changedCount) return preview;

    const parsed = parseProjectMemoryMarkdown(projectId, markdown);
    const rows = await this.projectMarkdownRows(projectId);
    if (projectMemoryRevision(projectId, rows) !== expectedRevision) throw memoryMarkdownConflict();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const candidates = new Map(parsed.records.map((record) => [record.id, record]));
    const changes = preview.changes;
    const now = new Date().toISOString();
    const rowsGuard = rows.map((row) => `(id = ? AND revision = ? AND status = ? AND source_type = ? AND source_ref IS ? AND content = ? AND updated_at = ?)` ).join(' OR ');
    const guardParams = rows.flatMap((row) => [row.id, row.revision, row.status, row.source_type, row.source_ref, row.content, row.updated_at]);
    const operations: DbOperation[] = [{ mode: 'run', sql: `UPDATE projects SET updated_at = updated_at WHERE id = ? AND workspace_id = ?
      AND (SELECT COUNT(*) FROM memory_records WHERE workspace_id = ? AND project_id = ? AND scope_type = 'project' AND status <> 'deleted') = ?
      AND NOT EXISTS (SELECT 1 FROM memory_records WHERE workspace_id = ? AND project_id = ? AND scope_type = 'project' AND status <> 'deleted' AND NOT (${rowsGuard || '0'}))`,
    params: [projectId, WORKSPACE_ID, WORKSPACE_ID, projectId, rows.length, WORKSPACE_ID, projectId, ...guardParams] }];
    for (const change of changes) {
      const current = byId.get(change.id)!;
      const candidate = candidates.get(change.id)!;
      const content = validateContent(candidate.content);
      const checksum = hash(content);
      operations.push({ mode: 'run', sql: `UPDATE memory_records SET content = ?, source_checksum = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND project_id = ? AND scope_type = 'project' AND status = 'accepted' AND source_type = 'owner_note' AND revision = ? AND content = ?`,
      params: [content, checksum, now, current.id, WORKSPACE_ID, projectId, current.revision, current.content] });
      operations.push({ mode: 'run', sql: `INSERT INTO memory_record_revisions(id, memory_id, revision, status, content, source_type, source_ref, source_version,
        source_checksum, created_by, confidence_label, expires_at, reason, created_at)
        SELECT ?, id, revision, status, content, source_type, source_ref, source_version, source_checksum, created_by, confidence_label, expires_at, 'owner_markdown_import', ?
        FROM memory_records WHERE id = ? AND revision = ? AND changes() > 0`,
      params: [randomUUID(), now, current.id, current.revision + 1] });
    }
    await this.events.transactConditional('memory.markdown_imported', projectId, projectId,
      { projectId, changedCount: changes.length, memoryIds: changes.map((change) => change.id), revisions: changes.map((change) => change.nextRevision) }, operations);
    return preview;
  }

  private async projectMarkdownRows(projectId: string): Promise<MemoryRow[]> {
    const project = await this.db.one<{ id: string }>("SELECT id FROM projects WHERE id = ? AND workspace_id = ?", [projectId, WORKSPACE_ID]);
    if (!project) throw Object.assign(new Error('Không tìm thấy project.'), { status: 404, code: 'PROJECT_NOT_FOUND' });
    const rows = await this.db.all<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, expires_at, status, revision, created_at, updated_at FROM memory_records
      WHERE workspace_id = ? AND scope_type = 'project' AND scope_id = ? AND project_id = ? AND status <> 'deleted' ORDER BY id LIMIT ?`,
    [WORKSPACE_ID, projectId, projectId, MAX_PROJECT_MARKDOWN_RECORDS + 1]);
    if (rows.length > MAX_PROJECT_MARKDOWN_RECORDS) throw memoryMarkdownTooLarge();
    return rows;
  }

  async listForProject(projectId: string, agentDefinitionIds: readonly string[]): Promise<MemoryRecord[]> {
    const agents = [...new Set(agentDefinitionIds)].filter((id) => /^[a-z][a-z0-9-]{0,63}$/.test(id));
    const agentClause = agents.length ? `OR (scope_type = 'agent' AND scope_id IN (${agents.map(() => '?').join(',')}) AND project_id IS NULL)` : '';
    const rows = await this.db.all<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, status, revision, created_at, updated_at FROM memory_records
      WHERE workspace_id = ? AND status <> 'deleted' AND (
        (scope_type = 'project' AND scope_id = ? AND project_id = ?) OR
        (scope_type = 'user' AND scope_id = 'local-user' AND project_id IS NULL) ${agentClause}
      ) ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, updated_at DESC LIMIT 300`,
    [WORKSPACE_ID, projectId, projectId, ...agents]);
    return rows.map(toRecord);
  }

  async addProjectNote(projectId: string, content: string): Promise<ProjectMemoryRecord> {
    const normalized = validateContent(content);
    const project = await this.db.one<{ id: string }>("SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND status = 'active'", [projectId, WORKSPACE_ID]);
    if (!project) throw Object.assign(new Error('Không tìm thấy project đang hoạt động.'), { status: 404, code: 'PROJECT_NOT_FOUND' });
    const id = randomUUID();
    const now = new Date().toISOString();
    const checksum = hash(normalized);
    const operations: DbOperation[] = [
      { mode: 'run', sql: `INSERT INTO memory_records(id, workspace_id, project_id, scope_type, scope_id, content, source_type, source_ref,
        source_version, source_checksum, created_by, confidence_label, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'project', ?, ?, 'owner_note', NULL, NULL, ?, 'local-user', 'owner_confirmed', 'accepted', 1, ?, ?)`,
      params: [id, WORKSPACE_ID, projectId, projectId, normalized, checksum, now, now] },
      this.insertRevision(id, 1, 'accepted', normalized, 'owner_note', null, null, checksum, 'local-user', 'owner_confirmed', null, 'owner_created', now),
    ];
    await this.events.transact('memory.created', id, projectId, { memoryId: id, projectId, status: 'accepted', revision: 1 }, operations);
    return this.get(id);
  }

  async addOwnerNote(scopeType: 'user' | 'agent', scopeId: string, content: string): Promise<MemoryRecord> {
    if (scopeType === 'user' && scopeId !== 'local-user' || scopeType === 'agent' && !/^[a-z][a-z0-9-]{0,63}$/.test(scopeId)) {
      throw Object.assign(new Error('Phạm vi ghi nhớ không hợp lệ.'), { status: 400, code: 'INVALID_MEMORY_SCOPE' });
    }
    const normalized = validateContent(content);
    const id = randomUUID();
    const now = new Date().toISOString();
    const checksum = hash(normalized);
    await this.events.transact('memory.created', id, null, { memoryId: id, scopeType, scopeId, status: 'accepted', revision: 1 }, [
      { mode: 'run', sql: `INSERT INTO memory_records(id, workspace_id, project_id, scope_type, scope_id, content, source_type, source_ref,
        source_version, source_checksum, created_by, confidence_label, status, revision, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, 'owner_note', NULL, NULL, ?, 'local-user', 'owner_confirmed', 'accepted', 1, ?, ?)`,
      params: [id, WORKSPACE_ID, scopeType, scopeId, normalized, checksum, now, now] },
      this.insertRevision(id, 1, 'accepted', normalized, 'owner_note', null, null, checksum, 'local-user', 'owner_confirmed', null, 'owner_created', now),
    ]);
    return this.getAny(id);
  }

  async proposeProjectMemory(input: { projectId: string; runId: string; taskId: string; agentInstanceId: string; content: string }): Promise<ProjectMemoryRecord> {
    const normalized = validateContent(input.content);
    const task = await this.db.one<{ id: string }>(`SELECT t.id FROM tasks t JOIN runs r ON r.id = t.run_id
      WHERE t.id = ? AND r.id = ? AND r.project_id = ?`, [input.taskId, input.runId, input.projectId]);
    if (!task) throw Object.assign(new Error('Nguồn nhiệm vụ không thuộc project này.'), { status: 409, code: 'MEMORY_SOURCE_MISMATCH' });
    const id = randomUUID();
    const now = new Date().toISOString();
    const checksum = hash(normalized);
    const sourceRef = `task:${input.taskId}`;
    const operations: DbOperation[] = [
      { mode: 'run', sql: `INSERT INTO memory_records(id, workspace_id, project_id, scope_type, scope_id, content, source_type, source_ref,
        source_version, source_checksum, created_by, confidence_label, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'project', ?, ?, 'agent_proposal', ?, ?, ?, ?, 'unverified', 'proposed', 1, ?, ?)`,
      params: [id, WORKSPACE_ID, input.projectId, input.projectId, normalized, sourceRef, input.runId, checksum, input.agentInstanceId, now, now] },
      this.insertRevision(id, 1, 'proposed', normalized, 'agent_proposal', sourceRef, input.runId, checksum, input.agentInstanceId, 'unverified', null, 'agent_proposed', now),
    ];
    await this.events.transact('memory.proposed', id, input.projectId, { memoryId: id, projectId: input.projectId, createdBy: input.agentInstanceId, status: 'proposed', revision: 1 }, operations);
    return this.get(id);
  }

  async proposeRunSummary(input: { projectId: string; runId: string; coordinatorInstanceId: string; content: string }, signal?: AbortSignal): Promise<ProjectMemoryRecord> {
    const normalized = validateContent(input.content);
    if (signal?.aborted) throw Object.assign(new Error('Hook bị hủy trước khi lưu summary.'), { code: 'HOOK_ABORTED' });
    const existing = await this.db.one<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, expires_at, status, revision, created_at, updated_at FROM memory_records
      WHERE workspace_id = ? AND scope_type = 'project' AND scope_id = ? AND source_type = 'hook_summary' AND source_ref = ?`,
    [WORKSPACE_ID, input.projectId, `run:${input.runId}`]);
    if (existing) return toProjectRecord(existing);
    if (signal?.aborted) throw Object.assign(new Error('Hook bị hủy trước khi lưu summary.'), { code: 'HOOK_ABORTED' });
    const id = randomUUID();
    const now = new Date().toISOString();
    const checksum = hash(normalized);
    const sourceRef = `run:${input.runId}`;
    const operations: DbOperation[] = [
      { mode: 'run', sql: `INSERT INTO memory_records(id, workspace_id, project_id, scope_type, scope_id, content, source_type, source_ref,
        source_version, source_checksum, created_by, confidence_label, status, revision, created_at, updated_at)
        SELECT ?, ?, r.project_id, 'project', r.project_id, ?, 'hook_summary', ?, ?, ?, ?, 'unverified', 'proposed', 1, ?, ?
        FROM runs r JOIN coordinator_bindings b ON b.project_id = r.project_id
        WHERE r.id = ? AND r.project_id = ? AND b.instance_id = ? AND r.status IN ('executing','succeeded')
          AND NOT EXISTS (SELECT 1 FROM memory_records m WHERE m.workspace_id = ? AND m.scope_type = 'project' AND m.scope_id = r.project_id AND m.source_type = 'hook_summary' AND m.source_ref = ?)` ,
      params: [id, WORKSPACE_ID, normalized, sourceRef, input.runId, checksum, input.coordinatorInstanceId, now, now,
        input.runId, input.projectId, input.coordinatorInstanceId, WORKSPACE_ID, sourceRef] },
      { mode: 'run', sql: `INSERT INTO memory_record_revisions(id, memory_id, revision, status, content, source_type, source_ref, source_version,
        source_checksum, created_by, confidence_label, expires_at, reason, created_at)
        SELECT ?, id, 1, status, content, source_type, source_ref, source_version, source_checksum, created_by, confidence_label, expires_at, 'run_summary_proposed', ?
        FROM memory_records WHERE id = ? AND changes() > 0`, params: [randomUUID(), now, id] },
    ];
    try {
      await this.events.transactConditional('memory.proposed', id, input.projectId,
        { memoryId: id, projectId: input.projectId, sourceRef, sourceType: 'hook_summary', createdBy: input.coordinatorInstanceId, status: 'proposed', revision: 1 }, operations);
    } catch (error) {
      if ((error as { code?: string }).code === 'REVISION_CONFLICT') {
        const duplicate = await this.db.one<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
          created_by, confidence_label, expires_at, status, revision, created_at, updated_at FROM memory_records
          WHERE workspace_id = ? AND scope_type = 'project' AND scope_id = ? AND source_type = 'hook_summary' AND source_ref = ?`,
        [WORKSPACE_ID, input.projectId, sourceRef]);
        if (duplicate) return toProjectRecord(duplicate);
      }
      throw error;
    }
    return this.get(id);
  }

  async addRunNote(input: { projectId: string; runId: string; taskId: string; agentInstanceId: string; content: string }): Promise<{ id: string; content: string; revision: number }> {
    const normalized = validateContent(input.content);
    const task = await this.db.one<{ id: string }>(`SELECT t.id FROM tasks t JOIN runs r ON r.id = t.run_id
      WHERE t.id = ? AND r.id = ? AND r.project_id = ? AND r.status IN ('planning','executing','waiting_approval','paused')`, [input.taskId, input.runId, input.projectId]);
    if (!task) throw Object.assign(new Error('Nguồn ghi nhớ không thuộc run đang hoạt động.'), { status: 409, code: 'MEMORY_SOURCE_MISMATCH' });
    const id = randomUUID();
    const now = new Date().toISOString();
    const checksum = hash(normalized);
    const sourceRef = `task:${input.taskId}`;
    await this.events.transact('memory.run_created', id, input.projectId, { memoryId: id, runId: input.runId, taskId: input.taskId }, [
      { mode: 'run', sql: `INSERT INTO memory_records(id, workspace_id, project_id, scope_type, scope_id, content, source_type, source_ref,
        source_version, source_checksum, created_by, confidence_label, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'run', ?, ?, 'run_scratch', ?, ?, ?, ?, 'run_scoped', 'accepted', 1, ?, ?)`,
      params: [id, WORKSPACE_ID, input.projectId, input.runId, normalized, sourceRef, input.runId, checksum, input.agentInstanceId, now, now] },
      this.insertRevision(id, 1, 'accepted', normalized, 'run_scratch', sourceRef, input.runId, checksum, input.agentInstanceId, 'run_scoped', null, 'agent_created_run_note', now),
    ]);
    return { id, content: normalized, revision: 1 };
  }

  async decideProposal(id: string, expectedRevision: number, decision: 'accept' | 'reject'): Promise<ProjectMemoryRecord> {
    const current = await this.requireProjectRecord(id);
    if (current.status !== 'proposed') throw Object.assign(new Error('Ghi nhớ này không còn chờ xem xét.'), { status: 409, code: 'MEMORY_NOT_PROPOSED' });
    const now = new Date().toISOString();
    const status = decision === 'accept' ? 'accepted' : 'rejected';
    const operations: DbOperation[] = [
      { mode: 'run', sql: `UPDATE memory_records SET status = ?, confidence_label = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND scope_type = 'project' AND status = 'proposed' AND revision = ?`,
      params: [status, decision === 'accept' ? 'owner_accepted' : 'owner_rejected', now, id, WORKSPACE_ID, expectedRevision] },
      { mode: 'run', sql: `INSERT INTO memory_record_revisions(id, memory_id, revision, status, content, source_type, source_ref, source_version,
        source_checksum, created_by, confidence_label, expires_at, reason, created_at)
        SELECT ?, id, revision, status, content, source_type, source_ref, source_version, source_checksum, created_by, confidence_label, expires_at, ?, ?
        FROM memory_records WHERE id = ? AND revision = ? AND changes() > 0`,
      params: [randomUUID(), `owner_${decision}`, now, id, expectedRevision + 1] },
    ];
    await this.events.transactConditional(`memory.${decision === 'accept' ? 'accepted' : 'rejected'}`, id, current.project_id,
      { memoryId: id, projectId: current.project_id, status, revision: expectedRevision + 1 }, operations);
    return this.get(id);
  }

  async updateProjectNote(id: string, expectedRevision: number, content: string): Promise<ProjectMemoryRecord> {
    const updated = await this.updateOwnerNote(id, expectedRevision, content);
    if (updated.scopeType !== 'project' || !updated.projectId) throw new Error('Project memory record is missing its project scope.');
    return { ...updated, scopeType: 'project', projectId: updated.projectId };
  }

  async updateOwnerNote(id: string, expectedRevision: number, content: string): Promise<MemoryRecord> {
    const normalized = validateContent(content);
    const current = await this.requireRecord(id);
    if (current.source_type !== 'owner_note' || current.status !== 'accepted') throw Object.assign(new Error('Chỉ ghi chú do bạn tạo mới được sửa trực tiếp.'), { status: 409, code: 'MEMORY_NOT_EDITABLE' });
    const now = new Date().toISOString();
    const checksum = hash(normalized);
    const operations: DbOperation[] = [
      { mode: 'run', sql: `UPDATE memory_records SET content = ?, source_checksum = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND scope_type = ? AND scope_id = ? AND project_id IS ? AND status = 'accepted' AND source_type = 'owner_note' AND revision = ?`,
      params: [normalized, checksum, now, id, WORKSPACE_ID, current.scope_type, current.scope_id, current.project_id, expectedRevision] },
      { mode: 'run', sql: `INSERT INTO memory_record_revisions(id, memory_id, revision, status, content, source_type, source_ref, source_version,
        source_checksum, created_by, confidence_label, expires_at, reason, created_at)
        SELECT ?, id, revision, status, content, source_type, source_ref, source_version, source_checksum, created_by, confidence_label, expires_at, 'owner_edited', ?
        FROM memory_records WHERE id = ? AND revision = ? AND changes() > 0`,
      params: [randomUUID(), now, id, expectedRevision + 1] },
    ];
    await this.events.transactConditional('memory.updated', id, current.project_id, { memoryId: id, projectId: current.project_id, scopeType: current.scope_type, status: 'accepted', revision: expectedRevision + 1 }, operations);
    return this.getAny(id);
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    const current = await this.requireRecord(id);
    if (current.status === 'deleted') throw Object.assign(new Error('Ghi nhớ đã được xóa.'), { status: 404, code: 'MEMORY_NOT_FOUND' });
    const now = new Date().toISOString();
    const operations: DbOperation[] = [
      { mode: 'run', sql: `UPDATE memory_records SET content = '', source_type = 'deleted', source_ref = NULL, source_version = NULL, source_checksum = NULL,
        created_by = 'local-user', confidence_label = 'deleted', expires_at = NULL, status = 'deleted', revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND scope_type = ? AND scope_id = ? AND project_id IS ? AND revision = ? AND status <> 'deleted'`, params: [now, id, WORKSPACE_ID, current.scope_type, current.scope_id, current.project_id, expectedRevision] },
      { mode: 'run', sql: 'DELETE FROM memory_record_revisions WHERE memory_id = ? AND changes() > 0', params: [id] },
      { mode: 'run', sql: `INSERT INTO memory_record_revisions(id, memory_id, revision, status, content, source_type, created_by, confidence_label, reason, created_at)
        SELECT ?, id, revision, status, content, source_type, created_by, confidence_label, 'owner_deleted', ? FROM memory_records WHERE id = ? AND status = 'deleted' AND revision = ? AND changes() > 0`,
      params: [randomUUID(), now, id, expectedRevision + 1] },
    ];
    await this.events.transactConditional('memory.deleted', id, current.project_id, { memoryId: id, projectId: current.project_id, scopeType: current.scope_type, status: 'deleted', revision: expectedRevision + 1 }, operations);
  }

  async exportLongTermMemory(): Promise<MemoryExportBundle> {
    const rows = await this.db.all<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, expires_at, status, revision, created_at, updated_at FROM memory_records
      WHERE workspace_id = ? AND scope_type IN ('user','agent','project') AND status <> 'deleted'
      ORDER BY scope_type, scope_id, id LIMIT ?`, [WORKSPACE_ID, MAX_MEMORY_EXPORT_RECORDS + 1]);
    if (rows.length > MAX_MEMORY_EXPORT_RECORDS) throw Object.assign(new Error('Có quá nhiều ghi nhớ để xuất trong một tệp.'), { status: 413, code: 'MEMORY_EXPORT_TOO_LARGE' });
    const ids = rows.map((row) => row.id);
    const revisionRows = ids.length ? await this.db.all<MemoryRevisionRow>(`SELECT memory_id, revision, status, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, expires_at, reason, created_at FROM memory_record_revisions
      WHERE memory_id IN (${ids.map(() => '?').join(',')}) ORDER BY memory_id, revision LIMIT ?`, [...ids, MAX_MEMORY_EXPORT_REVISIONS + 1]) : [];
    if (revisionRows.length > MAX_MEMORY_EXPORT_REVISIONS) throw Object.assign(new Error('Lịch sử ghi nhớ quá lớn để xuất trong một tệp.'), { status: 413, code: 'MEMORY_EXPORT_TOO_LARGE' });
    const revisions = new Map<string, MemoryExportRevision[]>();
    for (const row of revisionRows) {
      const list = revisions.get(row.memory_id) ?? [];
      list.push(toExportRevision(row));
      revisions.set(row.memory_id, list);
    }
    const records = rows.map((row) => ({ ...toExportRecord(row), revisions: revisions.get(row.id) ?? [] }));
    const bundle: MemoryExportBundle = { format: 'agent-office.memory-export', schemaVersion: 1, exportId: randomUUID(), exportedAt: new Date().toISOString(), records };
    if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_MEMORY_BUNDLE_BYTES) throw Object.assign(new Error('Tệp ghi nhớ vượt quá giới hạn xuất 10 MB.'), { status: 413, code: 'MEMORY_EXPORT_TOO_LARGE' });
    return bundle;
  }

  async importLongTermMemory(raw: unknown, knownAgentDefinitionIds: ReadonlySet<string>): Promise<{ exportId: string; imported: number; skipped: number }> {
    const parsed = memoryExportBundleSchema.safeParse(raw);
    if (!parsed.success) throw Object.assign(new Error('Tệp ghi nhớ không hợp lệ hoặc vượt giới hạn.'), { status: 400, code: 'INVALID_MEMORY_EXPORT', issues: parsed.error.issues });
    const bundle = parsed.data;
    const records = bundle.records as MemoryExportRecord[];
    const totalRevisions = records.reduce((sum, record) => sum + record.revisions.length, 0);
    if (totalRevisions > MAX_MEMORY_EXPORT_REVISIONS || Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_MEMORY_BUNDLE_BYTES) {
      throw Object.assign(new Error('Tệp ghi nhớ vượt quá giới hạn hỗ trợ.'), { status: 413, code: 'MEMORY_EXPORT_TOO_LARGE' });
    }
    const seen = new Set<string>();
    const projectIds = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) throw Object.assign(new Error('Tệp có ID ghi nhớ bị lặp.'), { status: 400, code: 'INVALID_MEMORY_EXPORT' });
      seen.add(record.id);
      if (record.scopeType === 'user' && (record.scopeId !== 'local-user' || record.projectId !== null)) throw invalidMemoryExport();
      if (record.scopeType === 'agent' && (record.projectId !== null || !/^[a-z][a-z0-9-]{0,63}$/.test(record.scopeId) || !knownAgentDefinitionIds.has(record.scopeId))) {
        throw Object.assign(new Error(`Agent definition không có trong registry: ${record.scopeId}.`), { status: 409, code: 'MEMORY_SCOPE_NOT_FOUND' });
      }
      if (record.scopeType === 'project') {
        if (!record.projectId || record.scopeId !== record.projectId) throw invalidMemoryExport();
        projectIds.add(record.projectId);
      }
      if (record.revision !== record.revisions.length || record.revisions.some((revision, index) => revision.revision !== index + 1)) throw invalidMemoryExport();
      const last = record.revisions.at(-1)!;
      if (record.updatedAt !== last.createdAt || !sameRevisionState(record, last)) throw invalidMemoryExport();
      for (const revision of record.revisions) {
        if (validateContent(revision.content) !== revision.content || revision.sourceChecksum && revision.sourceChecksum !== hash(revision.content)) throw invalidMemoryExport();
      }
    }
    if (projectIds.size) {
      const projects = await this.db.all<{ id: string }>(`SELECT id FROM projects WHERE workspace_id = ? AND id IN (${[...projectIds].map(() => '?').join(',')})`, [WORKSPACE_ID, ...projectIds]);
      const present = new Set(projects.map((project) => project.id));
      const missing = [...projectIds].filter((id) => !present.has(id));
      if (missing.length) throw Object.assign(new Error('Import cần project đích đã tồn tại; không có ghi nhớ nào được thay đổi.'), { status: 409, code: 'MEMORY_PROJECT_NOT_FOUND', issues: missing });
    }
    if (!records.length) return { exportId: bundle.exportId, imported: 0, skipped: 0 };

    const ids = records.map((record) => record.id);
    const existingRows = await this.db.all<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, expires_at, status, revision, created_at, updated_at FROM memory_records WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [WORKSPACE_ID, ...ids]);
    const existingById = new Map(existingRows.map((row) => [row.id, row]));
    const existingIds = [...existingById.keys()];
    const historyRows = existingIds.length ? await this.db.all<MemoryRevisionRow>(`SELECT memory_id, revision, status, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, expires_at, reason, created_at FROM memory_record_revisions
      WHERE memory_id IN (${existingIds.map(() => '?').join(',')}) ORDER BY memory_id, revision`, existingIds) : [];
    const historyById = new Map<string, MemoryExportRevision[]>();
    for (const row of historyRows) {
      const list = historyById.get(row.memory_id) ?? [];
      list.push(toExportRevision(row));
      historyById.set(row.memory_id, list);
    }
    const conflicts: string[] = [];
    const toInsert: MemoryExportRecord[] = [];
    let skipped = 0;
    for (const record of records) {
      const existing = existingById.get(record.id);
      if (!existing) { toInsert.push(record); continue; }
      const current = { ...toExportRecord(existing), revisions: historyById.get(record.id) ?? [] };
      if (JSON.stringify(current) === JSON.stringify(record)) skipped++;
      else conflicts.push(record.id);
    }
    if (conflicts.length) throw Object.assign(new Error('Một số ghi nhớ cùng ID đã có nội dung hoặc lịch sử khác. Không có ghi nhớ nào được thay đổi.'), { status: 409, code: 'MEMORY_IMPORT_CONFLICT', issues: conflicts });
    if (!toInsert.length) return { exportId: bundle.exportId, imported: 0, skipped };

    const operations: DbOperation[] = [];
    for (const record of toInsert) {
      operations.push({ mode: 'run', sql: `INSERT INTO memory_records(id, workspace_id, project_id, scope_type, scope_id, content, source_type, source_ref,
        source_version, source_checksum, created_by, confidence_label, expires_at, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [record.id, WORKSPACE_ID, record.projectId, record.scopeType, record.scopeId, record.content, record.sourceType, record.sourceRef,
        record.sourceVersion, record.sourceChecksum, record.createdBy, record.confidenceLabel, record.revisions.at(-1)!.expiresAt, record.status, record.revision, record.createdAt, record.updatedAt] });
      for (const revision of record.revisions) operations.push({ mode: 'run', sql: `INSERT INTO memory_record_revisions(id, memory_id, revision, status, content, source_type, source_ref,
        source_version, source_checksum, created_by, confidence_label, expires_at, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [randomUUID(), record.id, revision.revision, revision.status, revision.content, revision.sourceType, revision.sourceRef, revision.sourceVersion,
        revision.sourceChecksum, revision.createdBy, revision.confidenceLabel, revision.expiresAt, revision.reason, revision.createdAt] });
    }
    try {
      await this.events.transact('memory.imported', bundle.exportId, null, { exportId: bundle.exportId, importedCount: toInsert.length, skippedCount: skipped, memoryIds: toInsert.map((record) => record.id) }, operations);
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) throw Object.assign(new Error('Tệp xung đột với ghi nhớ vừa được nhập. Tải lại danh sách rồi thử lại.'), { status: 409, code: 'MEMORY_IMPORT_CONFLICT' });
      throw error;
    }
    return { exportId: bundle.exportId, imported: toInsert.length, skipped };
  }

  async searchProject(projectId: string, query: string, maxResults = MAX_SEARCH_RESULTS): Promise<Array<Pick<ProjectMemoryRecord, 'id' | 'content' | 'sourceType' | 'sourceRef' | 'confidenceLabel' | 'revision' | 'updatedAt'>>> {
    return (await this.searchAccessible({ projectId, runId: '', agentDefinitionId: '', scopes: ['project'], query, maxResults }))
      .map(({ scopeType: _scopeType, ...record }) => record);
  }

  async searchAccessible(input: {
    projectId: string; runId: string; agentDefinitionId: string; scopes: readonly string[]; query: string; maxResults?: number;
  }): Promise<ScopedMemoryHit[]> {
    const scopePairs: Array<{ type: NonNullable<MemoryRow['scope_type']>; id: string; projectId: string | null }> = [];
    if (input.scopes.includes('user')) scopePairs.push({ type: 'user', id: 'local-user', projectId: null });
    if (input.scopes.includes('agent')) scopePairs.push({ type: 'agent', id: input.agentDefinitionId, projectId: null });
    if (input.scopes.includes('project')) scopePairs.push({ type: 'project', id: input.projectId, projectId: input.projectId });
    if (input.scopes.includes('run')) scopePairs.push({ type: 'run', id: input.runId, projectId: input.projectId });
    if (!scopePairs.length) return [];
    const normalizedQuery = input.query.trim().slice(0, 300);
    const tokens = [...new Set(normalizedQuery.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 8);
    const queryClause = tokens.length ? `AND (${tokens.map(() => 'content LIKE ? ESCAPE \'\\\'').join(' OR ')})` : '';
    const scopeClause = scopePairs.map(() => '(scope_type = ? AND scope_id = ? AND project_id IS ?)').join(' OR ');
    const scopeParams = scopePairs.flatMap((scope) => [scope.type, scope.id, scope.projectId]);
    const rows = await this.db.all<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, status, revision, created_at, updated_at FROM memory_records
      WHERE workspace_id = ? AND (${scopeClause}) AND status = 'accepted'
      AND (expires_at IS NULL OR expires_at > ?) ${queryClause}
      ORDER BY updated_at DESC LIMIT 100`,
    [WORKSPACE_ID, ...scopeParams, new Date().toISOString(), ...tokens.map((token) => `%${escapeLike(token)}%`)]);
    const ranked = rows.map((row) => ({ row, score: tokens.reduce((count, token) => count + (row.content.toLocaleLowerCase().includes(token) ? 1 : 0), 0) }))
      .sort((a, b) => b.score - a.score || b.row.updated_at.localeCompare(a.row.updated_at));
    const output: ScopedMemoryHit[] = [];
    let budget = MAX_CONTEXT_BYTES;
    for (const { row } of ranked) {
      if (output.length >= Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(input.maxResults ?? MAX_SEARCH_RESULTS)))) break;
      const size = Buffer.byteLength(row.content, 'utf8');
      if (size > budget) continue;
      budget -= size;
      output.push({ id: row.id, scopeType: row.scope_type!, content: row.content, sourceType: row.source_type, sourceRef: row.source_ref, confidenceLabel: row.confidence_label, revision: row.revision, updatedAt: row.updated_at });
    }
    return output;
  }

  async get(id: string): Promise<ProjectMemoryRecord> {
    const row = await this.requireProjectRecord(id);
    if (row.status === 'deleted') throw Object.assign(new Error('Không tìm thấy ghi nhớ.'), { status: 404, code: 'MEMORY_NOT_FOUND' });
    return toProjectRecord(row);
  }

  private async requireProjectRecord(id: string): Promise<MemoryRow> {
    const row = await this.db.one<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, status, revision, created_at, updated_at FROM memory_records WHERE id = ? AND workspace_id = ? AND scope_type = 'project'`, [id, WORKSPACE_ID]);
    if (!row) throw Object.assign(new Error('Không tìm thấy ghi nhớ.'), { status: 404, code: 'MEMORY_NOT_FOUND' });
    return row;
  }

  async getAny(id: string): Promise<MemoryRecord> {
    const row = await this.requireRecord(id);
    if (row.status === 'deleted') throw Object.assign(new Error('Không tìm thấy ghi nhớ.'), { status: 404, code: 'MEMORY_NOT_FOUND' });
    return toRecord(row);
  }

  private async requireRecord(id: string): Promise<MemoryRow> {
    const row = await this.db.one<MemoryRow>(`SELECT id, project_id, scope_type, scope_id, content, source_type, source_ref, source_version, source_checksum,
      created_by, confidence_label, status, revision, created_at, updated_at FROM memory_records WHERE id = ? AND workspace_id = ?`, [id, WORKSPACE_ID]);
    if (!row) throw Object.assign(new Error('Không tìm thấy ghi nhớ.'), { status: 404, code: 'MEMORY_NOT_FOUND' });
    return row;
  }

  private insertRevision(id: string, revision: number, status: string, content: string, sourceType: string, sourceRef: string | null,
    sourceVersion: string | null, sourceChecksum: string, createdBy: string, confidence: string, expiresAt: string | null, reason: string, now: string): DbOperation {
    return { mode: 'run', sql: `INSERT INTO memory_record_revisions(id, memory_id, revision, status, content, source_type, source_ref, source_version,
      source_checksum, created_by, confidence_label, expires_at, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [randomUUID(), id, revision, status, content, sourceType, sourceRef, sourceVersion, sourceChecksum, createdBy, confidence, expiresAt, reason, now] };
  }
}

function toRecord(row: MemoryRow): MemoryRecord {
  return { id: row.id, scopeType: row.scope_type, scopeId: row.scope_id, projectId: row.project_id, content: row.content, sourceType: row.source_type, sourceRef: row.source_ref,
    sourceVersion: row.source_version, sourceChecksum: row.source_checksum, createdBy: row.created_by, confidenceLabel: row.confidence_label,
    status: row.status as MemoryRecord['status'], revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toExportRecord(row: MemoryRow): Omit<MemoryExportRecord, 'revisions'> {
  return {
    id: row.id, scopeType: row.scope_type as 'user' | 'agent' | 'project', scopeId: row.scope_id, projectId: row.project_id,
    content: row.content, sourceType: row.source_type, sourceRef: row.source_ref, sourceVersion: row.source_version, sourceChecksum: row.source_checksum,
    createdBy: row.created_by, confidenceLabel: row.confidence_label, expiresAt: row.expires_at ?? null,
    status: row.status as MemoryExportRecord['status'], revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toExportRevision(row: MemoryRevisionRow): MemoryExportRevision {
  return {
    revision: row.revision, status: row.status, content: row.content, sourceType: row.source_type, sourceRef: row.source_ref,
    sourceVersion: row.source_version, sourceChecksum: row.source_checksum, createdBy: row.created_by,
    confidenceLabel: row.confidence_label, expiresAt: row.expires_at, reason: row.reason, createdAt: row.created_at,
  };
}

function sameRevisionState(record: MemoryExportRecord, revision: MemoryExportRevision): boolean {
  return record.status === revision.status && record.content === revision.content && record.sourceType === revision.sourceType &&
    record.sourceRef === revision.sourceRef && record.sourceVersion === revision.sourceVersion && record.sourceChecksum === revision.sourceChecksum &&
    record.createdBy === revision.createdBy && record.confidenceLabel === revision.confidenceLabel && record.expiresAt === revision.expiresAt;
}

function invalidMemoryExport(): Error & { status: number; code: string } {
  return Object.assign(new Error('Tệp ghi nhớ có cấu trúc, phạm vi hoặc checksum không hợp lệ.'), { status: 400, code: 'INVALID_MEMORY_EXPORT' });
}

function toProjectRecord(row: MemoryRow): ProjectMemoryRecord {
  if (row.scope_type !== 'project' || !row.project_id) throw new Error('Project memory record is missing its project scope.');
  return { ...toRecord(row), scopeType: 'project', projectId: row.project_id };
}

function parseProjectMemoryMarkdown(projectId: string, markdown: string): {
  revision: string;
  records: Array<z.infer<typeof projectMarkdownRecordMetadataSchema> & { content: string }>;
} {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_PROJECT_MARKDOWN_BYTES) throw memoryMarkdownTooLarge();
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const header = lines[0]?.match(/^<!-- agent-office-memory:v1 project=([A-Za-z0-9_-]+) revision=([a-f0-9]{64}) -->$/);
  if (!header || Buffer.from(header[1]!, 'base64url').toString('utf8') !== projectId ||
    Buffer.from(Buffer.from(header[1]!, 'base64url').toString('utf8'), 'utf8').toString('base64url') !== header[1]) {
    throw invalidMemoryMarkdown('Header hoặc project ID trong memory.md không hợp lệ.');
  }
  let cursor = 1;
  if (lines[cursor] !== '' || lines[cursor + 1] !== '# Project memory') throw invalidMemoryMarkdown('Thiếu tiêu đề chuẩn của memory.md.');
  cursor += 2;
  const records: Array<z.infer<typeof projectMarkdownRecordMetadataSchema> & { content: string }> = [];
  const seen = new Set<string>();
  while (cursor < lines.length) {
    while (cursor < lines.length && lines[cursor] === '') cursor++;
    if (cursor >= lines.length || cursor === lines.length - 1 && lines[cursor] === '') break;
    const marker = lines[cursor]!.match(/^<!-- agent-office-memory-record:v1 ([A-Za-z0-9_-]+) -->$/);
    if (!marker) throw invalidMemoryMarkdown('memory.md có nội dung ngoài các khối ghi nhớ được hỗ trợ.');
    let rawMetadata: unknown;
    try { rawMetadata = JSON.parse(Buffer.from(marker[1]!, 'base64url').toString('utf8')); }
    catch { throw invalidMemoryMarkdown('Metadata của một ghi nhớ trong memory.md không hợp lệ.'); }
    const metadata = projectMarkdownRecordMetadataSchema.safeParse(rawMetadata);
    if (!metadata.success || Buffer.from(Buffer.from(marker[1]!, 'base64url').toString('utf8'), 'utf8').toString('base64url') !== marker[1]) {
      throw invalidMemoryMarkdown('Metadata của một ghi nhớ trong memory.md không hợp lệ.');
    }
    if (seen.has(metadata.data.id)) throw invalidMemoryMarkdown('memory.md chứa ID ghi nhớ trùng lặp.');
    seen.add(metadata.data.id);
    cursor++;
    const contentLines: string[] = [];
    while (cursor < lines.length && lines[cursor] !== '<!-- /agent-office-memory-record -->') contentLines.push(lines[cursor++]!);
    if (cursor >= lines.length) throw invalidMemoryMarkdown('Một khối ghi nhớ chưa được đóng.');
    cursor++;
    records.push({ ...metadata.data, content: unescapeMemoryMarkdownContent(contentLines.join('\n')) });
  }
  if (records.length > MAX_PROJECT_MARKDOWN_RECORDS) throw memoryMarkdownTooLarge();
  return { revision: header[2]!, records };
}

function projectMemoryRevision(projectId: string, rows: MemoryRow[]): string {
  return hash(JSON.stringify([projectId, rows.map((row) => [row.id, row.revision, row.status, row.source_type, row.source_ref, row.content, row.updated_at])]));
}

function escapeMemoryMarkdownContent(content: string): string {
  return content.replace(/&/g, '&amp;').replace(/^<!--( agent-office-memory-| \/agent-office-memory-)/gm, '&lt;!--$1');
}

function unescapeMemoryMarkdownContent(content: string): string {
  return content.replace(/^&lt;!--( agent-office-memory-| \/agent-office-memory-)/gm, '<!--$1').replace(/&amp;/g, '&');
}

function invalidMemoryMarkdown(message = 'Tệp memory.md không hợp lệ.'): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_MEMORY_MARKDOWN' });
}

function memoryMarkdownConflict(): Error & { status: number; code: string } {
  return Object.assign(new Error('Ghi nhớ đã thay đổi kể từ lần xuất. Hãy tải memory.md mới rồi áp dụng lại chỉnh sửa.'), { status: 409, code: 'MEMORY_MARKDOWN_CONFLICT' });
}

function memoryMarkdownTooLarge(): Error & { status: number; code: string } {
  return Object.assign(new Error('Project có quá nhiều ghi nhớ hoặc memory.md vượt giới hạn 20 MB.'), { status: 413, code: 'MEMORY_MARKDOWN_TOO_LARGE' });
}

export function validateMemoryContent(content: string): string {
  const normalized = content.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_MEMORY_BYTES) throw Object.assign(new Error('Ghi chú phải có nội dung và không vượt quá 8 KB.'), { status: 400, code: 'INVALID_MEMORY' });
  const looksLikeSecret = /\bsk-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|password|secret)\s*[:=]\s*[^\s]{12,}/i.test(normalized);
  if (looksLikeSecret) throw Object.assign(new Error('Ghi chú có vẻ chứa credential; hãy xóa secret trước khi lưu.'), { status: 400, code: 'SENSITIVE_MEMORY' });
  return normalized;
}

const validateContent = validateMemoryContent;

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, '\\$&'); }

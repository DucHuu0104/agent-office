import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { approvalDecisionRequestSchema, createProjectRequestSchema, messageAttachmentInputSchema, pauseRunRequestSchema, resumeRunRequestSchema, sendMessageRequestSchema } from '../../shared/platform/contracts';
import type { AppConfig } from './config';
import type { DatabaseClient } from './database';
import { EventHub } from './events';
import type { ArtifactService } from './artifacts';
import { hashBody, ProjectService } from './projects';
import { AgentRuntime } from './runtime';
import { loadRegistry, previewRegistryAdditions, type Registry } from './registry';
import type { DomainEvent } from '../../shared/platform/contracts';
import { UsageLedger } from './usage';
import { MemoryService } from './memory';
import { z } from 'zod';
import { ARTIFACT_PREVIEW_CSP, ArtifactPreviewManager } from './previews';
import type { WorkspacePreviewManager } from './workspace-previews';

const API = '/platform/v1';
const BODY_LIMIT = 1_100_000;
const MEMORY_IMPORT_BODY_LIMIT = 10_000_000;
const MEMORY_MARKDOWN_BODY_LIMIT = 20_000_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
};

interface Services {
  config: AppConfig;
  db: DatabaseClient;
  events: EventHub;
  projects: ProjectService;
  runtime: AgentRuntime;
  artifacts: ArtifactService;
  memory: MemoryService;
  registry: Registry;
  registryRoot?: string;
  workspacePreviews?: WorkspacePreviewManager;
}

export function createPlatformHandler(services: Services, sessions = new Map<string, { csrf: string; expiresAt: number }>()): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const registryPreviews = new Map<string, { currentRevision: string; candidateRevision: string; expiresAt: number }>();
  const artifactPreviews = new ArtifactPreviewManager(services.artifacts);
  return async (req, res) => {
    const host = req.headers.host ?? '';
    if (!isLoopbackHost(host)) return sendJson(res, 403, { error: { code: 'LOCAL_ONLY', message: 'Agent Office chỉ nhận kết nối từ máy này.' } });
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (!url.pathname.startsWith(API)) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Không tìm thấy đường dẫn.' } });
    if (!sameOrigin(req, host)) return sendJson(res, 403, { error: { code: 'ORIGIN_REJECTED', message: 'Nguồn request không hợp lệ.' } });
    const method = req.method ?? 'GET';
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Phương thức không được hỗ trợ.' } });
    if (!['GET', 'HEAD'].includes(method) && !verifyCsrf(req, sessions)) return sendJson(res, 403, { error: { code: 'CSRF_REJECTED', message: 'Phiên trình duyệt hết hạn. Hãy tải lại trang.' } });
    try {
      await routeApi(req, res, url, services, sessions, registryPreviews, artifactPreviews, services.workspacePreviews);
    } catch (error) {
      const e = error as Error & { status?: number; code?: string; issues?: unknown };
      const status = e.status ?? 500;
      const code = e.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
      if (status >= 500) console.error(`[office api] ${code}: ${e.message}`);
      sendJson(res, status, { error: { code, message: status >= 500 ? 'Không thể hoàn tất yêu cầu. Kiểm tra trạng thái hệ thống rồi thử lại.' : e.message, ...(e.issues ? { details: e.issues } : {}) } });
    }
  };
}

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL, s: Services, sessions: Map<string, { csrf: string; expiresAt: number }>, registryPreviews: Map<string, { currentRevision: string; candidateRevision: string; expiresAt: number }>, artifactPreviews: ArtifactPreviewManager, workspacePreviews?: WorkspacePreviewManager): Promise<void> {
  const method = req.method ?? 'GET';
  const path = decodePath(url.pathname.slice(API.length) || '/');
  if (method === 'GET' && path === '/session') {
    const existing = cookie(req, 'office_session');
    let session = existing ? sessions.get(existing) : undefined;
    if (!session || session.expiresAt < Date.now()) {
      const id = randomBytes(32).toString('base64url');
      session = { csrf: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
      sessions.set(id, session);
      res.setHeader('Set-Cookie', `office_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    }
    for (const [id, entry] of sessions) if (entry.expiresAt < Date.now()) sessions.delete(id);
    return sendJson(res, 200, { csrfToken: session.csrf });
  }
  if (method === 'GET' && path === '/health') {
    const db = await s.db.one<{ sqlite: string; revision: number }>('SELECT sqlite_version() AS sqlite, revision FROM workspaces WHERE id = ?', ['local-workspace']);
    return sendJson(res, 200, { ok: true, storage: { ready: !!db, sqlite: db?.sqlite }, runtime: { ready: !!s.runtime, executionMode: s.config.executionMode, localChecksEnabled: s.config.executionMode === 'local-trusted' && s.registry.policy.approvals.shell === 'local-trusted', dockerChecksEnabled: s.config.executionMode === 'docker' && s.registry.policy.approvals.shell === 'docker' }, model: { configured: s.config.model.configured, baseUrl: s.config.model.baseUrl, name: s.config.model.name || null }, research: { provider: s.config.research.provider, configured: s.config.research.configured }, registryRevision: s.registry.revision });
  }
  if (method === 'GET' && path === '/office') {
    const cursor = await s.db.one<{ sequence: number | null }>('SELECT MAX(sequence) AS sequence FROM domain_events WHERE workspace_id = ?', ['local-workspace']);
    const snapshot = await s.projects.officeSnapshot();
    return sendJson(res, 200, { snapshot, cursor: cursor?.sequence ?? 0 });
  }
  if (method === 'GET' && path === '/events') return streamEvents(req, res, url, s, sessions);
  if (method === 'GET' && path === '/projects') {
    const status = url.searchParams.get('status') === 'archived' ? 'archived' : 'active';
    return sendJson(res, 200, { projects: await s.projects.listProjects(status) });
  }
  if (method === 'POST' && path === '/projects') {
    const body = createProjectRequestSchema.safeParse(await readJson(req));
    if (!body.success) throw Object.assign(new Error('Thông tin project không hợp lệ.'), { status: 400, code: 'INVALID_PROJECT', issues: body.error.issues });
    const workspaceRoot = body.data.workspaceRoot ? await validateWorkspaceRoot(body.data.workspaceRoot) : undefined;
    const input = { name: body.data.name, goal: body.data.goal, ...(workspaceRoot ? { workspaceRoot } : {}) };
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw Object.assign(new Error('Thiếu Idempotency-Key hợp lệ.'), { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const project = await s.projects.createProject(input, { key, bodyHash: hashBody(input) });
    return sendJson(res, 201, { project });
  }
  const workspacePreviewProject = path.match(/^\/projects\/([^/]+)\/workspace-preview$/);
  if (workspacePreviewProject) {
    if (!workspacePreviews) throw Object.assign(new Error('Workspace preview chưa được khởi tạo trong server này.'), { status: 409, code: 'PREVIEW_UNAVAILABLE' });
    const projectId = decodePath(workspacePreviewProject[1]!);
    const context = await s.projects.projectContext(projectId);
    if (!context) throw Object.assign(new Error('Không tìm thấy project.'), { status: 404, code: 'PROJECT_NOT_FOUND' });
    if (method === 'GET') return sendJson(res, 200, await workspacePreviews.describe(projectId, context.workspaceRoot));
    if (method === 'POST') {
      const parsed = z.object({ script: z.string().max(32), packageChecksum: z.string().max(64), dependencyInstallChecksum: z.string().max(64).nullable().optional(), allowNetworkAccess: z.boolean() }).strict().safeParse(await readJson(req));
      if (!parsed.success) throw Object.assign(new Error('Yêu cầu mở website preview không hợp lệ.'), { status: 400, code: 'INVALID_PREVIEW_REQUEST', issues: parsed.error.issues });
      const preview = await workspacePreviews.start({ projectId, root: context.workspaceRoot, ...parsed.data });
      return sendJson(res, 201, { preview });
    }
  }
  const workspacePreview = path.match(/^\/workspace-previews\/([A-Za-z0-9_-]{32})$/);
  if (workspacePreview && method === 'DELETE') {
    if (!workspacePreviews) throw Object.assign(new Error('Workspace preview chưa được khởi tạo trong server này.'), { status: 409, code: 'PREVIEW_UNAVAILABLE' });
    const stopped = await workspacePreviews.stop(workspacePreview[1]!);
    return sendJson(res, stopped ? 200 : 404, { stopped });
  }
  if (method === 'GET' && path === '/agents') {
    const snapshot = await s.projects.officeSnapshot();
    return sendJson(res, 200, { agents: snapshot.agents, definitions: [...s.registry.definitions.values()].map((def) => ({ id: def.manifest.id, version: def.manifest.version, displayName: def.manifest.displayName, kind: def.manifest.kind, capabilities: def.manifest.capabilities, modelProfile: def.manifest.modelProfile, allowedTools: def.manifest.allowedTools, configHash: def.configHash })), registryRevision: s.registry.revision });
  }
  const agentDrain = path.match(/^\/agents\/([^/]+)\/drain$/);
  if (method === 'POST' && agentDrain) {
    const parsed = z.object({ draining: z.boolean() }).strict().safeParse(await readJson(req));
    if (!parsed.success) throw Object.assign(new Error('Trạng thái drain của agent không hợp lệ.'), { status: 400, code: 'INVALID_AGENT_DRAIN', issues: parsed.error.issues });
    const agentId = decodePath(agentDrain[1]!);
    await s.projects.setSpecialistDraining(agentId, parsed.data.draining);
    const agent = (await s.projects.officeSnapshot()).agents.find((item) => item.id === agentId);
    return sendJson(res, 200, { agent });
  }
  if (method === 'POST' && path === '/registry/validate') return sendJson(res, 200, { valid: true, revision: s.registry.revision, definitions: s.registry.definitions.size, specialists: s.registry.roster.length });
  if (method === 'POST' && path === '/registry/preview') {
    await readJson(req);
    let candidate: Registry;
    try { candidate = await loadRegistry(s.registryRoot ?? process.cwd()); }
    catch (error) { throw Object.assign(new Error(`Cấu hình agent không hợp lệ: ${error instanceof Error ? error.message : 'không rõ lỗi'}`), { status: 400, code: 'REGISTRY_INVALID' }); }
    const diff = previewRegistryAdditions(s.registry, candidate);
    if (!diff.canApply) return sendJson(res, 200, diff);
    const previewToken = randomBytes(24).toString('base64url');
    for (const [token, preview] of registryPreviews) if (preview.expiresAt <= Date.now()) registryPreviews.delete(token);
    registryPreviews.set(previewToken, { currentRevision: diff.currentRevision, candidateRevision: diff.candidateRevision, expiresAt: Date.now() + 5 * 60 * 1000 });
    return sendJson(res, 200, { ...diff, previewToken });
  }
  if (method === 'POST' && path === '/registry/apply') {
    const parsed = z.object({ previewToken: z.string().min(16).max(128) }).strict().safeParse(await readJson(req));
    if (!parsed.success) throw Object.assign(new Error('Bản xem trước registry không hợp lệ.'), { status: 400, code: 'INVALID_REGISTRY_PREVIEW', issues: parsed.error.issues });
    const preview = registryPreviews.get(parsed.data.previewToken);
    if (!preview || preview.expiresAt <= Date.now()) throw Object.assign(new Error('Bản xem trước đã hết hạn. Hãy tạo bản xem trước mới.'), { status: 409, code: 'REGISTRY_PREVIEW_EXPIRED' });
    if (preview.currentRevision !== s.registry.revision) throw Object.assign(new Error('Registry đang chạy đã thay đổi. Hãy xem trước lại.'), { status: 409, code: 'REGISTRY_REVISION_CONFLICT' });
    let candidate: Registry;
    try { candidate = await loadRegistry(s.registryRoot ?? process.cwd()); }
    catch (error) { throw Object.assign(new Error(`Cấu hình agent không hợp lệ: ${error instanceof Error ? error.message : 'không rõ lỗi'}`), { status: 400, code: 'REGISTRY_INVALID' }); }
    const diff = previewRegistryAdditions(s.registry, candidate);
    if (!diff.canApply || diff.candidateRevision !== preview.candidateRevision) throw Object.assign(new Error('Các file agent đã đổi sau lúc xem trước. Hãy xem trước lại.'), { status: 409, code: 'REGISTRY_PREVIEW_STALE' });
    await s.projects.seedRegistry(candidate);
    Object.assign(s.registry, candidate);
    s.projects.updateRegistry(s.registry);
    s.runtime.updateRegistry(s.registry);
    registryPreviews.delete(parsed.data.previewToken);
    await s.events.transact('registry.updated', s.registry.revision, null, { registryRevision: s.registry.revision, addedDefinitions: diff.addedDefinitions.map((item) => item.id), addedAgents: diff.addedAgents.map((item) => item.id) });
    return sendJson(res, 200, { applied: true, revision: s.registry.revision, addedDefinitions: diff.addedDefinitions, addedAgents: diff.addedAgents });
  }
  if (method === 'GET' && path === '/approvals') {
    const projectId = url.searchParams.get('projectId');
    const rows = await s.db.all<{ id: string; project_id: string; run_id: string; task_id: string; summary: string; arguments_json: string; arguments_hash: string; expires_at: string; tool_id: string }>(`SELECT a.id, a.project_id, a.run_id, a.task_id, a.summary, a.arguments_json, a.arguments_hash, a.expires_at, o.tool_id
      FROM approvals a JOIN tool_operations o ON o.id = a.operation_id WHERE a.status = 'pending' AND (? IS NULL OR a.project_id = ?) ORDER BY a.expires_at`, [projectId, projectId]);
    const approvals = rows.map((row) => {
      return { id: row.id, projectId: row.project_id, runId: row.run_id, taskId: row.task_id, summary: row.summary, toolId: row.tool_id, argumentsHash: row.arguments_hash, expiresAt: row.expires_at, arguments: parseApprovalArguments(row.arguments_json) };
    });
    return sendJson(res, 200, { approvals });
  }
  if (method === 'GET' && path === '/artifacts') {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) throw Object.assign(new Error('Cần projectId.'), { status: 400, code: 'PROJECT_ID_REQUIRED' });
    return sendJson(res, 200, { artifacts: await s.artifacts.list(projectId) });
  }
  if (method === 'GET' && path === '/usage') {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) throw Object.assign(new Error('Cần projectId.'), { status: 400, code: 'PROJECT_ID_REQUIRED' });
    const rows = await s.db.all('SELECT u.agent_instance_id AS agentInstanceId, i.display_name AS displayName, SUM(u.prompt_tokens) AS promptTokens, SUM(u.completion_tokens) AS completionTokens, SUM(u.total_tokens) AS totalTokens FROM model_usage u LEFT JOIN agent_instances i ON i.id = u.agent_instance_id JOIN runs r ON r.id = u.run_id WHERE r.project_id = ? GROUP BY u.agent_instance_id, i.display_name ORDER BY totalTokens DESC', [projectId]);
    const budget = await new UsageLedger(s.db, s.registry.policy.limits.maxTokensPerRun).projectSummary(projectId);
    return sendJson(res, 200, { usage: rows, budget });
  }

  if (method === 'GET' && path === '/memory/export') {
    const bundle = await s.memory.exportLongTermMemory();
    res.setHeader('Content-Disposition', `attachment; filename="agent-office-memory-${new Date().toISOString().slice(0, 10)}.json"`);
    return sendJson(res, 200, bundle);
  }
  if (method === 'POST' && path === '/memory/import') {
    const imported = await s.memory.importLongTermMemory(await readJson(req, MEMORY_IMPORT_BODY_LIMIT), new Set(s.registry.definitions.keys()));
    return sendJson(res, 200, imported);
  }

  const projectMemoryMarkdownRoute = path.match(/^\/projects\/([^/]+)\/memory\.md(\/preview)?$/);
  if (projectMemoryMarkdownRoute) {
    const projectId = projectMemoryMarkdownRoute[1]!;
    const isPreview = Boolean(projectMemoryMarkdownRoute[2]);
    if (method === 'GET' && !isPreview) {
      const exported = await s.memory.exportProjectMarkdown(projectId);
      res.setHeader('Content-Disposition', 'attachment; filename="memory.md"');
      return sendText(res, 200, exported.markdown, 'text/markdown; charset=utf-8');
    }
    if (method === 'POST' && isPreview) {
      const parsed = z.object({ markdown: z.string().max(MEMORY_MARKDOWN_BODY_LIMIT) }).strict().safeParse(await readJson(req, MEMORY_MARKDOWN_BODY_LIMIT));
      if (!parsed.success) throw Object.assign(new Error('Nội dung memory.md không hợp lệ.'), { status: 400, code: 'INVALID_MEMORY_MARKDOWN', issues: parsed.error.issues });
      return sendJson(res, 200, await s.memory.previewProjectMarkdown(projectId, parsed.data.markdown));
    }
    if (method === 'PATCH' && !isPreview) {
      const parsed = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), markdown: z.string().max(MEMORY_MARKDOWN_BODY_LIMIT) }).strict().safeParse(await readJson(req, MEMORY_MARKDOWN_BODY_LIMIT));
      if (!parsed.success) throw Object.assign(new Error('Revision hoặc nội dung memory.md không hợp lệ.'), { status: 400, code: 'INVALID_MEMORY_MARKDOWN', issues: parsed.error.issues });
      return sendJson(res, 200, await s.memory.importProjectMarkdown(projectId, parsed.data.expectedRevision, parsed.data.markdown));
    }
  }

  if (method === 'POST' && path === '/memory') {
    const parsed = z.object({ scopeType: z.enum(['user', 'agent']), scopeId: z.string().max(64).optional(), content: z.string().max(8_000) }).strict().safeParse(await readJson(req));
    if (!parsed.success) throw Object.assign(new Error('Nội dung hoặc phạm vi ghi nhớ không hợp lệ.'), { status: 400, code: 'INVALID_MEMORY', issues: parsed.error.issues });
    const scopeId = parsed.data.scopeType === 'user' ? parsed.data.scopeId ?? 'local-user' : parsed.data.scopeId;
    if (!scopeId || parsed.data.scopeType === 'agent' && !s.registry.definitions.has(scopeId)) throw Object.assign(new Error('Không tìm thấy agent definition cho phạm vi ghi nhớ.'), { status: 404, code: 'MEMORY_SCOPE_NOT_FOUND' });
    const memory = await s.memory.addOwnerNote(parsed.data.scopeType, scopeId, parsed.data.content);
    return sendJson(res, 201, { memory });
  }

  const memoryRoute = path.match(/^\/memory\/([^/]+)$/);
  if (memoryRoute) {
    const memoryId = decodePath(memoryRoute[1]!);
    if (method === 'PATCH') {
      const parsed = z.union([
        z.object({ expectedRevision: z.number().int().min(1), content: z.string().max(8_000) }).strict(),
        z.object({ expectedRevision: z.number().int().min(1), decision: z.enum(['accept', 'reject']) }).strict(),
      ]).safeParse(await readJson(req));
      if (!parsed.success) throw Object.assign(new Error('Nội dung ghi nhớ hoặc revision không hợp lệ.'), { status: 400, code: 'INVALID_MEMORY', issues: parsed.error.issues });
      const updated = 'content' in parsed.data
        ? await s.memory.updateOwnerNote(memoryId, parsed.data.expectedRevision, parsed.data.content)
        : await s.memory.decideProposal(memoryId, parsed.data.expectedRevision, parsed.data.decision);
      return sendJson(res, 200, { memory: updated });
    }
    if (method === 'DELETE') {
      const parsed = z.object({ expectedRevision: z.number().int().min(1) }).strict().safeParse(await readJson(req));
      if (!parsed.success) throw Object.assign(new Error('Cần revision hiện tại để xóa ghi nhớ.'), { status: 400, code: 'INVALID_MEMORY_REVISION', issues: parsed.error.issues });
      await s.memory.delete(memoryId, parsed.data.expectedRevision);
      return sendJson(res, 200, { deleted: true });
    }
  }

  const projectRoute = path.match(/^\/projects\/([^/]+)(?:\/(archive|restore|conversations|memory))?$/);
  if (projectRoute) {
    const projectId = projectRoute[1]!;
    const action = projectRoute[2];
    if (method === 'GET' && !action) {
      const project = await s.projects.getProject(projectId);
      if (!project) return sendJson(res, 404, { error: { code: 'PROJECT_NOT_FOUND', message: 'Không tìm thấy project.' } });
      const [agents, messages, tasks, activeRuns, approvals, memory, workspace] = await Promise.all([
        s.projects.officeSnapshot().then((office) => office.agents.filter((agent) => agent.projectId === projectId)),
        s.projects.listMessages(project.conversationId),
        listProjectTasks(s.db, projectId),
        s.db.all<{ id: string; status: string; errorCode: string | null; version: number; pauseRequested: number }>(`SELECT r.id, r.status, r.error_code AS errorCode, r.version, r.pause_requested AS pauseRequested FROM runs r JOIN messages m ON m.id = r.request_message_id
          WHERE r.project_id = ? AND r.status IN ('queued','planning','executing','waiting_approval','paused')
          ORDER BY CASE r.status WHEN 'executing' THEN 0 WHEN 'planning' THEN 1 WHEN 'waiting_approval' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END, m.sequence`, [projectId]),
        listProjectApprovals(s.db, projectId),
        s.memory.listForProject(projectId, [...s.registry.definitions.keys()]),
        s.db.one<{ workspace_root: string | null }>('SELECT workspace_root FROM projects WHERE id = ?', [projectId]),
      ]);
      return sendJson(res, 200, { project, workspaceAttached: Boolean(workspace?.workspace_root), workspacePreview: workspacePreviews?.list(projectId)[0] ?? null, agents, messages, tasks, activeRuns: activeRuns.map((run) => ({ ...run, pauseRequested: run.pauseRequested === 1 })), approvals, memory });
    }
    if (action === 'memory' && method === 'GET') return sendJson(res, 200, { memory: await s.memory.listProject(projectId) });
    if (action === 'memory' && method === 'POST') {
      const parsed = z.object({ content: z.string().max(8_000) }).strict().safeParse(await readJson(req));
      if (!parsed.success) throw Object.assign(new Error('Nội dung ghi nhớ không hợp lệ.'), { status: 400, code: 'INVALID_MEMORY', issues: parsed.error.issues });
      return sendJson(res, 201, { memory: await s.memory.addProjectNote(projectId, parsed.data.content) });
    }
    if (method === 'GET' && action === 'conversations') {
      const project = await s.projects.getProject(projectId);
      return project ? sendJson(res, 200, { conversations: [{ id: project.conversationId, projectId, title: 'Cuộc trò chuyện chính' }] }) : sendJson(res, 404, { error: { code: 'PROJECT_NOT_FOUND', message: 'Không tìm thấy project.' } });
    }
    if (method === 'POST' && action === 'archive') {
      await workspacePreviews?.stopProject(projectId);
      const project = await s.projects.archiveProject(projectId);
      return project ? sendJson(res, 200, { project }) : sendJson(res, 404, { error: { code: 'PROJECT_NOT_FOUND', message: 'Không tìm thấy project.' } });
    }
    if (method === 'POST' && action === 'restore') {
      const project = await s.projects.restoreProject(projectId);
      return project ? sendJson(res, 200, { project }) : sendJson(res, 404, { error: { code: 'PROJECT_NOT_FOUND', message: 'Không tìm thấy project.' } });
    }
  }
  const conversationRoute = path.match(/^\/conversations\/([^/]+)\/messages$/);
  if (conversationRoute) {
    const conversationId = conversationRoute[1]!;
    if (method === 'GET') return sendJson(res, 200, { messages: await s.projects.listMessages(conversationId, Number(url.searchParams.get('limit') ?? 100)) });
    if (method === 'POST') {
      const parsed = sendMessageRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) throw Object.assign(new Error('Nội dung tin nhắn không hợp lệ.'), { status: 400, code: 'INVALID_MESSAGE', issues: parsed.error.issues });
      if (parsed.data.mode !== 'steer' && (parsed.data.targetTaskId || parsed.data.expectedVersion !== undefined)) throw Object.assign(new Error('Chỉ lệnh điều hướng mới có thể có task đích hoặc phiên bản run.'), { status: 400, code: 'STEERING_FIELDS_REQUIRE_STEER_MODE' });
      const conversation = await s.db.one<{ project_id: string }>('SELECT project_id FROM conversations WHERE id = ?', [conversationId]);
      if (!conversation) throw Object.assign(new Error('Không tìm thấy conversation.'), { status: 404, code: 'CONVERSATION_NOT_FOUND' });
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw Object.assign(new Error('Thiếu Idempotency-Key hợp lệ.'), { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
      if (parsed.data.mode === 'steer') {
        const response = await s.projects.createSteeringMessage(conversation.project_id, conversationId, parsed.data.text, { key, bodyHash: hashBody(parsed.data) }, parsed.data.targetTaskId, { expectedVersion: parsed.data.expectedVersion });
        return sendJson(res, 202, response);
      }
      const response = await s.projects.createUserMessage(conversation.project_id, conversationId, parsed.data.text, { key, bodyHash: hashBody(parsed.data) }, parsed.data.mode, parsed.data.attachments);
      s.runtime.enqueue(response.runId);
      return sendJson(res, 202, response);
    }
  }
  const runSteering = path.match(/^\/runs\/([^/]+)\/steer$/);
  if (method === 'POST' && runSteering) {
    const parsed = z.object({ text: z.string().trim().min(1).max(20000), expectedVersion: z.number().int().min(1), targetTaskId: z.string().min(1).max(64).optional(), attachments: z.array(messageAttachmentInputSchema).max(5).optional() }).strict().safeParse(await readJson(req));
    if (!parsed.success) throw Object.assign(new Error('Nội dung hoặc phiên bản điều hướng không hợp lệ.'), { status: 400, code: 'INVALID_RUN_STEERING', issues: parsed.error.issues });
    const runId = decodePath(runSteering[1]!);
    const run = await s.db.one<{ project_id: string; conversation_id: string }>('SELECT project_id, conversation_id FROM runs WHERE id = ?', [runId]);
    if (!run) throw Object.assign(new Error('Không tìm thấy run.'), { status: 404, code: 'RUN_NOT_FOUND' });
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw Object.assign(new Error('Thiếu Idempotency-Key hợp lệ.'), { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const response = await s.projects.createSteeringMessage(run.project_id, run.conversation_id, parsed.data.text, { key, bodyHash: hashBody(parsed.data) }, parsed.data.targetTaskId, {
      runId, expectedVersion: parsed.data.expectedVersion, idempotencyRoute: `/runs/${runId}/steer`, attachments: parsed.data.attachments,
    });
    return sendJson(res, 202, response);
  }
  const runDetail = path.match(/^\/runs\/([^/]+)$/);
  if (method === 'GET' && runDetail) {
    const runId = decodePath(runDetail[1]!);
    const run = await s.db.one<{ id: string; project_id: string; status: string; error_code: string | null; plan_revision: number; version: number; token_budget: number; pause_requested: number; created_at: string; updated_at: string }>(
      'SELECT id, project_id, status, error_code, plan_revision, version, token_budget, pause_requested, created_at, updated_at FROM runs WHERE id = ?', [runId],
    );
    if (!run) throw Object.assign(new Error('Không tìm thấy run.'), { status: 404, code: 'RUN_NOT_FOUND' });
    const [tasks, projectUsage, artifacts] = await Promise.all([
      s.projects.getTasks(runId),
      new UsageLedger(s.db, s.registry.policy.limits.maxTokensPerRun).projectSummary(run.project_id),
      s.artifacts.list(run.project_id),
    ]);
    const budget = projectUsage.runs.find((item) => item.runId === runId) ?? null;
    return sendJson(res, 200, { run: { id: run.id, projectId: run.project_id, status: run.status, errorCode: run.error_code, planRevision: run.plan_revision, version: run.version, tokenBudget: run.token_budget, pauseRequested: run.pause_requested === 1, createdAt: run.created_at, updatedAt: run.updated_at }, tasks, budget, artifacts });
  }
  const runTasks = path.match(/^\/runs\/([^/]+)\/tasks$/);
  if (method === 'GET' && runTasks) return sendJson(res, 200, { tasks: await s.projects.getTasks(runTasks[1]!) });
  const runCancel = path.match(/^\/runs\/([^/]+)\/cancel$/);
  if (method === 'POST' && runCancel) {
    const cancelled = await s.runtime.cancel(runCancel[1]!);
    return cancelled ? sendJson(res, 202, { status: 'cancelled' }) : sendJson(res, 409, { error: { code: 'RUN_NOT_ACTIVE', message: 'Lượt chạy không còn hoạt động.' } });
  }
  const runPause = path.match(/^\/runs\/([^/]+)\/pause$/);
  if (method === 'POST' && runPause) {
    const parsed = pauseRunRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) throw Object.assign(new Error('Cần phiên bản run hiện tại để tạm dừng.'), { status: 400, code: 'INVALID_RUN_PAUSE', issues: parsed.error.issues });
    return sendJson(res, 202, await s.runtime.pause(decodePath(runPause[1]!), parsed.data.expectedVersion));
  }
  const runResume = path.match(/^\/runs\/([^/]+)\/resume$/);
  if (method === 'POST' && runResume) {
    const parsed = resumeRunRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) throw Object.assign(new Error('Cần phiên bản run hiện tại để tiếp tục.'), { status: 400, code: 'INVALID_RUN_RESUME', issues: parsed.error.issues });
    return sendJson(res, 202, await s.runtime.resume(decodePath(runResume[1]!), parsed.data.expectedVersion, parsed.data.approvedBudget));
  }
  const approvalDecision = path.match(/^\/approvals\/([^/]+)\/decision$/);
  if (method === 'POST' && approvalDecision) {
    const body = approvalDecisionRequestSchema.safeParse(await readJson(req));
    if (!body.success) throw Object.assign(new Error('Quyết định phê duyệt không hợp lệ.'), { status: 400, code: 'INVALID_APPROVAL_DECISION', issues: body.error.issues });
    return sendJson(res, 200, await s.runtime.decideApproval(decodePath(approvalDecision[1]!), body.data.decision));
  }
  const previewRequest = path.match(/^\/artifacts\/([^/]+)\/preview$/);
  if (method === 'POST' && previewRequest) {
    const parsed = z.object({ projectId: z.string().min(1).max(64) }).strict().safeParse(await readJson(req));
    if (!parsed.success) throw Object.assign(new Error('Project cần được chọn để xem artifact.'), { status: 400, code: 'INVALID_PREVIEW_REQUEST', issues: parsed.error.issues });
    const preview = await artifactPreviews.open(parsed.data.projectId, previewRequest[1]!);
    return sendJson(res, 201, { url: `${API}/artifact-previews/${preview.token}`, expiresAt: preview.expiresAt });
  }
  const previewToken = path.match(/^\/artifact-previews\/([^/]+)$/);
  if (previewToken && method === 'GET') {
    const preview = await artifactPreviews.read(previewToken[1]!);
    if (!preview) return sendJson(res, 404, { error: { code: 'PREVIEW_EXPIRED', message: 'Preview đã hết hạn hoặc không còn tồn tại.' } });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', preview.html.byteLength);
    res.setHeader('Content-Disposition', 'inline; filename="artifact-preview.html"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', ARTIFACT_PREVIEW_CSP);
    res.end(preview.html);
    return;
  }
  if (previewToken && method === 'DELETE') {
    artifactPreviews.close(previewToken[1]!);
    res.statusCode = 204;
    res.end();
    return;
  }
  const artifactContent = path.match(/^\/artifact-versions\/([^/]+)\/content$/);
  if (method === 'GET' && artifactContent) {
    const artifact = await s.artifacts.content(artifactContent[1]!);
    if (!artifact) return sendJson(res, 404, { error: { code: 'ARTIFACT_NOT_FOUND', message: 'Không tìm thấy artifact.' } });
    res.statusCode = 200;
    res.setHeader('Content-Type', artifact.info.mimeType);
    res.setHeader('Content-Length', artifact.content.byteLength);
    res.setHeader('Content-Disposition', `attachment; filename="${basename(artifact.info.logicalName).replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(artifact.content);
    return;
  }
  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Không tìm thấy API route.' } });
}

async function listProjectTasks(db: DatabaseClient, projectId: string): Promise<unknown[]> {
  return db.all('SELECT t.id, t.run_id AS runId, t.task_key AS key, t.title, t.objective, t.status, t.assigned_agent_id AS assignedAgentId, t.output, t.created_at AS createdAt FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.project_id = ? ORDER BY t.created_at DESC LIMIT 100', [projectId]);
}

async function listProjectApprovals(db: DatabaseClient, projectId: string): Promise<unknown[]> {
  const rows = await db.all<{ id: string; run_id: string; task_id: string; summary: string; arguments_json: string; arguments_hash: string; expires_at: string; tool_id: string }>(`SELECT a.id, a.run_id, a.task_id, a.summary, a.arguments_json, a.arguments_hash, a.expires_at, o.tool_id
    FROM approvals a JOIN tool_operations o ON o.id = a.operation_id WHERE a.project_id = ? AND a.status = 'pending' ORDER BY a.expires_at`, [projectId]);
  return rows.map((row) => {
    return { id: row.id, runId: row.run_id, taskId: row.task_id, summary: row.summary, toolId: row.tool_id, argumentsHash: row.arguments_hash, expiresAt: row.expires_at, arguments: parseApprovalArguments(row.arguments_json) };
  });
}

function parseApprovalArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

async function streamEvents(req: IncomingMessage, res: ServerResponse, url: URL, s: Services, sessions: Map<string, { csrf: string; expiresAt: number }>): Promise<void> {
  const sessionId = cookie(req, 'office_session');
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || session.expiresAt < Date.now()) return sendJson(res, 403, { error: { code: 'SESSION_REQUIRED', message: 'Tải lại trang để mở phiên local.' } });
  const headerCursor = Number(req.headers['last-event-id']);
  let cursor = Number.isSafeInteger(headerCursor) && headerCursor >= 0 ? headerCursor : Number(url.searchParams.get('since') ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let replaying = true;
  const buffer: DomainEvent[] = [];
  let bufferOverflow = false;
  let streamClosed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let offEvents = () => {};
  let offTransient = () => {};
  const close = () => {
    if (streamClosed) return;
    streamClosed = true;
    if (heartbeat) clearInterval(heartbeat);
    offEvents();
    offTransient();
  };
  const writeFrame = (frame: string): boolean => {
    if (streamClosed || res.destroyed || res.writableEnded) return false;
    if (res.write(frame)) return true;
    // Let EventSource reconnect from its last durable event ID instead of buffering without a bound.
    close();
    res.destroy();
    return false;
  };
  const send = (event: { sequence: number; type: string; [key: string]: unknown }) => {
    if (event.sequence <= cursor) return;
    if (!writeFrame(`id: ${event.sequence}\nevent: office.event\ndata: ${JSON.stringify(event)}\n\n`)) return;
    cursor = event.sequence;
  };
  offEvents = s.events.onEvent((event) => {
    if (!replaying) return send(event);
    if (buffer.length >= 5000) { bufferOverflow = true; return; }
    buffer.push(event);
  });
  offTransient = s.events.onTransient((name, data) => { writeFrame(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); });
  res.on('close', close);
  heartbeat = setInterval(() => { writeFrame(': heartbeat\n\n'); }, 15_000);
  let needsSnapshot = false;
  const oldest = await s.db.one<{ sequence: number | null }>('SELECT MIN(sequence) AS sequence FROM domain_events WHERE workspace_id = ?', ['local-workspace']);
  if (oldest?.sequence !== null && oldest?.sequence !== undefined && cursor < oldest.sequence - 1) needsSnapshot = true;
  if (!needsSnapshot) {
    const replay = await s.events.listSince(cursor, 5000);
    const replayLast = replay.at(-1)?.sequence ?? cursor;
    const latest = replay.length === 5000
      ? await s.db.one<{ sequence: number | null }>('SELECT MAX(sequence) AS sequence FROM domain_events WHERE workspace_id = ?', ['local-workspace'])
      : null;
    if ((latest?.sequence ?? replayLast) > replayLast) needsSnapshot = true;
    else for (const event of replay) send(event);
  }
  if (bufferOverflow) needsSnapshot = true;
  if (needsSnapshot) {
    const latest = await s.db.one<{ sequence: number | null }>('SELECT MAX(sequence) AS sequence FROM domain_events WHERE workspace_id = ?', ['local-workspace']);
    if (latest?.sequence !== null && latest?.sequence !== undefined && writeFrame(`id: ${latest.sequence}\nevent: snapshot.required\ndata: ${JSON.stringify({ cursor: latest.sequence })}\n\n`)) {
      cursor = latest.sequence;
    }
    buffer.length = 0;
  }
  replaying = false;
  buffer.sort((a, b) => a.sequence - b.sequence);
  for (const event of buffer) send(event);
  writeFrame('event: connected\ndata: {}\n\n');
}

async function validateWorkspaceRoot(path: string): Promise<string> {
  const { realpath, stat } = await import('node:fs/promises');
  const { isAbsolute, resolve } = await import('node:path');
  if (!isAbsolute(path)) throw Object.assign(new Error('Workspace folder phải là đường dẫn tuyệt đối.'), { status: 400, code: 'INVALID_WORKSPACE_ROOT' });
  const normalized = await realpath(resolve(path)).catch(() => null);
  if (!normalized) throw Object.assign(new Error('Workspace folder không tồn tại.'), { status: 400, code: 'INVALID_WORKSPACE_ROOT' });
  const info = await stat(normalized);
  if (!info.isDirectory()) throw Object.assign(new Error('Workspace root phải là thư mục.'), { status: 400, code: 'INVALID_WORKSPACE_ROOT' });
  return normalized;
}

async function readJson(req: IncomingMessage, maxBytes = BODY_LIMIT): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().includes('application/json')) throw Object.assign(new Error('Request cần Content-Type: application/json.'), { status: 415, code: 'CONTENT_TYPE_REQUIRED' });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.byteLength;
    if (size > maxBytes) throw Object.assign(new Error('Request vượt giới hạn kích thước.'), { status: 413, code: 'BODY_TOO_LARGE' });
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON request không hợp lệ.'), { status: 400, code: 'INVALID_JSON' }); }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.byteLength);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

function sendText(res: ServerResponse, status: number, value: string, contentType: string): void {
  if (res.headersSent) return;
  const body = Buffer.from(value, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', body.byteLength);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

function decodePath(path: string): string {
  try { return decodeURIComponent(path); } catch { throw Object.assign(new Error('Đường dẫn không hợp lệ.'), { status: 400, code: 'INVALID_PATH' }); }
}

function isLoopbackHost(host: string): boolean {
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function sameOrigin(req: IncomingMessage, host: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase() && new URL(origin).protocol === 'http:'; }
  catch { return false; }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function verifyCsrf(req: IncomingMessage, sessions: Map<string, { csrf: string; expiresAt: number }>): boolean {
  const id = cookie(req, 'office_session');
  const session = id ? sessions.get(id) : undefined;
  const supplied = req.headers['x-csrf-token'];
  if (!session || session.expiresAt < Date.now() || typeof supplied !== 'string') return false;
  const expected = Buffer.from(session.csrf);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

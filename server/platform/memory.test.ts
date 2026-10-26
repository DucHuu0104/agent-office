import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { MemoryService } from './memory';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';

describe('project memory', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let memory: MemoryService;
  let projects: ProjectService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-memory-'));
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, await loadRegistry(process.cwd()));
    await projects.seedRegistry();
    memory = new MemoryService(db, events);
  });

  afterEach(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps accepted notes scoped to their project and includes them in lexical retrieval', async () => {
    const first = await projects.createProject({ name: 'Memory project A', goal: '' });
    const second = await projects.createProject({ name: 'Memory project B', goal: '' });
    await memory.addProjectNote(first.id, 'For this project, keep the frontend in TypeScript and use the existing Vite build.');

    const found = await memory.searchProject(first.id, 'TypeScript Vite');
    const isolated = await memory.searchProject(second.id, 'TypeScript Vite');

    expect(found).toHaveLength(1);
    expect(found[0]?.content).toContain('TypeScript');
    expect(isolated).toEqual([]);
  });

  it('retrieves only scopes granted to the agent and never crosses project or run boundaries', async () => {
    const first = await projects.createProject({ name: 'Scoped memory project A', goal: '' });
    const second = await projects.createProject({ name: 'Scoped memory project B', goal: '' });
    const runA = await projects.createUserMessage(first.id, first.conversationId, 'Request A');
    const runB = await projects.createUserMessage(second.id, second.conversationId, 'Request B');
    await db.run("UPDATE runs SET status = 'executing' WHERE id IN (?, ?)", [runA.runId, runB.runId]);
    const taskA = await insertMemoryTask(runA.runId);
    const taskB = await insertMemoryTask(runB.runId);
    await memory.addProjectNote(first.id, 'Project A architecture decision');
    await memory.addProjectNote(second.id, 'Project B architecture decision');
    await memory.addRunNote({ projectId: first.id, runId: runA.runId, taskId: taskA, agentInstanceId: 'developer-01', content: 'Run A handoff detail' });
    await memory.addRunNote({ projectId: second.id, runId: runB.runId, taskId: taskB, agentInstanceId: 'developer-01', content: 'Run B handoff detail' });
    await insertAcceptedGlobal('user', 'local-user', 'User preference: answer in Vietnamese');
    await insertAcceptedGlobal('agent', 'developer', 'Developer convention: preserve public API compatibility');
    await insertAcceptedGlobal('agent', 'writer', 'Writer convention: use concise headings');

    const developer = await memory.searchAccessible({ projectId: first.id, runId: runA.runId, agentDefinitionId: 'developer', scopes: ['agent', 'project', 'run'], query: 'architecture detail compatibility Vietnamese' });
    const coordinator = await memory.searchAccessible({ projectId: first.id, runId: runA.runId, agentDefinitionId: 'coordinator', scopes: ['user', 'project', 'run'], query: 'architecture detail compatibility Vietnamese' });
    const nextProject = await memory.searchAccessible({ projectId: second.id, runId: runB.runId, agentDefinitionId: 'developer', scopes: ['agent', 'project', 'run'], query: 'architecture detail compatibility Vietnamese' });

    expect(developer.map((item) => item.scopeType)).toEqual(expect.arrayContaining(['agent', 'project', 'run']));
    expect(developer.map((item) => item.content).join('\n')).toContain('preserve public API compatibility');
    expect(developer.map((item) => item.content).join('\n')).not.toContain('User preference');
    expect(developer.map((item) => item.content).join('\n')).not.toContain('Writer convention');
    expect(developer.map((item) => item.content).join('\n')).not.toContain('Run B handoff');

    expect(coordinator.map((item) => item.scopeType)).toEqual(expect.arrayContaining(['user', 'project', 'run']));
    expect(coordinator.map((item) => item.content).join('\n')).toContain('User preference');
    expect(coordinator.map((item) => item.content).join('\n')).not.toContain('Developer convention');

    expect(nextProject.map((item) => item.content).join('\n')).not.toContain('Project A architecture');
    expect(nextProject.map((item) => item.content).join('\n')).not.toContain('Run A handoff');
    expect(nextProject.map((item) => item.content).join('\n')).toContain('Project B architecture');
    expect(nextProject.map((item) => item.content).join('\n')).toContain('Run B handoff');
  });

  it('lets the owner create, revise and delete user-wide and agent-specific notes', async () => {
    const project = await projects.createProject({ name: 'Owner memory scopes', goal: '' });
    const userNote = await memory.addOwnerNote('user', 'local-user', 'Prefer Vietnamese and concise answers.');
    const agentNote = await memory.addOwnerNote('agent', 'developer', 'Keep public APIs backward compatible.');
    expect(userNote).toMatchObject({ scopeType: 'user', scopeId: 'local-user', projectId: null, revision: 1 });
    expect(agentNote).toMatchObject({ scopeType: 'agent', scopeId: 'developer', projectId: null, revision: 1 });
    expect((await memory.listForProject(project.id, ['developer'])).map((item) => item.id)).toEqual(expect.arrayContaining([userNote.id, agentNote.id]));

    const updated = await memory.updateOwnerNote(agentNote.id, 1, 'Preserve public API compatibility.');
    expect(updated).toMatchObject({ id: agentNote.id, revision: 2, scopeType: 'agent' });
    await expect(memory.updateOwnerNote(agentNote.id, 1, 'Stale agent note')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await memory.delete(userNote.id, 1);

    const visible = await memory.searchAccessible({ projectId: project.id, runId: 'run-no-agent-note', agentDefinitionId: 'developer', scopes: ['user', 'agent'], query: 'Vietnamese API compatibility' });
    expect(visible.map((item) => item.content).join('\n')).toContain('Preserve public API compatibility');
    expect(visible.map((item) => item.content).join('\n')).not.toContain('Prefer Vietnamese');
  });

  it('uses compare-and-swap revisions and scrubs deleted content into a tombstone', async () => {
    const project = await projects.createProject({ name: 'Memory revisions', goal: '' });
    const created = await memory.addProjectNote(project.id, 'The user prefers a short deployment report.');
    const updated = await memory.updateProjectNote(created.id, 1, 'The user prefers a detailed deployment report with commands.');

    expect(updated.revision).toBe(2);
    await expect(memory.updateProjectNote(created.id, 1, 'Stale write')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await memory.delete(created.id, 2);

    expect(await memory.listProject(project.id)).toEqual([]);
    expect(await memory.searchProject(project.id, 'deployment')).toEqual([]);
    expect(await db.one<{ content: string; status: string; revision: number }>('SELECT content, status, revision FROM memory_records WHERE id = ?', [created.id]))
      .toEqual({ content: '', status: 'deleted', revision: 3 });
    expect(await db.all<{ content: string }>('SELECT content FROM memory_record_revisions WHERE memory_id = ?', [created.id]))
      .toEqual([{ content: '' }]);
  });

  it('keeps agent proposals out of retrieval until the owner accepts them', async () => {
    const project = await projects.createProject({ name: 'Agent memory review', goal: '' });
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Implement the agreed locale preference.');
    const taskId = randomUUID();
    const now = new Date().toISOString();
    await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
      VALUES (?, ?, 'write', 'specialist', 'Implement locale', 'Follow the project preference', '[]', 'succeeded', ?, ?)`, [taskId, run.runId, now, now]);
    const proposal = await memory.proposeProjectMemory({ projectId: project.id, runId: run.runId, taskId, agentInstanceId: 'writer-01', content: 'The user accepted Vietnamese as this project default language.' });

    expect(proposal).toMatchObject({ status: 'proposed', sourceType: 'agent_proposal', sourceRef: `task:${taskId}`, revision: 1 });
    expect(await memory.searchProject(project.id, 'Vietnamese')).toEqual([]);
    await expect(memory.proposeProjectMemory({ projectId: 'another-project', runId: run.runId, taskId, agentInstanceId: 'writer-01', content: 'Wrong project.' }))
      .rejects.toMatchObject({ code: 'MEMORY_SOURCE_MISMATCH' });

    const accepted = await memory.decideProposal(proposal.id, 1, 'accept');
    expect(accepted).toMatchObject({ status: 'accepted', confidenceLabel: 'owner_accepted', revision: 2 });
    expect(await memory.searchProject(project.id, 'Vietnamese')).toHaveLength(1);
    await expect(memory.decideProposal(proposal.id, 1, 'reject')).rejects.toMatchObject({ code: 'MEMORY_NOT_PROPOSED' });
  });

  it('rejects oversized or blank notes and does not create any row', async () => {
    const project = await projects.createProject({ name: 'Memory validation', goal: '' });

    await expect(memory.addProjectNote(project.id, '  ')).rejects.toMatchObject({ code: 'INVALID_MEMORY' });
    await expect(memory.addProjectNote(project.id, 'x'.repeat(8_001))).rejects.toMatchObject({ code: 'INVALID_MEMORY' });
    await expect(memory.addOwnerNote('user', 'local-user', 'api_key=1234567890abcdefghijklmnop')).rejects.toMatchObject({ code: 'SENSITIVE_MEMORY' });
    expect(await memory.listProject(project.id)).toEqual([]);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM memory_records WHERE scope_type = 'user'")).toMatchObject({ count: 0 });
  });

  it('exports editable project memory.md and records an atomic, versioned owner edit', async () => {
    const project = await projects.createProject({ name: 'Markdown memory', goal: '' });
    const note = await memory.addProjectNote(project.id, 'Keep the public API stable.\n<!-- agent-office-memory-record:v1 forged -->\nUse ampersands & preserve them.');
    const exported = await memory.exportProjectMarkdown(project.id);
    expect(exported.markdown).toContain('# Project memory');
    expect(exported.markdown).toContain('&lt;!-- agent-office-memory-record:v1 forged -->');
    expect((await memory.previewProjectMarkdown(project.id, exported.markdown)).changedCount).toBe(0);

    const edited = exported.markdown.replace('Keep the public API stable.', 'Keep the public HTTP API stable.');
    const preview = await memory.previewProjectMarkdown(project.id, edited);
    expect(preview).toMatchObject({ expectedRevision: exported.revision, recordCount: 1, changedCount: 1 });
    expect(preview.changes[0]).toMatchObject({ id: note.id, revision: 1, nextRevision: 2 });
    const capturedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = events.onEvent((event) => capturedEvents.push({ type: event.type, payload: event.payload }));

    await memory.importProjectMarkdown(project.id, preview.expectedRevision, edited);
    unsubscribe();
    expect(await memory.get(note.id)).toMatchObject({ revision: 2, content: 'Keep the public HTTP API stable.\n<!-- agent-office-memory-record:v1 forged -->\nUse ampersands & preserve them.' });
    expect(await db.one<{ reason: string; revision: number }>("SELECT reason, revision FROM memory_record_revisions WHERE memory_id = ? AND revision = 2", [note.id]))
      .toEqual({ reason: 'owner_markdown_import', revision: 2 });
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]).toMatchObject({ type: 'memory.markdown_imported', payload: { projectId: project.id, changedCount: 1, memoryIds: [note.id] } });
    expect(JSON.stringify(capturedEvents[0])).not.toContain('public HTTP API');
    expect((await memory.exportProjectMarkdown(project.id)).markdown).toContain('Keep the public HTTP API stable.');
  });

  it('rejects stale, incomplete, immutable, and sensitive project memory.md imports without writing', async () => {
    const project = await projects.createProject({ name: 'Markdown conflict', goal: '' });
    const note = await memory.addProjectNote(project.id, 'Current project decision.');
    const stale = await memory.exportProjectMarkdown(project.id);
    await memory.updateProjectNote(note.id, 1, 'A newer decision was saved in the office.');
    await expect(memory.importProjectMarkdown(project.id, stale.revision, stale.markdown)).rejects.toMatchObject({ code: 'MEMORY_MARKDOWN_CONFLICT' });

    const current = await memory.exportProjectMarkdown(project.id);
    const marker = current.markdown.indexOf('\n<!-- agent-office-memory-record:v1 ');
    const omittedRecord = `${current.markdown.slice(0, marker).trimEnd()}\n`;
    await expect(memory.previewProjectMarkdown(project.id, omittedRecord)).rejects.toMatchObject({ code: 'INVALID_MEMORY_MARKDOWN' });
    await expect(memory.previewProjectMarkdown(project.id, current.markdown.replace('A newer decision', 'api_key=1234567890abcdefghijklmnop')))
      .rejects.toMatchObject({ code: 'SENSITIVE_MEMORY' });

    const run = await projects.createUserMessage(project.id, project.conversationId, 'Propose a durable memory.');
    await db.run("UPDATE runs SET status = 'executing' WHERE id = ?", [run.runId]);
    const taskId = await insertMemoryTask(run.runId);
    const proposal = await memory.proposeProjectMemory({ projectId: project.id, runId: run.runId, taskId, agentInstanceId: 'developer-01', content: 'An agent-proposed decision that needs owner review.' });
    const withProposal = await memory.exportProjectMarkdown(project.id);
    const editedProposal = withProposal.markdown.replace('An agent-proposed decision that needs owner review.', 'Owner changed a proposal without accepting it.');
    await expect(memory.previewProjectMarkdown(project.id, editedProposal)).rejects.toMatchObject({ code: 'MEMORY_NOT_EDITABLE' });
    expect(await memory.get(note.id)).toMatchObject({ content: 'A newer decision was saved in the office.', revision: 2 });
    expect(await memory.get(proposal.id)).toMatchObject({ status: 'proposed', revision: 1 });
  });

  it('exports long-term memory with history and imports it idempotently without run scratch', async () => {
    const project = await projects.createProject({ name: 'Memory archive', goal: '' });
    const note = await memory.addProjectNote(project.id, 'Keep the API response backward compatible.');
    await memory.updateProjectNote(note.id, 1, 'Keep public API responses backward compatible.');
    const run = await projects.createUserMessage(project.id, project.conversationId, 'Prepare a temporary handoff.');
    await db.run("UPDATE runs SET status = 'executing' WHERE id = ?", [run.runId]);
    const taskId = await insertMemoryTask(run.runId);
    await memory.addRunNote({ projectId: project.id, runId: run.runId, taskId, agentInstanceId: 'developer-01', content: 'Temporary handoff detail for this run.' });

    const bundle = await memory.exportLongTermMemory();
    expect(bundle.records).toHaveLength(1);
    expect(bundle.records[0]).toMatchObject({ id: note.id, scopeType: 'project', revision: 2, content: 'Keep public API responses backward compatible.' });
    expect(bundle.records[0]?.revisions).toHaveLength(2);
    expect(JSON.stringify(bundle)).not.toContain('Temporary handoff detail');

    await db.batch([
      { mode: 'run', sql: 'DELETE FROM memory_record_revisions WHERE memory_id = ?', params: [note.id] },
      { mode: 'run', sql: 'DELETE FROM memory_records WHERE id = ?', params: [note.id] },
    ], true);
    const definitions = new Set((await loadRegistry(process.cwd())).definitions.keys());
    expect(await memory.importLongTermMemory(bundle, definitions)).toMatchObject({ exportId: bundle.exportId, imported: 1, skipped: 0 });
    expect(await memory.get(note.id)).toMatchObject({ content: 'Keep public API responses backward compatible.', revision: 2 });
    expect(await memory.importLongTermMemory(bundle, definitions)).toMatchObject({ imported: 0, skipped: 1 });

    const conflict = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    const changed = 'Use stable public API responses.';
    const changedChecksum = createHash('sha256').update(changed).digest('hex');
    conflict.records[0]!.content = changed;
    conflict.records[0]!.sourceChecksum = changedChecksum;
    const lastRevision = conflict.records[0]!.revisions.at(-1)!;
    lastRevision.content = changed;
    lastRevision.sourceChecksum = changedChecksum;
    await expect(memory.importLongTermMemory(conflict, definitions)).rejects.toMatchObject({ code: 'MEMORY_IMPORT_CONFLICT' });
    expect(await memory.get(note.id)).toMatchObject({ content: 'Keep public API responses backward compatible.', revision: 2 });
  });

  it('does not resurrect an owner-deleted memory from a stale export bundle', async () => {
    const project = await projects.createProject({ name: 'Deleted memory import', goal: '' });
    const note = await memory.addProjectNote(project.id, 'The legacy deployment decision is obsolete.');
    const staleBundle = await memory.exportLongTermMemory();
    await memory.delete(note.id, note.revision);

    const definitions = new Set((await loadRegistry(process.cwd())).definitions.keys());
    await expect(memory.importLongTermMemory(staleBundle, definitions)).rejects.toMatchObject({ code: 'MEMORY_IMPORT_CONFLICT' });

    expect((await memory.exportLongTermMemory()).records.map((record) => record.id)).not.toContain(note.id);
    expect(await db.one<{ content: string; status: string; revision: number }>(
      'SELECT content, status, revision FROM memory_records WHERE id = ?', [note.id],
    )).toMatchObject({ content: '', status: 'deleted', revision: 2 });
    expect(await db.all<{ content: string }>(
      'SELECT content FROM memory_record_revisions WHERE memory_id = ?', [note.id],
    )).toEqual([{ content: '' }]);
  });

  async function insertAcceptedGlobal(scopeType: 'user' | 'agent', scopeId: string, content: string): Promise<void> {
    const now = new Date().toISOString();
    const checksum = createHash('sha256').update(content).digest('hex');
    await db.run(`INSERT INTO memory_records(id, workspace_id, project_id, scope_type, scope_id, content, source_type, source_ref,
      source_version, source_checksum, created_by, confidence_label, status, revision, created_at, updated_at)
      VALUES (?, 'local-workspace', NULL, ?, ?, ?, 'owner_note', NULL, NULL, ?, 'local-user', 'owner_confirmed', 'accepted', 1, ?, ?)`,
    [randomUUID(), scopeType, scopeId, content, checksum, now, now]);
  }

  async function insertMemoryTask(runId: string): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.run(`INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
      VALUES (?, ?, 'memory', 'specialist', 'Memory task', 'Test scoped run memory', '[]', 'succeeded', ?, ?)`, [id, runId, now, now]);
    return id;
  }
});

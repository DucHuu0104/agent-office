import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';
import { prepareWorkspaceChecks } from './executor';

describe('workspace write approval recovery', () => {
  let dataDir: string;
  let workspaceRoot: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-approval-test-'));
    workspaceRoot = join(dataDir, 'workspace');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspaceRoot);
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    registry = await loadRegistry(process.cwd());
    projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({ OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'local-trusted' }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await runtime.stop().catch(() => undefined);
    await db.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each([
    { operation: 'workspace.write' as const, phase: 'approval-committed', expectedFile: 'approved content', expectedOperation: 'succeeded', expectedRun: 'queued', expectedToolMessages: 1 },
    { operation: 'workspace.write' as const, phase: 'dispatch-committed', expectedFile: null, expectedOperation: 'outcome_unknown', expectedRun: 'paused', expectedToolMessages: 0 },
    { operation: 'workspace.write' as const, phase: 'effect-before-receipt', expectedFile: 'approved content', expectedOperation: 'succeeded', expectedRun: 'queued', expectedToolMessages: 1 },
    { operation: 'workspace.patch' as const, phase: 'effect-before-receipt', expectedFile: 'approved content', expectedOperation: 'succeeded', expectedRun: 'queued', expectedToolMessages: 1 },
    { operation: 'workspace.write' as const, phase: 'receipt-before-checkpoint', expectedFile: 'approved content', expectedOperation: 'succeeded', expectedRun: 'queued', expectedToolMessages: 1 },
    { operation: 'workspace.write' as const, phase: 'checkpoint-committed', expectedFile: 'approved content', expectedOperation: 'succeeded', expectedRun: 'queued', expectedToolMessages: 1 },
    { operation: 'workspace.write' as const, phase: 'resume-committed', expectedFile: 'approved content', expectedOperation: 'succeeded', expectedRun: 'queued', expectedToolMessages: 1 },
    { operation: 'workspace.run_checks' as const, phase: 'effect-before-receipt', expectedFile: null, expectedOperation: 'outcome_unknown', expectedRun: 'paused', expectedToolMessages: 0 },
  ])('recovers $toolId safely after a real process kill at $phase', async ({ operation: toolId, phase, expectedFile, expectedOperation, expectedRun, expectedToolMessages }) => {
    let checkInvocationMarker: string | undefined;
    let pending: Awaited<ReturnType<typeof seedApproval>>;
    if (toolId === 'workspace.run_checks') {
      checkInvocationMarker = join(dataDir, 'run-check-invocations.txt');
      const markerLiteral = checkInvocationMarker.replaceAll('\\', '/').replaceAll("'", "\\'");
      await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({
        name: 'runtime-check-crash-fixture',
        scripts: { verify: `node -e "require('fs').appendFileSync('${markerLiteral}', 'x'); console.log('check-evidence')"` },
      }));
      const proposal = await prepareWorkspaceChecks(workspaceRoot, ['verify']);
      pending = await seedApproval({ toolId, argumentsJson: JSON.stringify(proposal) });
    } else {
      pending = await seedApproval({ toolId });
    }
    await runtime.stop();
    await db.close();

    const markerPath = join(dataDir, `crash-${phase}.json`);
    const child = spawn(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./crash-recovery-child.ts', import.meta.url)),
      dataDir, pending.approvalId, phase, markerPath,
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
        try { await access(markerPath); break; } catch { /* marker is written only at the selected durable boundary */ }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Crash helper exited before ${phase}: ${output}`);
        await delay(20);
      }
      await expect(access(markerPath)).resolves.toBeUndefined();
      expect(child.kill('SIGKILL')).toBe(true);
      killed = true;
      const result = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error(`Crash helper did not exit after SIGKILL at ${phase}.`); }),
      ]);
      expect(result.code).not.toBe(0);
    } finally {
      if (!killed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (!killed) await Promise.race([childExit.catch(() => undefined), delay(5_000)]);
    }

    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    projects = new ProjectService(db, events, registry);
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({ OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'local-trusted' }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    await runtime.recover();

    const fileContent = await readFile(join(workspaceRoot, 'approved.txt'), 'utf8').catch(() => null);
    expect(fileContent).toBe(expectedFile);
    const operation = await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId]);
    expect(operation?.status).toBe(expectedOperation);
    const run = await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [pending.runId]);
    expect(run?.status).toBe(expectedRun);
    const latest = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
    const state = JSON.parse(latest!.state_json);
    const toolMessages = state.messages.filter((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === pending.toolCallId);
    expect(toolMessages).toHaveLength(expectedToolMessages);
    if (expectedOperation === 'succeeded') {
      expect(state.pendingApproval).toBeUndefined();
      expect(state.pendingToolCalls).toEqual([]);
      expect(JSON.parse(toolMessages[0].content).data).toContain('approved.txt');
    } else {
      expect(state.pendingApproval).toBeDefined();
      expect(await db.one<{ error_code: string }>('SELECT error_code FROM runs WHERE id = ?', [pending.runId])).toEqual({ error_code: 'TOOL_OUTCOME_UNKNOWN' });
    }
    if (checkInvocationMarker) expect(await readFile(checkInvocationMarker, 'utf8')).toBe('x');
  }, 30_000);

  it('denial records a tool error and resumes without writing the file', async () => {
    const pending = await seedApproval();

    const result = await runtime.decideApproval(pending.approvalId, 'deny');

    expect(result).toEqual({ status: 'denied', resumed: true });
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(await db.one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', [pending.approvalId])).toMatchObject({ status: 'denied' });
    expect(await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [pending.operationId])).toMatchObject({ status: 'cancelled' });
    expect(JSON.parse((await db.one<{ receipt_json: string }>('SELECT receipt_json FROM tool_operations WHERE id = ?', [pending.operationId]))!.receipt_json)).toMatchObject({ error: expect.stringContaining('từ chối') });
    expect(await projects.getTasks(pending.runId)).toMatchObject([{ id: pending.taskId, status: 'ready' }]);
    expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [pending.runId])).toMatchObject({ status: 'queued' });
    const checkpoint = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
    expect(JSON.parse(checkpoint!.state_json).messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: pending.toolCallId });
    expect(runtime.enqueue).toHaveBeenCalledWith(pending.runId);
  });

  it('expires a stale approval without applying the proposed write', async () => {
    const pending = await seedApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() });

    const result = await runtime.decideApproval(pending.approvalId, 'approve');

    expect(result).toEqual({ status: 'expired', resumed: true });
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(await db.one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', [pending.approvalId])).toMatchObject({ status: 'expired' });
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId])).toMatchObject({ status: 'cancelled' });
  });

  it.each([
    { label: 'denied', decision: 'deny' as const, expectedStatus: 'denied', expectedError: 'đã từ chối thao tác ghi' },
    { label: 'expired', decision: 'approve' as const, expiresAt: new Date(Date.now() - 1000).toISOString(), expectedStatus: 'expired', expectedError: 'đã hết hạn' },
  ])('recovers a $label approval if the process stops before its checkpoint advances', async ({ decision, expiresAt, expectedStatus, expectedError }) => {
    const pending = await seedApproval(expiresAt ? { expiresAt } : {});
    const methods = runtime as unknown as { saveCheckpoint: (executionId: string, state: unknown) => Promise<void> };
    const failedCheckpoint = vi.spyOn(methods, 'saveCheckpoint').mockRejectedValueOnce(new Error('injected crash before decision checkpoint'));

    await expect(runtime.decideApproval(pending.approvalId, decision)).rejects.toThrow('injected crash before decision checkpoint');
    expect(await db.one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', [pending.approvalId])).toEqual({ status: expectedStatus });
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId])).toEqual({ status: 'cancelled' });
    expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [pending.runId])).toEqual({ status: 'waiting_approval' });
    failedCheckpoint.mockRestore();

    await runtime.stop();
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({ OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'local-trusted' }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    await runtime.recover();

    const recovered = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
    const state = JSON.parse(recovered!.state_json);
    expect(state.pendingApproval).toBeUndefined();
    expect(state.pendingToolCalls).toEqual([]);
    const toolMessages = state.messages.filter((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === pending.toolCallId);
    expect(toolMessages).toHaveLength(1);
    expect(JSON.parse(toolMessages[0].content).data).toContain(expectedError);
    expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [pending.runId])).toEqual({ status: 'queued' });
    expect(await db.one<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [pending.taskId])).toEqual({ status: 'ready' });
    await expect(readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await runtime.recover();
    const afterRetry = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
    const retriedState = JSON.parse(afterRetry!.state_json);
    expect(retriedState.messages.filter((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === pending.toolCallId)).toHaveLength(1);
    expect(retriedState.pendingApproval).toBeUndefined();
  });

  it('does not start a recovered run until every recovery pass has finished', async () => {
    const pending = await seedApproval({ approvalStatus: 'approved', operationStatus: 'authorized' });
    await runtime.stop();
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({ OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'local-trusted' }));

    let markRecoveryBlocked!: () => void;
    let releaseRecovery!: () => void;
    const recoveryBlocked = new Promise<void>((resolve) => { markRecoveryBlocked = resolve; });
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    let markWorkerStarted!: () => void;
    let releaseWorker!: () => void;
    let workerStarted = false;
    const workerStartedSignal = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const internals = runtime as unknown as {
      recoverUnknownToolOperations(): Promise<void>;
      processRun(runId: string, signal: AbortSignal): Promise<void>;
    };
    internals.recoverUnknownToolOperations = async () => { markRecoveryBlocked(); await recoveryGate; };
    internals.processRun = async () => { workerStarted = true; markWorkerStarted(); await workerGate; };

    const recovery = runtime.recover();
    await recoveryBlocked;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const startedBeforeRecoveryFinished = workerStarted;
    releaseRecovery();
    try {
      await recovery;
      await workerStartedSignal;
      expect(startedBeforeRecoveryFinished).toBe(false);
      expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId])).toEqual({ status: 'succeeded' });
      const checkpoint = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
      const state = JSON.parse(checkpoint!.state_json);
      expect(state.pendingApproval).toBeUndefined();
      expect(state.pendingToolCalls).toEqual([]);
      expect(state.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: pending.toolCallId });
    } finally {
      releaseWorker();
      await runtime.stop();
    }
  });

  it('applies exactly the approved content and resumes the checkpoint', async () => {
    const pending = await seedApproval({ toolId: 'workspace.patch' });

    const result = await runtime.decideApproval(pending.approvalId, 'approve');

    expect(result).toEqual({ status: 'approved', resumed: true });
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe(pending.content);
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId])).toMatchObject({ status: 'succeeded' });
    expect(await projects.getTasks(pending.runId)).toMatchObject([{ id: pending.taskId, status: 'ready' }]);
    const checkpoint = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
    const state = JSON.parse(checkpoint!.state_json);
    expect(state.pendingApproval).toBeUndefined();
    expect(state.pendingToolCalls).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: pending.toolCallId });
    const transitions = await db.all<{ type: string; sequence: number }>(`SELECT type, sequence FROM domain_events WHERE aggregate_id = ? AND type IN ('tool.dispatched','tool.completed') ORDER BY sequence`, [pending.operationId]);
    expect(transitions.map((event) => event.type)).toEqual(['tool.dispatched', 'tool.completed']);
    expect(transitions[0]!.sequence).toBeLessThan(transitions[1]!.sequence);
  });

  it('rejects approval arguments that change after the owner reviewed them', async () => {
    const pending = await seedApproval();
    await db.run('UPDATE approvals SET arguments_json = ? WHERE id = ?', [JSON.stringify({ path: 'attacker.txt', content: 'unreviewed change' }), pending.approvalId]);

    await expect(runtime.decideApproval(pending.approvalId, 'approve')).rejects.toMatchObject({ code: 'APPROVAL_HASH_MISMATCH' });

    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(await readFile(join(workspaceRoot, 'attacker.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(await db.one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', [pending.approvalId])).toMatchObject({ status: 'pending' });
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId])).toMatchObject({ status: 'pending_approval' });
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE aggregate_id = ? AND type IN ('approval.decided','tool.dispatched')", [pending.operationId])).toEqual({ count: 0 });
  });

  it('serializes concurrent decisions so only one is applied', async () => {
    const pending = await seedApproval();

    const [first, second] = await Promise.allSettled([
      runtime.decideApproval(pending.approvalId, 'deny'),
      runtime.decideApproval(pending.approvalId, 'approve'),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') expect(second.reason).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });
    expect(await db.one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', [pending.approvalId])).toMatchObject({ status: 'denied' });
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8').catch(() => null)).toBeNull();
  });

  it('waits for an in-flight non-cancellable tool before committing run cancellation', async () => {
    const project = await projects.createProject({ name: 'Cancel in-flight tool', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Run a slow read tool');
    const runtimeMethods = runtime as unknown as { processRun: (runId: string, signal: AbortSignal) => Promise<void> };
    (runtime.enqueue as unknown as { mockRestore(): void }).mockRestore();
    let markStarted!: () => void;
    let finishTool!: () => void;
    let signalSeen: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const toolGate = new Promise<void>((resolve) => { finishTool = resolve; });
    const operationId = randomUUID();
    runtimeMethods.processRun = async (runId, signal) => {
      signalSeen = signal;
      markStarted();
      await toolGate;
      await db.run(`INSERT INTO tool_operations(id, run_id, task_id, tool_id, arguments_hash, status, created_at, updated_at)
        VALUES (?, ?, NULL, 'research.fetch', ?, 'succeeded', ?, ?)`, [operationId, runId, 'a'.repeat(64), new Date().toISOString(), new Date().toISOString()]);
    };
    runtime.enqueue(request.runId);
    await started;

    let cancellationSettled = false;
    const cancellation = runtime.cancel(request.runId).then((result) => { cancellationSettled = true; return result; });
    await vi.waitFor(() => expect(signalSeen?.aborted).toBe(true), { timeout: 10_000, interval: 10 });
    expect(cancellationSettled).toBe(false);

    finishTool();
    expect(await cancellation).toBe(true);
    expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toMatchObject({ status: 'cancelled' });
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [operationId])).toMatchObject({ status: 'succeeded' });
  });

  it('expires pending approvals atomically when cancelling and rejects later decisions', async () => {
    const pending = await seedApproval();

    const [first, duplicate] = await Promise.all([runtime.cancel(pending.runId), runtime.cancel(pending.runId)]);

    expect(first).toBe(true);
    expect(duplicate).toBe(true);
    expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [pending.runId])).toMatchObject({ status: 'cancelled' });
    expect(await db.one<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [pending.taskId])).toMatchObject({ status: 'cancelled' });
    expect(await db.one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', [pending.approvalId])).toMatchObject({ status: 'expired' });
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId])).toMatchObject({ status: 'cancelled' });
    await expect(runtime.decideApproval(pending.approvalId, 'approve')).rejects.toMatchObject({ code: 'RUN_NOT_ACTIVE' });
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8').catch(() => null)).toBeNull();
  });

  it('reconciles an approved operation after restart without repeating the write', async () => {
    const pending = await seedApproval({ approvalStatus: 'approved', operationStatus: 'authorized' });

    await runtime.recover();
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe(pending.content);
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId])).toMatchObject({ status: 'succeeded' });

    await writeFile(join(workspaceRoot, 'approved.txt'), 'later user change');
    await runtime.recover();
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe('later user change');
  });

  it('reconciles a dispatched write after restart only when exact approved bytes are present', async () => {
    const pending = await seedApproval({ approvalStatus: 'approved', operationStatus: 'dispatched' });
    await writeFile(join(workspaceRoot, 'approved.txt'), pending.content);

    await runtime.recover();

    const operation = await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [pending.operationId]);
    expect(operation?.status).toBe('succeeded');
    expect(JSON.parse(operation!.receipt_json)).toMatchObject({ path: 'approved.txt', action: 'already_applied' });
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe(pending.content);
  });

  it('recovers a real crash after the approved write but before its receipt commit', async () => {
    const pending = await seedApproval();
    const originalTransact = events.transact.bind(events);
    const failReceipt = vi.spyOn(events, 'transact').mockImplementation(async (...args) => {
      if (args[0] === 'tool.completed' && args[1] === pending.operationId) throw new Error('injected crash before receipt commit');
      return originalTransact(...args);
    });

    await expect(runtime.decideApproval(pending.approvalId, 'approve')).rejects.toThrow('injected crash');
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe(pending.content);
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId])).toMatchObject({ status: 'dispatched' });
    failReceipt.mockRestore();

    await runtime.stop();
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({ OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'local-trusted' }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    await runtime.recover();

    const operation = await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [pending.operationId]);
    expect(operation?.status).toBe('succeeded');
    expect(JSON.parse(operation!.receipt_json)).toMatchObject({ path: 'approved.txt', action: 'already_applied' });
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe(pending.content);
  });

  it('recovers a crash after an approved tool receipt commits but before its checkpoint advances', async () => {
    const pending = await seedApproval();
    const methods = runtime as unknown as { saveCheckpoint: (executionId: string, state: unknown) => Promise<void> };
    const failedCheckpoint = vi.spyOn(methods, 'saveCheckpoint').mockRejectedValueOnce(new Error('injected crash before checkpoint commit'));

    await expect(runtime.decideApproval(pending.approvalId, 'approve')).rejects.toThrow('injected crash before checkpoint commit');
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe(pending.content);
    expect(await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [pending.operationId]))
      .toMatchObject({ status: 'succeeded' });
    const interrupted = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
    expect(JSON.parse(interrupted!.state_json).pendingApproval).toBeDefined();
    failedCheckpoint.mockRestore();

    await runtime.stop();
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({ OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'local-trusted' }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    await runtime.recover();

    const recovered = await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [pending.operationId]);
    expect(recovered?.status).toBe('succeeded');
    const checkpoint = await db.one<{ schema_version: number; state_json: string }>('SELECT schema_version, state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
    const state = JSON.parse(checkpoint!.state_json);
    expect(checkpoint?.schema_version).toBe(2);
    expect(state.pendingApproval).toBeUndefined();
    expect(state.pendingToolCalls).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: pending.toolCallId });
    expect(JSON.parse(state.messages.at(-1).content).data).toContain('approved.txt');
    expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe(pending.content);
  });

  it.each([
    ['missing', null],
    ['changed by the user', 'user edit after shutdown'],
  ])('quarantines an ambiguous dispatched write when the file is %s', async (_state, currentContent) => {
    const pending = await seedApproval({ approvalStatus: 'approved', operationStatus: 'dispatched' });
    if (currentContent !== null) await writeFile(join(workspaceRoot, 'approved.txt'), currentContent);

    await runtime.recover();

    const operation = await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId]);
    expect(operation?.status).toBe('outcome_unknown');
    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [pending.runId]))
      .toMatchObject({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
    if (currentContent === null) await expect(readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe(currentContent);
  });

  it('executes only the approved package checks in a temporary snapshot', async () => {
    await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({
      name: 'runtime-check-fixture',
      scripts: { verify: 'node -e "require(\'fs\').writeFileSync(\'only-in-snapshot.txt\',\'ok\'); console.log(\'check-evidence\')"' },
    }));
    await writeFile(join(workspaceRoot, '.env'), 'MODEL_PRIMARY_API_KEY=sentinel-must-not-leak');
    const proposal = await prepareWorkspaceChecks(workspaceRoot, ['verify']);
    const pending = await seedApproval({ toolId: 'workspace.run_checks', argumentsJson: JSON.stringify(proposal) });

    const result = await runtime.decideApproval(pending.approvalId, 'approve');

    expect(result).toEqual({ status: 'approved', resumed: true });
    const operation = await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [pending.operationId]);
    expect(operation?.status).toBe('succeeded');
    expect(JSON.parse(operation!.receipt_json)).toMatchObject({
      passed: true,
      snapshot: { isolated: true },
      checks: [{ name: 'verify', outcome: 'passed', stdout: expect.stringContaining('check-evidence') }],
    });
    expect(operation!.receipt_json).not.toContain('sentinel-must-not-leak');
    await expect(readFile(join(workspaceRoot, 'only-in-snapshot.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await projects.getTasks(pending.runId)).toMatchObject([{ id: pending.taskId, status: 'ready' }]);
  });

  it('does not rerun an approved script after restart when its outcome is unknown', async () => {
    const pending = await seedApproval({ toolId: 'workspace.run_checks', approvalStatus: 'approved', operationStatus: 'authorized', argumentsJson: JSON.stringify({ packageName: 'unknown', packageChecksum: 'a'.repeat(64), checks: [{ name: 'test', command: 'danger', lifecycle: [] }] }) });

    await runtime.recover();

    const operation = await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [pending.operationId]);
    expect(operation?.status).toBe('outcome_unknown');
    expect(operation?.receipt_json).toContain('không chạy lại tự động');
    expect(await projects.getTasks(pending.runId)).toMatchObject([{ id: pending.taskId, status: 'ready' }]);
  });

  it('recovers a shutdown during approved checks without leaving a pending checkpoint or rerunning the check', async () => {
    const invocationMarker = join(dataDir, 'check-invocations.txt');
    const markerLiteral = invocationMarker.replaceAll('\\', '/').replaceAll("'", "\\'");
    const command = `node -e "require('fs').appendFileSync('${markerLiteral}', 'x'); setTimeout(() => {}, 15000)"`;
    await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({
      name: 'runtime-check-shutdown-fixture',
      scripts: { verify: command },
    }));
    const proposal = await prepareWorkspaceChecks(workspaceRoot, ['verify']);
    const pending = await seedApproval({ toolId: 'workspace.run_checks', argumentsJson: JSON.stringify(proposal) });
    const decision = runtime.decideApproval(pending.approvalId, 'approve');
    const internals = runtime as unknown as { approvalControllers: Map<string, AbortController> };
    await vi.waitFor(() => expect(internals.approvalControllers.has(pending.runId)).toBe(true), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await readFile(invocationMarker, 'utf8')).toBe('x'), { timeout: 10_000 });

    await runtime.stop();
    await expect(decision).resolves.toMatchObject({ status: 'cancelled', resumed: false });
    expect(await db.one<{ status: string }>('SELECT status FROM tool_operations WHERE id = ?', [pending.operationId])).toMatchObject({ status: 'outcome_unknown' });
    const interrupted = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
    expect(JSON.parse(interrupted!.state_json).pendingApproval).toBeDefined();

    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({ OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'local-trusted' }));
    vi.spyOn(runtime, 'enqueue').mockImplementation(() => undefined);
    await runtime.recover();

    const recovered = await db.one<{ status: string; receipt_json: string }>('SELECT status, receipt_json FROM tool_operations WHERE id = ?', [pending.operationId]);
    expect(recovered?.status).toBe('outcome_unknown');
    expect(JSON.parse(recovered!.receipt_json)).toMatchObject({ cancelled: true, passed: false });
    const checkpoint = await db.one<{ state_json: string }>('SELECT state_json FROM checkpoints WHERE execution_id = ? ORDER BY position DESC LIMIT 1', [pending.taskId]);
    expect(JSON.parse(checkpoint!.state_json).pendingApproval).toBeUndefined();
    expect(JSON.parse(checkpoint!.state_json).messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: pending.toolCallId });
    expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [pending.runId])).toMatchObject({ status: 'queued' });
    expect(await readFile(invocationMarker, 'utf8')).toBe('x');
  }, 15_000);

  async function seedApproval(input: { expiresAt?: string; approvalStatus?: 'pending' | 'approved'; operationStatus?: 'pending_approval' | 'authorized' | 'dispatched'; toolId?: 'workspace.write' | 'workspace.patch' | 'workspace.run_checks'; argumentsJson?: string } = {}) {
    const project = await projects.createProject({ name: 'Approval test', goal: '', workspaceRoot });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Create the approved file');
    const taskId = randomUUID();
    const operationId = randomUUID();
    const approvalId = randomUUID();
    const toolCallId = 'call-approved-write';
    const content = 'approved content';
    const storedArguments = input.argumentsJson ?? JSON.stringify({ path: 'approved.txt', content });
    const argumentsHash = createHash('sha256').update(storedArguments).digest('hex');
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
    await db.batch([
      { mode: 'run', sql: `INSERT INTO tasks(id, run_id, task_key, kind, title, objective, required_capabilities_json, status, created_at, updated_at)
        VALUES (?, ?, 'write', 'specialist', 'Write approved file', 'Write exact approved content', '["software-development"]', 'waiting_approval', ?, ?)`, params: [taskId, request.runId, now, now] },
      { mode: 'run', sql: `INSERT INTO tool_operations(id, run_id, task_id, tool_id, arguments_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, params: [operationId, request.runId, taskId, input.toolId ?? 'workspace.write', argumentsHash, input.operationStatus ?? 'pending_approval', now, now] },
      { mode: 'run', sql: `INSERT INTO approvals(id, project_id, run_id, task_id, operation_id, summary, arguments_json, arguments_hash, status, expires_at, decided_at)
        VALUES (?, ?, ?, ?, ?, 'Create approved.txt', ?, ?, ?, ?, ?)`, params: [approvalId, project.id, request.runId, taskId, operationId, storedArguments, argumentsHash, input.approvalStatus ?? 'pending', expiresAt, input.approvalStatus === 'approved' ? now : null] },
      { mode: 'run', sql: `INSERT INTO checkpoints(id, execution_id, position, state_json, schema_version, created_at)
        VALUES (?, ?, 1, ?, 2, ?)`, params: [randomUUID(), taskId, JSON.stringify({ schemaVersion: 2, definitionId: 'developer', messages: [{ role: 'assistant', content: 'Writing file' }], nextTurn: 1, totalToolCalls: 1, pendingToolCalls: [{ operationId, toolCallId, toolName: input.toolId ?? 'workspace.write' }], pendingApproval: { operationId, approvalId, toolCallId } }), now] },
    ], true);
    await projects.updateRun(request.runId, 'waiting_approval');
    return { runId: request.runId, taskId, operationId, approvalId, toolCallId, content };
  }
});

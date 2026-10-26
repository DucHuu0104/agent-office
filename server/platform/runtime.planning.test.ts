import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry, previewRegistryAdditions } from './registry';
import { AgentRuntime } from './runtime';
import type { ChatCompletion, ModelGateway, ModelRequest } from './models/types';

describe('runtime rejects invalid plans before dispatch', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let events: EventHub;
  let projects: ProjectService;
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  let runtime: AgentRuntime | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let currentPlan: Record<string, unknown>;
  let directPlanAnswerText: string | null;
  let clarificationQuestion: string | null;
  let plannedResponses: Record<string, unknown>[];
  let plannedToolNames: string[];
  let rawPlanResponses: string[];
  let coordinatorSummaryText: string;
  let coordinatorSummaryResponses: string[];
  let coordinatorSummarySystems: string[];
  let planCapabilityOptions: string[][];
  let lastCoordinatorPlanningToolChoice: unknown;
  let requestCount = 0;
  let planRequestCount = 0;
  let specialistToolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  let blockNextSpecialist = false;
  let lastCoordinatorPlanningSystem = '';
  let lastCoordinatorSummarySystem = '';
  let specialistStarted: Promise<void>;
  let markSpecialistStarted: () => void;
  let specialistGate: Promise<void>;
  let releaseSpecialist: () => void;
  let lastSpecialistSystemText = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-invalid-plan-'));
    db = await DatabaseClient.open(dataDir, true);
    events = new EventHub(db);
    registry = await loadRegistry(process.cwd());
    projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    requestCount = 0;
    planRequestCount = 0;
    specialistToolCalls = [];
    plannedResponses = [];
    plannedToolNames = [];
    rawPlanResponses = [];
    directPlanAnswerText = null;
    clarificationQuestion = null;
    coordinatorSummaryText = 'The corrected plan was accepted.';
    coordinatorSummaryResponses = [];
    coordinatorSummarySystems = [];
    planCapabilityOptions = [];
    lastCoordinatorPlanningToolChoice = undefined;
    blockNextSpecialist = false;
    lastCoordinatorPlanningSystem = '';
    lastCoordinatorSummarySystem = '';
    lastSpecialistSystemText = '';
    specialistStarted = new Promise((resolve) => { markSpecialistStarted = resolve; });
    specialistGate = new Promise((resolve) => { releaseSpecialist = resolve; });

    server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', async () => {
        requestCount++;
        const payload = JSON.parse(raw) as {
          tools?: Array<{ function?: { name?: string; parameters?: unknown } }>;
          tool_choice?: unknown;
          messages?: Array<{ role?: string; content?: string | null }>;
        };
        if (!payload.tools?.some((tool) => tool.function?.name === 'submit_plan')) {
          if (!payload.tools?.length) {
            lastCoordinatorSummarySystem = payload.messages?.find((message) => message.role === 'system')?.content ?? '';
            coordinatorSummarySystems.push(lastCoordinatorSummarySystem);
          }
          if (blockNextSpecialist) {
            blockNextSpecialist = false;
            lastSpecialistSystemText = payload.messages?.find((message) => message.role === 'system')?.content ?? '';
            markSpecialistStarted();
            await specialistGate;
          }
          const nextSpecialistCall = specialistToolCalls[0];
          if (payload.tools?.length && nextSpecialistCall && payload.tools.some((tool) => tool.function?.name === nextSpecialistCall.name)) {
            specialistToolCalls.shift();
            const id = `specialist-tool-${requestCount}`;
            const chunks = [
              { id, choices: [{ delta: { tool_calls: [{ index: 0, id: `${id}-call`, type: 'function', function: { name: nextSpecialistCall.name, arguments: JSON.stringify(nextSpecialistCall.arguments) } }] }, finish_reason: null }] },
              { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
            ];
            response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
            return;
          }
          const id = `summary-${requestCount}`;
          const content = payload.tools?.length ? 'The specialist completed the requested work.' : coordinatorSummaryResponses.shift() ?? coordinatorSummaryText;
          const chunks = [
            { id, choices: [{ delta: { content }, finish_reason: null }] },
            { id, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
          ];
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
          return;
        }
        const planParameters = payload.tools?.find((tool) => tool.function?.name === 'submit_plan')?.function?.parameters as {
          properties?: { tasks?: { items?: { properties?: { capability?: { enum?: string[] } } } } };
        } | undefined;
        lastCoordinatorPlanningSystem = payload.messages?.find((message) => message.role === 'system')?.content ?? '';
        lastCoordinatorPlanningToolChoice = payload.tool_choice;
        const capabilityEnum = planParameters?.properties?.tasks?.items?.properties?.capability?.enum;
        if (capabilityEnum) planCapabilityOptions.push(capabilityEnum);
        planRequestCount++;
        if (clarificationQuestion !== null && payload.tools?.some((tool) => tool.function?.name === 'request_clarification')) {
          const id = `clarification-${requestCount}`;
          const chunks = [
            { id, choices: [{ delta: { tool_calls: [{ index: 0, id: `${id}-call`, type: 'function', function: { name: 'request_clarification', arguments: JSON.stringify({ question: clarificationQuestion }) } }] }, finish_reason: null }] },
            { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
          ];
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
          return;
        }
        if (directPlanAnswerText !== null) {
          const id = `direct-answer-${requestCount}`;
          const chunks = [
            { id, choices: [{ delta: { content: directPlanAnswerText }, finish_reason: null }] },
            { id, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 } },
          ];
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
          return;
        }
        const plan = plannedResponses.shift() ?? currentPlan;
        const rawPlan = rawPlanResponses.shift();
        const id = `plan-${requestCount}`;
        const chunks = [
          { id, choices: [{ delta: { tool_calls: [{ index: 0, id: `${id}-call`, type: 'function', function: { name: plannedToolNames.shift() ?? 'submit_plan', arguments: rawPlan ?? JSON.stringify(plan) } }] }, finish_reason: null }] },
          { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
        ];
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
      OFFICE_DATA_DIR: dataDir,
      OFFICE_CONFIG_DIR: process.cwd(),
      MODEL_PRIMARY_BASE_URL: baseUrl,
      MODEL_PRIMARY_API_KEY: 'invalid-plan-test-key',
      MODEL_PRIMARY_NAME: 'fake-plan-model',
    }));
  });

  afterEach(async () => {
    releaseSpecialist?.();
    await runtime?.stop();
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await db?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('fails cyclic, unsupported-capability, duplicate-key and over-limit plans without persisting work', async () => {
    const capability = registry.definitions.get('writer')!.manifest.capabilities[0]!;
    const criteria = { goal: 'Verify rejection before dispatch.', successCriteria: ['No invalid task is persisted.'], responseToUser: '' };
    const makeTask = (key: string, taskCapability = capability, dependsOn: string[] = []) => ({
      key, title: `Task ${key}`, objective: `Complete ${key}.`, capability: taskCapability, dependsOn,
    });
    const invalidPlans: Array<{ name: string; plan: Record<string, unknown> }> = [
      { name: 'cycle', plan: { ...criteria, tasks: [makeTask('first', capability, ['second']), makeTask('second', capability, ['first'])] } },
      { name: 'unsupported capability', plan: { ...criteria, tasks: [makeTask('unsupported', 'capability.not-registered')] } },
      { name: 'duplicate task key', plan: { ...criteria, tasks: [makeTask('duplicate'), makeTask('duplicate')] } },
      { name: 'over-limit', plan: { ...criteria, tasks: Array.from({ length: 13 }, (_, index) => makeTask(`task-${index}`)) } },
    ];

    for (const invalid of invalidPlans) {
      currentPlan = invalid.plan;
      plannedResponses = [invalid.plan, invalid.plan, invalid.plan];
      const project = await projects.createProject({ name: `Invalid plan ${invalid.name}`, goal: '' });
      const request = await projects.createUserMessage(project.id, project.conversationId, `Test ${invalid.name}.`);
      runtime!.enqueue(request.runId);
      await vi.waitFor(async () => {
        expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'failed' });
      }, { timeout: 20_000 });

      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)', [request.runId])).toEqual({ count: 0 });
      expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
    }

    expect(planRequestCount).toBe(invalidPlans.length * 3);
    expect(requestCount).toBe(invalidPlans.length * 3);
    expect(planCapabilityOptions).toHaveLength(planRequestCount);
    expect(planCapabilityOptions.every((capabilities) => capabilities.includes(capability) && !capabilities.includes('capability.not-registered'))).toBe(true);
  });

  it('accepts a corrected plan after one automatic repair without dispatching invalid work', async () => {
    const capability = registry.definitions.get('writer')!.manifest.capabilities[0]!;
    const invalidPlan = {
      goal: 'Verify repair before dispatch.',
      successCriteria: ['Only a validated plan is accepted.'],
      tasks: [
        { key: 'first', title: 'First', objective: 'First task.', capability, dependsOn: ['second'] },
        { key: 'second', title: 'Second', objective: 'Second task.', capability, dependsOn: ['first'] },
      ],
    };
    const correctedPlan = {
      goal: 'Verify repair before dispatch.',
      successCriteria: ['Only a validated plan is accepted.'],
      tasks: [],
      responseToUser: 'The corrected plan is accepted.',
    };
    plannedResponses = [invalidPlan, correctedPlan];
    const project = await projects.createProject({ name: 'Repaired plan', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Repair the invalid plan.');
    runtime!.enqueue(request.runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });

    expect(planRequestCount).toBe(2);
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)', [request.runId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
    expect(lastCoordinatorPlanningSystem).toContain('assign one specialist task with a direct deliverable');
    expect(lastCoordinatorPlanningSystem).toContain('Add a synthesis task only when it must integrate meaningful independent outputs');
    expect(lastCoordinatorPlanningSystem).toContain('submit_plan is your only callable tool');
    expect(lastCoordinatorSummarySystem).toBe('');
  });

  it('waits for an essential clarification before creating or assigning specialist work', async () => {
    const question = 'What should the helper calculate, and what function signature should it expose?';
    clarificationQuestion = question;
    const project = await projects.createProject({ name: 'Clarification before delegation', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Add a helper to src/helper.ts.');
    runtime!.enqueue(request.runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
        .toEqual({ status: 'waiting_approval', error_code: 'WAITING_FOR_USER_INPUT' });
    }, { timeout: 5_000 });

    expect(requestCount).toBe(1);
    expect(planRequestCount).toBe(1);
    expect(lastCoordinatorPlanningSystem).toContain('If an action needs a specific behavior or output contract');
    expect(lastCoordinatorPlanningSystem).toContain('"add a helper" does not say what the helper should do');
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM assignments WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)', [request.runId])).toEqual({ count: 0 });
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tool_operations WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
    const historyAfterQuestion = await projects.listMessages(project.conversationId, 20);
    expect(historyAfterQuestion.map((message) => message.content)).toEqual([
      'Add a helper to src/helper.ts.',
      question,
    ]);

    clarificationQuestion = null;
    currentPlan = { goal: 'Add a sum helper.', successCriteria: ['The user has specified the desired behavior.'], tasks: [], responseToUser: 'I will add the requested sum helper.' };
    const answer = await projects.createUserMessage(project.id, project.conversationId, 'Export sum(a, b) and return a + b.', undefined, 'enqueue');
    runtime!.enqueue(answer.runId);
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [answer.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });
    expect(requestCount).toBe(2);
    const resumedRun = await projects.runForMessage(answer.runId);
    const resumedContext = await projects.projectContext(project.id, resumedRun!.requestSequence);
    expect(resumedContext?.history.map((message) => message.content)).toEqual([
      'Add a helper to src/helper.ts.',
      question,
      'Export sum(a, b) and return a + b.',
    ]);
  }, 12_000);

  it('repairs an unavailable specialist tool call by directing the Coordinator back to submit_plan', async () => {
    const repairedPlan = {
      goal: 'Correct the typo in the project files.',
      successCriteria: ['A specialist task is submitted with its allowed tools.'],
      responseToUser: 'I have prepared the task for a specialist.',
      tasks: [],
    };
    currentPlan = repairedPlan;
    plannedToolNames = ['workspace.read', 'submit_plan'];
    const project = await projects.createProject({ name: 'Unavailable Coordinator tool', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Fix the typo using workspace.read and workspace.patch.');

    runtime!.enqueue(request.runId);
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });

    expect(planRequestCount).toBe(2);
    expect(lastCoordinatorPlanningSystem).toContain('PLAN_TOOL_MISSING');
    expect(lastCoordinatorPlanningSystem).toContain('Only submit_plan is available to the Coordinator');
    expect(lastCoordinatorPlanningSystem).toContain('Tool IDs mentioned in the user request are constraints');
    expect(lastCoordinatorPlanningToolChoice).toEqual({ type: 'function', function: { name: 'submit_plan' } });
    expect(lastCoordinatorPlanningSystem).not.toContain('workspace.read');
    expect(await db.one<{ count: number }>('SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?', [request.runId])).toEqual({ count: 0 });
    const repairEvent = await db.one<{ payload_json: string }>(
      "SELECT payload_json FROM domain_events WHERE type = 'coordinator.plan_repair_attempted' AND aggregate_id = ?", [request.runId],
    );
    expect(repairEvent?.payload_json).toContain('PLAN_TOOL_MISSING');
    expect(repairEvent?.payload_json).not.toContain('workspace.read');
  }, 8_000);

  it('repairs incomplete Coordinator tool arguments before persisting a plan or starting specialist work', async () => {
    const capability = registry.definitions.get('writer')!.manifest.capabilities[0]!;
    currentPlan = {
      goal: 'Write one concise introduction.',
      successCriteria: ['A short introduction is saved as the task output.'],
      responseToUser: 'The writing task is ready.',
      tasks: [{ key: 'introduction', title: 'Draft an introduction', objective: 'Write a short project introduction.', capability, dependsOn: [] }],
    };
    rawPlanResponses = ['{"goal":"truncated'];
    plannedResponses = [currentPlan];
    const project = await projects.createProject({ name: 'Malformed plan repair', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Write a brief introduction.');

    runtime!.enqueue(request.runId);
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 8_000 });

    expect(planRequestCount).toBe(2);
    expect(requestCount).toBe(4);
    expect(lastCoordinatorPlanningSystem).toContain('PLAN_JSON_INVALID');
    expect(await db.one<{ plan_revision: number }>('SELECT plan_revision FROM runs WHERE id = ?', [request.runId])).toEqual({ plan_revision: 1 });
    expect(await projects.getTasks(request.runId)).toMatchObject([{ key: 'introduction', status: 'succeeded' }]);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM domain_events WHERE type = 'run.plan_revised' AND aggregate_id = ?", [request.runId])).toEqual({ count: 1 });
    expect(await db.all<{ status: string; count: number }>('SELECT status, COUNT(*) AS count FROM model_call_reservations WHERE run_id = ? GROUP BY status ORDER BY status', [request.runId]))
      .toEqual([{ status: 'settled', count: 4 }]);
  }, 12_000);

  it('includes safe field paths in plan repair feedback without echoing rejected values', async () => {
    const capability = registry.definitions.get('writer')!.manifest.capabilities[0]!;
    const invalidPlan = {
      goal: 'Write one concise introduction.',
      successCriteria: ['A short introduction is saved as the task output.'],
      tasks: [{ key: 'introduction', title: 'Draft an introduction', objective: 'Write a short project introduction.', capability, dependsOn: 'SECRET_REJECTED_VALUE' }],
    };
    currentPlan = {
      goal: 'Write one concise introduction.',
      successCriteria: ['A short introduction is saved as the task output.'],
      responseToUser: 'The writing task is ready.',
      tasks: [{ key: 'introduction', title: 'Draft an introduction', objective: 'Write a short project introduction.', capability, dependsOn: [] }],
    };
    plannedResponses = [invalidPlan, currentPlan];
    const project = await projects.createProject({ name: 'Safe plan repair details', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Write a brief introduction.');

    runtime!.enqueue(request.runId);
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 8_000 });

    expect(planRequestCount).toBe(2);
    expect(lastCoordinatorPlanningSystem).toContain('PLAN_SCHEMA_INVALID');
    expect(lastCoordinatorPlanningSystem).toContain('tasks[0].dependsOn (invalid_type)');
    expect(lastCoordinatorPlanningSystem).toContain('submitted values are omitted');
    expect(lastCoordinatorPlanningSystem).not.toContain('SECRET_REJECTED_VALUE');
    expect(await db.one<{ plan_revision: number }>('SELECT plan_revision FROM runs WHERE id = ?', [request.runId])).toEqual({ plan_revision: 1 });
    const repairEvent = await db.one<{ payload_json: string }>(
      "SELECT payload_json FROM domain_events WHERE type = 'coordinator.plan_repair_attempted' AND aggregate_id = ?", [request.runId],
    );
    expect(repairEvent?.payload_json).toContain('PLAN_SCHEMA_INVALID');
    expect(repairEvent?.payload_json).toContain('tasks[0].dependsOn (invalid_type)');
    expect(repairEvent?.payload_json).not.toContain('SECRET_REJECTED_VALUE');
  }, 12_000);

  it('uses a direct Coordinator answer as-is without a second summary call', async () => {
    directPlanAnswerText = 'Có 3 bản ghi; 1 điểm còn trống. Điểm 0 được tính là giá trị hiện diện.';
    const project = await projects.createProject({ name: 'Direct Coordinator answer', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'How many records and missing scores?');
    runtime!.enqueue(request.runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });

    expect(planRequestCount).toBe(1);
    expect(requestCount).toBe(1);
    expect(lastCoordinatorSummarySystem).toBe('');
    expect(await db.all('SELECT id FROM tasks WHERE run_id = ?', [request.runId])).toEqual([]);
    expect(await db.one<{ content: string }>(
      "SELECT content FROM messages WHERE run_id = ? AND speaker = 'coordinator' ORDER BY created_at DESC LIMIT 1", [request.runId],
    )).toEqual({ content: directPlanAnswerText });
  });

  it('repairs progress-only Coordinator summaries before showing the final answer', async () => {
    const capability = registry.definitions.get('analyst')!.manifest.capabilities[0]!;
    currentPlan = {
      goal: 'Summarize measurements.',
      successCriteria: ['The final answer includes both numeric counts, sums and missing counts.'],
      tasks: [{ key: 'summary', title: 'Summarize measurements', objective: 'Compute the requested CSV summary.', capability, dependsOn: [] }],
    };
    const expectedFinalAnswer = 'Measurements có 3 hàng. Cột x có 2 giá trị số, thiếu 1, tổng bằng 4; cột y có 2 giá trị số, thiếu 1, tổng bằng 6.';
    coordinatorSummaryResponses = [
      'Đã gọi công cụ phân tích. Hãy để tôi kiểm tra kết quả.',
      expectedFinalAnswer,
    ];
    const transient = vi.spyOn(events, 'transient');
    const project = await projects.createProject({ name: 'Final response repair', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Summarize measurements and report missing counts separately from numeric count.');
    runtime!.enqueue(request.runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });

    const finalMessage = await db.one<{ content: string }>(
      "SELECT content FROM messages WHERE run_id = ? AND speaker = 'coordinator' ORDER BY created_at DESC LIMIT 1", [request.runId],
    );
    const coordinatorId = (await db.one<{ coordinator_id: string }>('SELECT instance_id AS coordinator_id FROM coordinator_bindings WHERE project_id = ?', [project.id]))!.coordinator_id;
    const coordinatorDeltas = transient.mock.calls
      .filter(([type, payload]) => type === 'message.delta' && (payload as { agentInstanceId?: string }).agentInstanceId === coordinatorId)
      .map(([, payload]) => (payload as { delta: string }).delta);

    expect(coordinatorSummarySystems).toHaveLength(2);
    expect(coordinatorSummarySystems[0]).toContain('Atenda todas as partes do pedido');
    expect(coordinatorSummarySystems[1]).toContain('Lượt trước chỉ mô tả tiến độ');
    expect(finalMessage?.content).toBe(expectedFinalAnswer);
    expect(coordinatorDeltas).toEqual([expectedFinalAnswer]);
    expect(coordinatorDeltas.join('')).not.toContain('Đã gọi công cụ phân tích');
  });

  it('repairs markdown tool-call syntax in a Coordinator final answer', async () => {
    const capability = registry.definitions.get('analyst')!.manifest.capabilities[0]!;
    currentPlan = {
      goal: 'Summarize sales.',
      successCriteria: ['The user receives the computed summary.'],
      tasks: [{ key: 'summary', title: 'Summarize sales', objective: 'Compute requested statistics.', capability, dependsOn: [] }],
    };
    const expectedFinalAnswer = 'sales.csv has 3 rows. Revenue count is 2, missing count is 1, and the sum is 30.';
    coordinatorSummaryResponses = [
      'Tôi sẽ phân tích file sales.csv.\n```analysis.csv_summary\nfile_path=sales.csv\nnumeric_columns=[revenue]\n```',
      expectedFinalAnswer,
    ];
    const project = await projects.createProject({ name: 'Tool syntax repair', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Summarize revenue and missing values.');
    runtime!.enqueue(request.runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });

    const finalMessage = await db.one<{ content: string }>(
      "SELECT content FROM messages WHERE run_id = ? AND speaker = 'coordinator' ORDER BY created_at DESC LIMIT 1", [request.runId],
    );
    expect(coordinatorSummarySystems).toHaveLength(2);
    expect(finalMessage?.content).toBe(expectedFinalAnswer);
    expect(finalMessage?.content).not.toContain('analysis.csv_summary');
  });

  it('filters private reasoning from runtime deltas and the persisted Coordinator answer', async () => {
    const chunks = ['The answer is ', '<|think', 'ing|>private segment', '<|/thinking|>42.'];
    const gateway: ModelGateway = {
      assertConfigured: () => undefined,
      complete: async (input: ModelRequest): Promise<ChatCompletion> => {
        for (const chunk of chunks) input.onTextDelta?.(chunk);
        return {
          id: 'runtime-reasoning-filter', content: chunks.join(''), toolCalls: [], finishReason: 'stop',
          usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
        };
      },
    };
    const runtimeInternals = runtime as unknown as { gateway: (profileId: string, outputTokens?: number) => ModelGateway };
    runtimeInternals.gateway = () => gateway;
    const transient = vi.spyOn(events, 'transient');
    const project = await projects.createProject({ name: 'Private reasoning filter', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Answer with a simple result.');

    runtime!.enqueue(request.runId);
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });

    const finalMessage = await db.one<{ content: string }>(
      "SELECT content FROM messages WHERE run_id = ? AND speaker = 'coordinator' ORDER BY created_at DESC LIMIT 1", [request.runId],
    );
    const deltas = transient.mock.calls
      .filter(([type]) => type === 'message.delta')
      .map(([, payload]) => (payload as { delta: string }).delta)
      .join('');

    expect(finalMessage?.content).toBe('The answer is 42.');
    expect(deltas).toBe('The answer is 42.');
    expect(JSON.stringify({ finalMessage, deltas })).not.toContain('private segment');
  });

  it('hides tool protocol markup from the final conversation and falls back to the specialist deliverable', async () => {
    const capability = registry.definitions.get('writer')!.manifest.capabilities[0]!;
    currentPlan = {
      goal: 'Produce a readable final answer.',
      successCriteria: ['The conversation contains the specialist deliverable, not tool syntax.'],
      tasks: [{ key: 'draft', title: 'Draft result', objective: 'Write the requested result.', capability, dependsOn: [] }],
    };
    coordinatorSummaryText = '<tool_call>\n<parameter=command>\nartifacts.create\n</parameter>\n</tool_call>';
    const project = await projects.createProject({ name: 'Readable summary', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Write a short result.');
    runtime!.enqueue(request.runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });

    const finalMessage = await db.one<{ content: string }>(
      "SELECT content FROM messages WHERE run_id = ? AND speaker = 'coordinator' ORDER BY created_at DESC LIMIT 1", [request.runId],
    );
    expect(finalMessage?.content).toContain('The specialist completed the requested work.');
    expect(finalMessage?.content).not.toContain('<tool_call>');
    expect(lastCoordinatorSummarySystem).toContain('Não chame nem descreva ferramentas usando sintaxe de protocolo');
  });

  it('preserves computed CSV metrics in the Analyst result, artifact, and final Coordinator answer', async () => {
    currentPlan = {
      goal: 'Summarize measurements accurately.',
      successCriteria: ['Each numeric column includes count, missing, sum, average, minimum, and maximum.'],
      tasks: [{ key: 'measurements', title: 'Summarize measurements', objective: 'Summarize the supplied CSV and create a report artifact.', capability: 'data.analyze', dependsOn: [] }],
    };
    specialistToolCalls = [
      { name: 'summarize_csv', arguments: { csvContent: 'x,y\n1,2\n,4\n3,\n' } },
      { name: 'create_artifact', arguments: { name: 'measurements_analysis.md', content: 'The numeric counts are two for both columns.' } },
    ];
    coordinatorSummaryText = 'There are two numeric observations per column.';
    const project = await projects.createProject({ name: 'Verified CSV summary', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Analyze the measurements and give me a report.');
    runtime!.enqueue(request.runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });

    const task = await db.one<{ output: string }>("SELECT output FROM tasks WHERE run_id = ? AND task_key = 'measurements'", [request.runId]);
    const finalMessage = await db.one<{ content: string }>(
      "SELECT content FROM messages WHERE run_id = ? AND speaker = 'coordinator' ORDER BY created_at DESC LIMIT 1", [request.runId],
    );
    const artifacts = new ArtifactService(db, events, dataDir);
    const artifact = (await artifacts.list(project.id)).find((entry) => entry.logicalName === 'measurements_analysis.md');
    const artifactContent = artifact ? (await artifacts.content(artifact.versionId))?.content.toString('utf8') : undefined;
    const expectedRows = ['| x | 2 | 1 | 4 | 2 | 1 | 3 |', '| y | 2 | 1 | 6 | 3 | 2 | 4 |'];

    for (const content of [task?.output, artifactContent, finalMessage?.content]) {
      expect(content).toContain('Resumo CSV verificado pelo Agent Office');
      expect(content).toContain('Linhas de dados: 3');
      for (const row of expectedRows) expect(content).toContain(row);
    }
    expect(lastCoordinatorSummarySystem).toContain('a plataforma anexará automaticamente');
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM tool_operations WHERE task_id = (SELECT id FROM tasks WHERE run_id = ? AND task_key = 'measurements') AND tool_id = 'artifacts.create' AND status = 'succeeded'", [request.runId]))
      .toEqual({ count: 1 });
  });

  it('does not lease a dependent Reviewer until the Developer task succeeds', async () => {
    const plan = {
      goal: 'Verify dependency-gated assignment.',
      successCriteria: ['Review starts only after implementation succeeds.'],
      tasks: [
        { key: 'implementation', title: 'Implement', objective: 'Complete the implementation.', capability: 'code.implement', dependsOn: [] },
        { key: 'review', title: 'Review', objective: 'Review the completed implementation.', capability: 'code.review', dependsOn: ['implementation'] },
      ],
    };
    currentPlan = plan;
    blockNextSpecialist = true;
    const project = await projects.createProject({ name: 'Dependency scheduling', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Implement then review.');
    runtime!.enqueue(request.runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>("SELECT status FROM runs WHERE id = ?", [request.runId])).toMatchObject({ status: 'executing' });
    }, { timeout: 5_000 });
    await vi.waitFor(() => expect(planRequestCount).toBe(1), { timeout: 5_000 });
    await Promise.race([
      specialistStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Developer did not start.')), 5_000)),
    ]);

    const states = await db.all<{ task_key: string; status: string; assigned_agent_id: string | null }>(
      'SELECT task_key, status, assigned_agent_id FROM tasks WHERE run_id = ? ORDER BY task_key', [request.runId],
    );
    expect(states).toEqual([
      { task_key: 'implementation', status: 'running', assigned_agent_id: expect.any(String) },
      { task_key: 'review', status: 'blocked_dependencies', assigned_agent_id: null },
    ]);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE t.run_id = ? AND t.task_key = 'review'", [request.runId]))
      .toEqual({ count: 0 });

    releaseSpecialist();
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });
    expect(await db.all<{ task_key: string; status: string }>(
      'SELECT task_key, status FROM tasks WHERE run_id = ? ORDER BY task_key', [request.runId],
    )).toEqual([
      { task_key: 'implementation', status: 'succeeded' },
      { task_key: 'review', status: 'succeeded' },
    ]);
    expect(await db.one<{ count: number }>("SELECT COUNT(*) AS count FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE t.run_id = ? AND t.task_key = 'review'", [request.runId]))
      .toEqual({ count: 1 });
  });

  it('pauses at the current task checkpoint without dispatching its dependent task, then resumes it', async () => {
    const capability = registry.definitions.get('writer')!.manifest.capabilities[0]!;
    currentPlan = {
      goal: 'Verify a user pause at a safe checkpoint.',
      successCriteria: ['The active task completes, the next task waits, and resume continues the plan.'],
      tasks: [
        { key: 'first', title: 'First task', objective: 'Complete the first task.', capability, dependsOn: [] },
        { key: 'second', title: 'Second task', objective: 'Complete after the first task.', capability, dependsOn: ['first'] },
      ],
    };
    blockNextSpecialist = true;
    const project = await projects.createProject({ name: 'Safe pause', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Complete both tasks in order.');
    runtime!.enqueue(request.runId);
    await Promise.race([
      specialistStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Writer did not start.')), 5_000)),
    ]);

    const executing = await db.one<{ version: number; status: string }>('SELECT version, status FROM runs WHERE id = ?', [request.runId]);
    expect(executing?.status).toBe('executing');
    await expect(runtime!.pause(request.runId, executing!.version)).resolves.toMatchObject({ status: 'pausing' });
    releaseSpecialist();

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string; error_code: string | null; pause_requested: number }>(
        'SELECT status, error_code, pause_requested FROM runs WHERE id = ?', [request.runId],
      )).toEqual({ status: 'paused', error_code: 'USER_PAUSED', pause_requested: 0 });
    }, { timeout: 5_000 });
    expect(await db.all<{ task_key: string; status: string }>(
      'SELECT task_key, status FROM tasks WHERE run_id = ? ORDER BY task_key', [request.runId],
    )).toEqual([
      { task_key: 'first', status: 'succeeded' },
      { task_key: 'second', status: 'blocked_dependencies' },
    ]);

    const paused = await db.one<{ version: number }>('SELECT version FROM runs WHERE id = ?', [request.runId]);
    await expect(runtime!.resume(request.runId, paused!.version)).resolves.toMatchObject({ status: 'queued' });
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });
    expect(await db.all<{ task_key: string; status: string }>(
      'SELECT task_key, status FROM tasks WHERE run_id = ? ORDER BY task_key', [request.runId],
    )).toEqual([
      { task_key: 'first', status: 'succeeded' },
      { task_key: 'second', status: 'succeeded' },
    ]);
  });

  it('pauses a queued run immediately and rejects stale lifecycle versions', async () => {
    currentPlan = {
      goal: 'Resume a queued run safely.', successCriteria: ['Only a matching run version may resume.'], tasks: [], responseToUser: 'The request is complete.',
    };
    const project = await projects.createProject({ name: 'Queued pause', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Answer this request.');
    const queued = await db.one<{ version: number; status: string }>('SELECT version, status FROM runs WHERE id = ?', [request.runId]);
    expect(queued?.status).toBe('queued');

    await expect(runtime!.pause(request.runId, queued!.version)).resolves.toMatchObject({ status: 'paused' });
    await expect(runtime!.resume(request.runId, queued!.version)).rejects.toMatchObject({ code: 'RUN_VERSION_CONFLICT' });
    const paused = await db.one<{ version: number; status: string; error_code: string }>(
      'SELECT version, status, error_code FROM runs WHERE id = ?', [request.runId],
    );
    expect(paused).toMatchObject({ status: 'paused', error_code: 'USER_PAUSED', version: queued!.version + 1 });

    await expect(runtime!.resume(request.runId, paused!.version)).resolves.toMatchObject({ status: 'queued' });
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });
  });

  it('pauses before a model request when the run budget is exhausted, then resumes only with a higher approved limit', async () => {
    currentPlan = {
      goal: 'Verify budget pause and owner-approved resume.',
      successCriteria: ['The provider is not called without a sufficient reservation; raising the limit resumes the run.'],
      tasks: [],
      responseToUser: 'The request is complete.',
    };
    const project = await projects.createProject({ name: 'Budget pause', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Answer this request.');
    await db.run('UPDATE runs SET token_budget = 1024 WHERE id = ?', [request.runId]);
    runtime!.enqueue(request.runId);

    await vi.waitFor(async () => {
      expect(await db.one<{ status: string; error_code: string | null }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
        .toEqual({ status: 'paused', error_code: 'BUDGET_EXHAUSTED' });
    }, { timeout: 5_000 });
    expect(requestCount).toBe(0);

    const paused = await db.one<{ version: number }>('SELECT version FROM runs WHERE id = ?', [request.runId]);
    await expect(runtime!.resume(request.runId, paused!.version)).rejects.toMatchObject({ code: 'RUN_BUDGET_APPROVAL_REQUIRED' });
    await expect(runtime!.resume(request.runId, paused!.version, { tokenBudget: 1024 })).rejects.toMatchObject({ code: 'RUN_BUDGET_NOT_INCREASED' });
    expect(await db.one<{ status: string; error_code: string; version: number }>('SELECT status, error_code, version FROM runs WHERE id = ?', [request.runId]))
      .toMatchObject({ status: 'paused', error_code: 'BUDGET_EXHAUSTED', version: paused!.version });

    await expect(runtime!.resume(request.runId, paused!.version, { tokenBudget: 100_000 })).resolves.toMatchObject({ status: 'queued' });
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });
    expect(await db.one<{ token_budget: number }>('SELECT token_budget FROM runs WHERE id = ?', [request.runId])).toEqual({ token_budget: 100_000 });
    expect(requestCount).toBe(1);
  });

  it('does not allow resume when a dispatched tool outcome remains unknown', async () => {
    const project = await projects.createProject({ name: 'Unknown operation pause', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Check the unknown operation.');
    await db.run("UPDATE runs SET status = 'paused', error_code = 'TOOL_OUTCOME_UNKNOWN', version = version + 1 WHERE id = ?", [request.runId]);
    const paused = await db.one<{ version: number }>('SELECT version FROM runs WHERE id = ?', [request.runId]);

    await expect(runtime!.resume(request.runId, paused!.version)).rejects.toMatchObject({ code: 'RUN_TOOL_OUTCOME_UNKNOWN' });
    expect(await db.one<{ status: string; error_code: string }>('SELECT status, error_code FROM runs WHERE id = ?', [request.runId]))
      .toEqual({ status: 'paused', error_code: 'TOOL_OUTCOME_UNKNOWN' });
  });

  it('keeps a busy specialist on its current definition while accepting only append-only registry reloads', async () => {
    const registryRoot = join(dataDir, 'candidate-registry');
    await mkdir(registryRoot);
    await Promise.all(['agents', 'config', 'skills'].map((name) => cp(join(process.cwd(), name), join(registryRoot, name), { recursive: true })));
    const definitionsDir = join(registryRoot, 'agents', 'definitions');
    await cp(join(definitionsDir, 'writer'), join(definitionsDir, 'designer'), { recursive: true });
    const designerManifestPath = join(definitionsDir, 'designer', 'agent.yaml');
    const designerManifest = (await readFile(designerManifestPath, 'utf8'))
      .replace(/^id: writer$/m, 'id: designer')
      .replace(/^displayName: Writer$/m, 'displayName: Designer');
    await writeFile(designerManifestPath, designerManifest);
    await writeFile(join(definitionsDir, 'designer', 'system.md'), 'Prepare design deliverables using the existing tools.');
    await appendFile(join(registryRoot, 'agents', 'roster.yaml'), '\n  - id: designer-01\n    definition: designer\n    displayName: Designer\n    enabled: true\n    appearanceSeed: 74001\n');

    const candidate = await loadRegistry(registryRoot);
    const initialWriter = registry.definitions.get('writer')!;
    const preview = previewRegistryAdditions(registry, candidate);
    expect(preview.canApply).toBe(true);
    expect(preview.addedAgents.map((agent) => agent.id)).toEqual(['designer-01']);

    const plan = {
      goal: 'Verify a registry addition during an active task.',
      successCriteria: ['The current Writer finishes while the new Designer joins the roster.'],
      tasks: [{ key: 'draft', title: 'Draft', objective: 'Write a short project note.', capability: 'writing.draft', dependsOn: [] }],
    };
    plannedResponses = [plan];
    blockNextSpecialist = true;
    const project = await projects.createProject({ name: 'Busy registry reload', goal: '' });
    const request = await projects.createUserMessage(project.id, project.conversationId, 'Draft a short note.');
    runtime!.enqueue(request.runId);
    await Promise.race([
      specialistStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Writer did not start.')), 5_000)),
    ]);

    const busyTask = await db.one<{ status: string; assigned_agent_id: string | null }>(
      "SELECT status, assigned_agent_id FROM tasks WHERE run_id = ? AND task_key = 'draft'", [request.runId],
    );
    expect(busyTask).toMatchObject({ status: 'running', assigned_agent_id: 'writer-01' });
    expect(lastSpecialistSystemText).toContain(initialWriter.system);

    runtime!.updateRegistry(candidate);
    projects.updateRegistry(candidate);
    await projects.seedRegistry(candidate);
    const snapshot = await projects.officeSnapshot();
    expect(snapshot.agents.some((agent) => agent.id === 'designer-01')).toBe(true);
    expect(snapshot.agents.find((agent) => agent.id === 'writer-01')).toMatchObject({ availability: 'busy', currentTaskId: expect.any(String) });

    const changedWriterPath = join(definitionsDir, 'writer', 'system.md');
    await writeFile(changedWriterPath, 'This changed definition must require a restart.');
    const invalidReload = await loadRegistry(registryRoot);
    const invalidPreview = previewRegistryAdditions(candidate, invalidReload);
    expect(invalidPreview.canApply).toBe(false);
    expect(invalidPreview.blockers).toContain('Definition writer đã thay đổi; cập nhật definition hiện có cần khởi động lại.');
    expect(registry.revision).toBe(candidate.revision);
    expect((await projects.officeSnapshot()).agents.some((agent) => agent.id === 'designer-01')).toBe(true);

    releaseSpecialist();
    await vi.waitFor(async () => {
      expect(await db.one<{ status: string }>('SELECT status FROM runs WHERE id = ?', [request.runId])).toEqual({ status: 'succeeded' });
    }, { timeout: 5_000 });
    expect(await db.one<{ status: string }>("SELECT status FROM tasks WHERE run_id = ? AND task_key = 'draft'", [request.runId]))
      .toEqual({ status: 'succeeded' });
  });
});

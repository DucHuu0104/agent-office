import { beforeEach, describe, expect, it } from 'vitest';
import { eventEnvelopeSchema, type Agent, type Project, type Task } from '../../../shared/platform/contracts';
import { toOfficeToolVisualEvent, toOfficeVisualEvent } from './office-visuals';
import { setLocale } from './i18n';

const createdAt = '2026-10-25T00:00:00.000Z';
const agent: Agent = {
  id: 'writer-01', definitionId: 'writer', displayName: 'Mai', role: 'specialist', capabilities: ['writing.draft'],
  availability: 'busy', execution: 'running', location: { kind: 'project', projectId: 'project-1' }, projectId: 'project-1',
  currentTaskId: 'task-1', modelProfile: 'primary', appearanceSeed: 23, updatedAt: createdAt,
};
const project: Project = {
  id: 'project-1', name: 'Writing room', goal: 'Write a draft.', status: 'active', roomOrdinal: 1,
  coordinatorInstanceId: 'coordinator-1', conversationId: 'conversation-1', createdAt, updatedAt: createdAt,
};
const task: Task = {
  id: 'task-1', runId: 'run-1', key: 'draft', title: 'Draft the introduction', objective: 'Write a draft.',
  requiredCapabilities: ['writing.draft'], dependencies: [], status: 'running', assignedAgentId: 'writer-01', output: null,
  createdAt, updatedAt: createdAt,
};

function event(type: string, payload: Record<string, unknown>) {
  return eventEnvelopeSchema.parse({
    schemaVersion: 1, eventId: `event-${type}`, sequence: 1, type, projectId: project.id,
    aggregateId: task.id, occurredAt: createdAt, payload,
  });
}

describe('Agent Office visual activity mapping', () => {
  beforeEach(() => setLocale('vi'));

  it('maps assignment state to a short, truthful activity bubble and ticker item', () => {
    const visual = toOfficeVisualEvent(event('execution.started', { taskId: task.id, agentInstanceId: agent.id }), {
      agents: [agent], projects: [project], tasks: [task],
    });

    expect(visual).toMatchObject({ agentId: agent.id, agentName: 'Mai', projectName: 'Writing room', icon: '💭', text: 'Đang làm: Draft the introduction' });
    expect(visual?.activityKind).toBe('think');
  });

  it('shows a live, real tool activity in the agent bubble, sidebar and ticker context', () => {
    const visual = toOfficeToolVisualEvent({
      eventId: 'live-activity-1', projectId: project.id, taskId: task.id, agentInstanceId: agent.id,
      toolId: 'workspace.read', target: 'transform.py', createdAt,
    }, { agents: [agent], projects: [project], tasks: [task] });

    expect(visual).toMatchObject({
      id: 'live-activity-1', agentId: agent.id, projectId: project.id, projectName: project.name,
      icon: '📖', text: 'Đang đọc transform.py', activityKind: 'read',
    });
  });

  it('drops stale or malformed live activity instead of displaying it', () => {
    expect(toOfficeToolVisualEvent({
      eventId: 'live-activity-2', projectId: project.id, taskId: 'another-task', agentInstanceId: agent.id,
      toolId: 'workspace.read', target: 'transform.py', createdAt,
    }, { agents: [agent], projects: [project], tasks: [task] })).toBeNull();
    expect(toOfficeToolVisualEvent({
      eventId: 'live-activity-3', projectId: project.id, taskId: task.id, agentInstanceId: agent.id,
      toolId: 'workspace.read', target: 'transform.py', arguments: { content: 'private' }, createdAt,
    }, { agents: [agent], projects: [project], tasks: [task] })).toBeNull();
  });

  it('shows safe generic approval and failure labels without rendering tool arguments or model output', () => {
    const approval = toOfficeVisualEvent(event('approval.requested', {
      taskId: task.id, agentInstanceId: agent.id, toolId: 'workspace.write_file',
      summary: 'Write the approved report', arguments: { content: 'private argument payload' },
    }), { agents: [agent], projects: [project], tasks: [task] });
    const failure = toOfficeVisualEvent(event('task.status_changed', {
      taskId: task.id, agentInstanceId: agent.id, status: 'failed', output: 'private model output',
    }), { agents: [agent], projects: [project], tasks: [task] });

    expect(approval).toMatchObject({ icon: '✋', text: 'Cần bạn phê duyệt thao tác', mood: 'question' });
    expect(failure).toMatchObject({ icon: '🚨', text: 'Nhiệm vụ lỗi: Draft the introduction', mood: 'error' });
    expect(JSON.stringify([approval, failure])).not.toContain('private');
  });

  it('ignores events outside the visual allow-list', () => {
    const raw = event('model.reasoning', { text: 'private chain of thought' });
    expect(toOfficeVisualEvent(raw, { agents: [agent], projects: [project], tasks: [task] })).toBeNull();
  });
});

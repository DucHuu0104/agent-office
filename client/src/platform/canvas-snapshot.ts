import type { OfficeSnapshot as CanvasSnapshot, AgentInfo, RoomInfo, Activity } from '../../../shared/types';
import type { OfficeSnapshot, Task } from '../../../shared/platform/contracts';
import { RECEPTION_ID } from '../world/layout/core';
import { tr } from './i18n';

export function toCanvasSnapshot(
  office: OfficeSnapshot,
  roleNames: Record<string, string>,
  startedAt: number,
  tasks: readonly Task[] = [],
  activities: ReadonlyMap<string, Activity> = new Map(),
): CanvasSnapshot {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const rooms: RoomInfo[] = office.projects.map((project) => ({
    id: project.id,
    name: project.name,
    path: '',
    slot: project.roomOrdinal,
    seed: project.roomOrdinal * 7919 + 1,
    createdAt: new Date(project.createdAt).getTime(),
  }));
  const agents: AgentInfo[] = office.agents.map((agent) => {
    const status: AgentInfo['status'] = agent.execution === 'running' ? 'working' : agent.execution === 'waiting' ? 'waiting' : 'idle';
    const role = roleNames[agent.definitionId] ?? agent.definitionId;
    const task = agent.currentTaskId ? tasksById.get(agent.currentTaskId) : undefined;
    const activity = activities.get(agent.id) ?? (agent.execution === 'running'
      ? { id: `working:${agent.currentTaskId ?? agent.id}`, kind: 'think' as const, icon: '💭', text: task ? tr('Trabalhando em: {0}', [task.title]) : tr('Processando uma tarefa'), at: new Date(agent.updatedAt).getTime() }
      : agent.execution === 'waiting'
        ? { id: `waiting:${agent.currentTaskId ?? agent.id}`, kind: 'ask' as const, icon: '✋', text: tr('Ação precisa de sua aprovação'), at: new Date(agent.updatedAt).getTime() }
        : undefined);
    return {
      id: agent.id,
      kind: 'main',
      roomId: agent.projectId ?? RECEPTION_ID,
      name: agent.displayName,
      look: agent.appearanceSeed % 2 ? 'f' : 'm',
      role,
      title: task ? `${role} · ${task.title}` : role,
      sessionId: agent.id,
      account: 'agent-office',
      status,
      ...(activity ? { activity } : {}),
      recent: activity ? [activity] : [],
      tasks: [],
      model: agent.modelProfile,
      startedAt: new Date(agent.updatedAt).getTime(),
      lastEventAt: new Date(agent.updatedAt).getTime(),
      statusSince: new Date(agent.updatedAt).getTime(),
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      seed: agent.appearanceSeed,
    };
  });
  return {
    rev: office.revision,
    serverTime: Date.now(),
    rooms,
    agents,
    accounts: [],
    meta: { demo: false, sources: [], startedAt, version: '0.1.0' },
  };
}

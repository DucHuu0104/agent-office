import { describe, expect, it } from 'vitest';
import { officeSnapshotSchema } from '../../../shared/platform/contracts';
import { DEFAULT_WORLD_OPTIONS } from '../world/api';
import { RECEPTION_ID } from '../world/layout/core';
import type { Appearance, ArtModule, RoomTheme } from '../art/api';
import { Sim } from '../world/sim/sim';
import { toCanvasSnapshot } from './canvas-snapshot';
import { setLocale } from './i18n';

setLocale('vi');

const createdAt = '2026-10-25T00:00:00.000Z';
const appearance: Appearance = {
  skin: '#f0c8a0', hair: '#3a2a20', hairStyle: 'short', eyes: '#222', top: '#3f7fd8', topAccent: '#fff',
  topStyle: 'tshirt', bottom: '#333', shoes: '#111', accessory: 'none', accessoryColor: '#000', lanyard: null, look: 'm',
};
const roomTheme: RoomTheme = {
  carpet: '#4f6d8f', carpet2: '#486685', wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8', deskVariant: 'wood', chairVariant: 'black',
};
const art = {
  appearanceFromSeed: () => appearance,
  roomTheme: () => roomTheme,
} as unknown as ArtModule;

function officeSnapshot(execution: 'ready' | 'running' | 'waiting', projectId: string | null, currentTaskId: string | null) {
  return officeSnapshotSchema.parse({
    revision: 4,
    serverTime: createdAt,
    projects: [{
      id: 'project-1', name: 'Writing room', goal: 'Prepare a concise draft.', status: 'active', roomOrdinal: 2,
      coordinatorInstanceId: 'coordinator-1', conversationId: 'conversation-1', createdAt, updatedAt: createdAt,
    }],
    agents: [{
      id: 'writer-01', definitionId: 'writer', displayName: 'Mai', role: 'specialist', capabilities: ['writing.draft'],
      availability: execution === 'ready' ? 'ready' : 'busy', execution,
      location: projectId ? { kind: 'project', projectId } : { kind: 'pool' }, projectId, currentTaskId,
      modelProfile: 'primary', appearanceSeed: 33907, updatedAt: createdAt,
    }],
    activeRuns: execution === 'ready' ? 0 : 1,
    pendingApprovals: execution === 'waiting' ? 1 : 0,
  });
}

describe('Agent Office canvas snapshot mapping', () => {
  it('moves a real running assignment into its project room as a working character', () => {
    const now = Date.parse(createdAt);
    const task = {
      id: 'task-1', runId: 'run-1', key: 'writing', title: 'Draft the introduction', objective: 'Write an introduction.',
      requiredCapabilities: ['writing.draft'], dependencies: [], status: 'running' as const,
      assignedAgentId: 'writer-01', output: null, createdAt, updatedAt: createdAt,
    };
    const snapshot = toCanvasSnapshot(officeSnapshot('running', 'project-1', 'task-1'), { writer: 'Writer' }, now, [task]);

    expect(snapshot.rooms).toMatchObject([{ id: 'project-1', name: 'Writing room', slot: 2 }]);
    expect(snapshot.agents[0]).toMatchObject({
      id: 'writer-01', roomId: 'project-1', status: 'working', name: 'Mai', role: 'Writer', title: 'Writer · Draft the introduction',
    });
    expect(snapshot.agents[0]?.activity).toMatchObject({ kind: 'think', icon: '💭', text: 'Đang làm: Draft the introduction' });
    expect(snapshot.meta).toMatchObject({ demo: false, startedAt: now });

    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    sim.applySnapshot(snapshot, now);
    for (let frame = 1; frame <= 15; frame++) sim.update(1 / 30, now + frame * (1000 / 30));
    const character = sim.chars.get('writer-01');
    expect(character?.roomId).toBe('project-1');
    expect(character?.mode).toBe('work');
    expect(character?.pose).toBe('type');
  });

  it('keeps one character per agent when a fresh assignment moves it to another room', () => {
    const now = Date.parse(createdAt);
    const firstOffice = officeSnapshot('running', 'project-1', 'task-1');
    const firstTask = {
      id: 'task-1', runId: 'run-1', key: 'writing', title: 'Draft the introduction', objective: 'Write an introduction.',
      requiredCapabilities: ['writing.draft'], dependencies: [], status: 'running' as const,
      assignedAgentId: 'writer-01', output: null, createdAt, updatedAt: createdAt,
    };
    const secondOffice = officeSnapshotSchema.parse({
      ...firstOffice,
      revision: firstOffice.revision + 1,
      projects: [...firstOffice.projects, {
        ...firstOffice.projects[0]!, id: 'project-2', name: 'Analysis room', roomOrdinal: 3,
        coordinatorInstanceId: 'coordinator-2', conversationId: 'conversation-2',
      }],
      agents: firstOffice.agents.map((agent) => ({
        ...agent, location: { kind: 'project' as const, projectId: 'project-2' }, projectId: 'project-2',
        currentTaskId: 'task-2', updatedAt: '2026-10-25T00:00:02.000Z',
      })),
    });
    const secondTask = {
      ...firstTask, id: 'task-2', runId: 'run-2', key: 'analysis', title: 'Check the new task',
      objective: 'Check the new assignment.', updatedAt: '2026-10-25T00:00:02.000Z',
    };
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    sim.applySnapshot(toCanvasSnapshot(firstOffice, { writer: 'Writer' }, now, [firstTask]), now);
    sim.update(0.5, now + 500);
    sim.applySnapshot(toCanvasSnapshot(secondOffice, { writer: 'Writer' }, now, [secondTask]), now + 500);
    for (let frame = 1; frame <= 30; frame++) sim.update(1 / 30, now + 500 + frame * (1000 / 30));

    const character = sim.chars.get('writer-01');
    expect([...sim.chars.keys()].filter((id) => id === 'writer-01')).toHaveLength(1);
    expect(character).toMatchObject({ id: 'writer-01', roomId: 'project-2', mode: 'work' });
    expect(character?.info.activity).toMatchObject({ text: 'Đang làm: Check the new task' });
  });

  it('maps approval waits to the waiting pose and unassigned specialists to the shared pool', () => {
    const waiting = toCanvasSnapshot(officeSnapshot('waiting', 'project-1', 'task-1'), { writer: 'Writer' }, 1234);
    const ready = toCanvasSnapshot(officeSnapshot('ready', null, null), { writer: 'Writer' }, 1234);

    expect(waiting.agents[0]).toMatchObject({ roomId: 'project-1', status: 'waiting', activity: { kind: 'ask', icon: '✋' } });
    expect(ready.agents[0]).toMatchObject({ roomId: RECEPTION_ID, status: 'idle' });
  });
});

import { describe, expect, it } from 'vitest';
import { createOfficeToolActivity } from './office-activity';

describe('live office tool activity', () => {
  it('emits a safe file label without the workspace path or file content', () => {
    const activity = createOfficeToolActivity({
      eventId: 'event-1', projectId: 'project-1', taskId: 'task-1', agentInstanceId: 'developer-01',
      toolId: 'workspace.read', argumentsRaw: JSON.stringify({ path: 'src/private-client.ts', content: 'ghp_abcdefghijklmnopqrstuvwxyz012345' }),
      createdAt: '2026-10-26T00:00:00.000Z',
    });

    expect(activity).toMatchObject({ toolId: 'workspace.read', target: 'private-client.ts' });
    expect(JSON.stringify(activity)).not.toContain('src/');
    expect(JSON.stringify(activity)).not.toContain('ghp_');
  });

  it('masks credentials in search labels and reduces fetched URLs to their host', () => {
    const search = createOfficeToolActivity({
      eventId: 'event-2', projectId: 'project-1', taskId: 'task-1', agentInstanceId: 'researcher-01',
      toolId: 'research.search', argumentsRaw: JSON.stringify({ query: 'look up ghp_abcdefghijklmnopqrstuvwxyz012345' }),
    });
    const fetch = createOfficeToolActivity({
      eventId: 'event-3', projectId: 'project-1', taskId: 'task-1', agentInstanceId: 'researcher-01',
      toolId: 'research.fetch', argumentsRaw: JSON.stringify({ url: 'https://user:password@example.com/private/path?token=secret' }),
    });

    expect(search.target).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(fetch.target).toBe('example.com');
  });

  it('rejects tool IDs outside the visible allow-list', () => {
    expect(() => createOfficeToolActivity({
      eventId: 'event-4', projectId: 'project-1', taskId: 'task-1', agentInstanceId: 'developer-01',
      toolId: 'shell.execute', argumentsRaw: '{}',
    })).toThrow();
  });
});

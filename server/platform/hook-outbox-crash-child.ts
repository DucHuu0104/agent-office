import { writeFile } from 'node:fs/promises';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { HookRunner } from './hooks';
import { MemoryService } from './memory';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';

const [dataDir, runId, projectId, agentInstanceId, markerPath, crashPhase = 'after_event_commit'] = process.argv.slice(2);
if (!dataDir || !runId || !projectId || !agentInstanceId || !markerPath || !['before_event_commit', 'after_event_commit'].includes(crashPhase)) {
  throw new Error('Expected data directory, run, project, agent, crash marker and supported crash phase identifiers.');
}

const db = await DatabaseClient.open(dataDir, true);
const events = new EventHub(db);
const registry = await loadRegistry(process.cwd());
const projects = new ProjectService(db, events, registry);
const memory = new MemoryService(db, events);
const hooks = new HookRunner({ db, events, memory, projects });
const developer = registry.definitions.get('developer');
if (!developer) throw new Error('Developer definition is missing.');
const audited = {
  ...developer,
  hooks: {
    ...developer.hooks,
    hooks: {
      ...developer.hooks.hooks,
      after_model_call: [{ handler: 'lifecycle.audit' as const, timeoutMs: 30_000, onError: 'warn' as const }],
    },
  },
};

const original = events.transactIdempotent.bind(events);
events.transactIdempotent = async (...args) => {
  if (args[1] === 'agent.lifecycle_hook') {
    if (crashPhase === 'before_event_commit') {
      await writeFile(markerPath, JSON.stringify({ phase: crashPhase }));
      await new Promise<void>(() => undefined);
    }
  }
  const result = await original(...args);
  if (args[1] === 'agent.lifecycle_hook' && crashPhase === 'after_event_commit') {
    await writeFile(markerPath, JSON.stringify({ phase: crashPhase }));
    await new Promise<void>(() => undefined);
  }
  return result;
};

await hooks.dispatch(audited, 'after_model_call', {
  eventId: 'hard-kill-lifecycle-audit', executionId: runId, runId, projectId, taskId: 'hard-kill-task', agentInstanceId,
  data: { profileId: 'coding', attempt: 2, outcome: 'succeeded', promptTokens: 42, completionTokens: 11, prompt: 'hook-outbox-private-prompt' },
});
throw new Error('Lifecycle hook returned without reaching the requested crash boundary.');

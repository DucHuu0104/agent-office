import { writeFile } from 'node:fs/promises';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';

const [dataDir, runId, modelBaseUrl, markerPath] = process.argv.slice(2);
if (!dataDir || !runId || !modelBaseUrl || !markerPath) throw new Error('Expected data directory, run ID, fake model endpoint and marker path.');

const db = await DatabaseClient.open(dataDir, true);
const events = new EventHub(db);
const registry = await loadRegistry(process.cwd());
const projects = new ProjectService(db, events, registry);
const runtime = new AgentRuntime(db, events, projects, registry, new ArtifactService(db, events, dataDir), loadAppConfig({
  ...process.env,
  OFFICE_DATA_DIR: dataDir,
  OFFICE_CONFIG_DIR: process.cwd(),
  OFFICE_EXECUTION_MODE: 'disabled',
  MODEL_PRIMARY_BASE_URL: modelBaseUrl,
  MODEL_PRIMARY_API_KEY: 'coordinator-plan-crash-test-key',
  MODEL_PRIMARY_NAME: 'coordinator-plan-crash-test-model',
}));

const originalTransact = events.transact.bind(events);
events.transact = async (...args) => {
  const result = await originalTransact(...args);
  if (args[0] === 'run.plan_revised' && args[1] === runId) {
    await writeFile(markerPath, JSON.stringify({ type: args[0], aggregateId: args[1], committedAt: new Date().toISOString() }));
    process.stdout.write('COORDINATOR_PLAN_COMMITTED\n');
    await new Promise<void>(() => undefined);
  }
  return result;
};

runtime.enqueue(runId);
await new Promise<void>(() => undefined);

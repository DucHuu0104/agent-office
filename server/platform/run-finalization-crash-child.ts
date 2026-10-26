import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';

const [dataDir, runId, modelBaseUrl] = process.argv.slice(2);
if (!dataDir || !runId || !modelBaseUrl) throw new Error('Expected data directory, run ID, and fake model endpoint.');

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
  MODEL_PRIMARY_API_KEY: 'run-finalization-crash-test-key',
  MODEL_PRIMARY_NAME: 'run-finalization-crash-test-model',
}));

const originalConditional = events.transactConditional.bind(events);
events.transactConditional = async (...args) => {
  const event = await originalConditional(...args);
  const payload = args[3] as { status?: string };
  if (args[0] === 'run.status_changed' && args[1] === runId && payload.status === 'succeeded') {
    process.stdout.write('RUN_FINALIZATION_COMMITTED\n');
    await new Promise<void>(() => undefined);
  }
  return event;
};

runtime.enqueue(runId);
await new Promise<void>(() => undefined);

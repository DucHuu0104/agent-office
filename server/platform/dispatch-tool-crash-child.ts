import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';

const [dataDir, runId, modelBaseUrl, crashPhase = 'after-dispatch'] = process.argv.slice(2);
if (!dataDir || !runId || !modelBaseUrl || !['after-dispatch', 'after-effect'].includes(crashPhase)) {
  throw new Error('Expected data directory, run ID, fake model endpoint and supported crash phase.');
}

const db = await DatabaseClient.open(dataDir, true);
const events = new EventHub(db);
const registry = await loadRegistry(process.cwd());
const projects = new ProjectService(db, events, registry);
const runtime = new AgentRuntime(
  db,
  events,
  projects,
  registry,
  new ArtifactService(db, events, dataDir),
  loadAppConfig({
    ...process.env,
    OFFICE_DATA_DIR: dataDir,
    OFFICE_CONFIG_DIR: process.cwd(),
    OFFICE_EXECUTION_MODE: 'disabled',
    MODEL_PRIMARY_BASE_URL: modelBaseUrl,
    MODEL_PRIMARY_API_KEY: 'hard-crash-test-key',
    MODEL_PRIMARY_NAME: 'hard-crash-test-model',
  }),
);

const originalConditional = events.transactConditional.bind(events);
events.transactConditional = async (...args) => {
  if (crashPhase === 'after-effect' && args[0] === 'tool.completed') {
    process.stdout.write('TOOL_EFFECT_BEFORE_RECEIPT\n');
    await new Promise<void>(() => undefined);
  }
  const result = await originalConditional(...args);
  if (crashPhase === 'after-dispatch' && args[0] === 'tool.dispatched') {
    process.stdout.write('TOOL_DISPATCH_COMMITTED\n');
    await new Promise<void>(() => undefined);
  }
  return result;
};

runtime.enqueue(runId);
await new Promise<void>(() => undefined);

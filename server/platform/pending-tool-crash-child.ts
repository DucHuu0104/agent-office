import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';

const [dataDir, runId, modelBaseUrl] = process.argv.slice(2);
if (!dataDir || !runId || !modelBaseUrl) throw new Error('Expected data directory, run ID and fake model endpoint.');

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

interface CheckpointState { pendingToolCalls?: unknown[] }
interface RuntimeInternals {
  saveCheckpoint(executionId: string, state: CheckpointState, lease?: unknown): Promise<void>;
}

// Hold the worker at the precise durable boundary: after the pending call is
// checkpointed but before the runtime can record a dispatch or invoke a tool.
const internals = runtime as unknown as RuntimeInternals;
const saveCheckpoint = internals.saveCheckpoint.bind(runtime);
internals.saveCheckpoint = async (executionId, state, lease) => {
  await saveCheckpoint(executionId, state, lease);
  if (state.pendingToolCalls?.length) {
    process.stdout.write('PENDING_TOOL_CHECKPOINT_SAVED\n');
    await new Promise<void>(() => undefined);
  }
};

runtime.enqueue(runId);
await new Promise<void>(() => undefined);

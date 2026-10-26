import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';
import type { Task } from '../../shared/platform/contracts';

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
    MODEL_PRIMARY_API_KEY: 'reservation-crash-test-key',
    MODEL_PRIMARY_NAME: 'reservation-crash-test-model',
  }),
);

const internals = runtime as unknown as {
  reserveAgent(task: Task, projectId: string): Promise<{
    lease: { assignmentId: string; taskId: string; agentInstanceId: string; ownerId: string; fenceToken: number };
    agentId: string;
    definitionId: string;
    displayName: string;
  } | null>;
};
const reserveAgent = internals.reserveAgent.bind(runtime);
internals.reserveAgent = async (task, projectId) => {
  const reserved = await reserveAgent(task, projectId);
  if (!reserved) return null;
  process.stdout.write(`${JSON.stringify({ event: 'reserved_before_ack', ...reserved })}\n`);
  await new Promise<void>(() => undefined);
  return reserved;
};

await runtime.recover();
setInterval(() => undefined, 60_000);
await new Promise<void>(() => undefined);

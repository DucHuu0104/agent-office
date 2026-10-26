import { writeFile } from 'node:fs/promises';
import { ArtifactService } from './artifacts';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';
import { AgentRuntime } from './runtime';

const [dataDir, approvalId, phase, markerPath] = process.argv.slice(2);
if (!dataDir || !approvalId || !phase || !markerPath) throw new Error('Expected data directory, approval ID, crash phase and marker path.');

async function stopAtBoundary(boundary: string): Promise<void> {
  if (phase !== boundary) return;
  await writeFile(markerPath, JSON.stringify({ phase: boundary, reachedAt: new Date().toISOString() }));
  await new Promise<void>(() => undefined);
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
  loadAppConfig({ ...process.env, OFFICE_DATA_DIR: dataDir, OFFICE_EXECUTION_MODE: 'local-trusted' }),
);
runtime.enqueue = () => undefined;

const originalConditional = events.transactConditional.bind(events);
events.transactConditional = async (...args) => {
  const event = await originalConditional(...args);
  if (args[0] === 'approval.decided' && args[1] === approvalId) await stopAtBoundary('approval-committed');
  if (args[0] === 'tool.dispatched') await stopAtBoundary('dispatch-committed');
  return event;
};

const originalTransact = events.transact.bind(events);
events.transact = async (...args) => {
  if (args[0] === 'tool.completed') await stopAtBoundary('effect-before-receipt');
  const event = await originalTransact(...args);
  if (args[0] === 'run.resumed') await stopAtBoundary('resume-committed');
  return event;
};

const runtimeInternals = runtime as unknown as {
  saveCheckpoint: (executionId: string, state: unknown, lease?: unknown) => Promise<void>;
};
const originalSaveCheckpoint = runtimeInternals.saveCheckpoint.bind(runtime);
runtimeInternals.saveCheckpoint = async (...args) => {
  if (phase === 'receipt-before-checkpoint') await stopAtBoundary('receipt-before-checkpoint');
  await originalSaveCheckpoint(...args);
  if (phase === 'checkpoint-committed') await stopAtBoundary('checkpoint-committed');
};

await runtime.decideApproval(approvalId, 'approve');
throw new Error(`Approval completed without reaching requested crash boundary: ${phase}`);

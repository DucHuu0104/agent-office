import { writeFile } from 'node:fs/promises';
import { ArtifactService } from './artifacts';
import { DatabaseClient } from './database';
import { EventHub } from './events';

const [dataDir, projectId, taskId, markerPath] = process.argv.slice(2);
if (!dataDir || !projectId || !taskId || !markerPath) throw new Error('Expected data directory, project ID, task ID and crash marker path.');

const db = await DatabaseClient.open(dataDir, true);
const events = new EventHub(db);
const artifacts = new ArtifactService(db, events, dataDir);
const originalTransact = events.transact.bind(events);
events.transact = async (...args) => {
  const event = await originalTransact(...args);
  if (args[0] === 'artifact.version_created') {
    await writeFile(markerPath, JSON.stringify({ type: args[0], aggregateId: args[1] }));
    await new Promise<void>(() => undefined);
  }
  return event;
};

await artifacts.create({ projectId, taskId, name: 'crash-evidence.txt', content: 'Durable artifact before tool receipt commit.' });
throw new Error('Artifact creation returned without reaching the crash boundary.');

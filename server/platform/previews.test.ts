import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from './artifacts';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ArtifactPreviewManager } from './previews';
import { ProjectService } from './projects';
import { loadRegistry } from './registry';

describe('short-lived artifact previews', () => {
  let dataDir: string;
  let db: DatabaseClient;
  let projectId: string;
  let artifacts: ArtifactService;
  let previewManager: ArtifactPreviewManager;
  let now: number;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-office-previews-'));
    db = await DatabaseClient.open(dataDir, true);
    const events = new EventHub(db);
    const registry = await loadRegistry(process.cwd());
    const projects = new ProjectService(db, events, registry);
    await projects.seedRegistry();
    projectId = (await projects.createProject({ name: 'Preview fixture', goal: '' })).id;
    artifacts = new ArtifactService(db, events, dataDir);
    previewManager = new ArtifactPreviewManager(artifacts);
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('expires preview tokens after ten minutes and prunes old sessions when issuing another', async () => {
    const artifact = await artifacts.create({ projectId, taskId: null, name: 'notes.md', content: '# Notes', mimeType: 'text/markdown' });
    const first = await previewManager.open(projectId, artifact.versionId);
    expect(await previewManager.read(first.token)).not.toBeNull();

    now += 10 * 60 * 1000;
    expect(await previewManager.read(first.token)).toBeNull();
    const second = await previewManager.open(projectId, artifact.versionId);
    expect(await previewManager.read(second.token)).not.toBeNull();
  });

  it('serves text artifacts as escaped HTML and rejects unsupported MIME types', async () => {
    const markdown = await artifacts.create({ projectId, taskId: null, name: 'unsafe.md', content: '<script>run()</script>', mimeType: 'text/markdown' });
    const preview = await previewManager.open(projectId, markdown.versionId);
    const result = await previewManager.read(preview.token);
    expect(result?.html.toString('utf8')).toContain('&lt;script&gt;run()&lt;/script&gt;');
    expect(result?.html.toString('utf8')).not.toContain('<script>run()</script>');

    const attachment = await artifacts.create({ projectId, taskId: null, name: 'data.json', content: '{"safe":true}', mimeType: 'application/json' });
    const nonPreviewable = await artifacts.create({ projectId, taskId: null, name: 'data.bin', content: 'binary', mimeType: 'text/plain' });
    await db.run("UPDATE artifact_versions SET mime_type = 'application/octet-stream' WHERE id = ?", [nonPreviewable.versionId]);
    await expect(previewManager.open(projectId, nonPreviewable.versionId)).rejects.toMatchObject({ code: 'PREVIEW_UNSUPPORTED' });
    expect((await previewManager.read((await previewManager.open(projectId, attachment.versionId)).token))?.html.toString('utf8')).toContain('{&quot;safe&quot;:true}');
  });
});

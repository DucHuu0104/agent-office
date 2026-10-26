import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DockerCheckExecution } from './executor';
import { WorkspacePreviewManager } from './workspace-previews';

const dockerExecution: DockerCheckExecution = {
  mode: 'docker', image: 'node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213',
  network: 'none', installDependencies: 'none', memoryMb: 1024, cpus: 1, pidsLimit: 64,
};
const dockerTests = process.env.OFFICE_DOCKER_TESTS === '1';

describe('managed workspace website previews', () => {
  it('requires explicit network consent, runs from a filtered copy, adds browser policy, and stops its process tree', async () => {
    const fixture = await createFixture();
    const manager = new WorkspacePreviewManager({ dataDir: fixture.dataDir, execution: { mode: 'local-trusted' } });
    try {
      const setup = await manager.describe('project-a', fixture.root);
      expect(setup.scripts).toEqual([{ name: 'preview', command: 'node server.mjs', lifecycle: [{ name: 'prepreview', command: 'node -e "console.log(\'pre-hook-run\')"' }, { name: 'preview', command: 'node server.mjs' }] }]);
      await expect(manager.start({ projectId: 'project-a', root: fixture.root, script: 'preview', packageChecksum: setup.packageChecksum, allowNetworkAccess: false }))
        .rejects.toMatchObject({ code: 'PREVIEW_NETWORK_CONSENT_REQUIRED' });
      await expect(manager.start({ projectId: 'project-a', root: fixture.root, script: 'preview', packageChecksum: 'f'.repeat(64), allowNetworkAccess: true }))
        .rejects.toMatchObject({ code: 'PREVIEW_PACKAGE_CHANGED' });

      const preview = await manager.start({ projectId: 'project-a', root: fixture.root, script: 'preview', packageChecksum: setup.packageChecksum, allowNetworkAccess: true });
      expect(preview).toMatchObject({ projectId: 'project-a', script: 'preview', executionMode: 'local-trusted', networkAccess: true });
      expect(new URL(preview.url).hostname).toBe('127.0.0.2');
      expect(manager.list('project-a')).toHaveLength(1);

      const response = await fetch(preview.url, { headers: { Cookie: 'office_session=must-not-reach-the-preview' } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('cookie=absent');
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('https:');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await (await fetch(new URL('/external-redirect', preview.url))).text()).toContain('External redirects are disabled');
      await expect(access(join(fixture.root, 'preview-only.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(fixture.root, '.env'), 'utf8')).toContain('HOST_SECRET_SENTINEL');

      expect(await manager.stop(preview.id)).toBe(true);
      expect(manager.list('project-a')).toEqual([]);
      const stopped = await fetch(preview.url).catch(() => null);
      expect(stopped).toBeNull();
    } finally {
      await manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('cleans a previous preview before starting another for the same project', async () => {
    const fixture = await createFixture();
    const manager = new WorkspacePreviewManager({ dataDir: fixture.dataDir, execution: { mode: 'local-trusted' } });
    try {
      const setup = await manager.describe('project-a', fixture.root);
      const first = await manager.start({ projectId: 'project-a', root: fixture.root, script: 'preview', packageChecksum: setup.packageChecksum, allowNetworkAccess: true });
      const second = await manager.start({ projectId: 'project-a', root: fixture.root, script: 'preview', packageChecksum: setup.packageChecksum, allowNetworkAccess: true });
      expect(second.id).not.toBe(first.id);
      expect(manager.list()).toHaveLength(1);
      expect(await fetch(first.url).catch(() => null)).toBeNull();
      expect(await fetch(second.url).then((response) => response.status)).toBe(200);
    } finally {
      await manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('cleans the preview when its process supervisor loses the owner IPC channel', async () => {
    const fixture = await createFixture();
    const manager = new WorkspacePreviewManager({ dataDir: fixture.dataDir, execution: { mode: 'local-trusted' } });
    try {
      const setup = await manager.describe('project-a', fixture.root);
      const preview = await manager.start({ projectId: 'project-a', root: fixture.root, script: 'preview', packageChecksum: setup.packageChecksum, allowNetworkAccess: true });
      const supervisor = (manager as unknown as { sessions: Map<string, { supervisor: { disconnect(): void } }> }).sessions.get(preview.id)?.supervisor;
      expect(supervisor).toBeTruthy();
      supervisor!.disconnect();
      const deadline = Date.now() + 10_000;
      let response: Response | null = null;
      while (Date.now() < deadline) {
        response = await fetch(preview.url).catch(() => null);
        if (!response) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(response).toBeNull();
      expect(manager.list()).toEqual([]);
    } finally {
      await manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('requires the reviewed lockfile checksum before Docker npm ci', async () => {
    const fixture = await createFixture();
    const manager = new WorkspacePreviewManager({ dataDir: fixture.dataDir, execution: { ...dockerExecution, installDependencies: 'npm-ci' } });
    try {
      await writeFile(join(fixture.root, 'package-lock.json'), JSON.stringify({ name: 'preview-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'preview-fixture', version: '1.0.0' } } }));
      const setup = await manager.describe('docker-project', fixture.root);
      expect(setup.dependencyInstall?.lockChecksum).toMatch(/^[a-f\d]{64}$/);
      await expect(manager.start({ projectId: 'docker-project', root: fixture.root, script: 'preview', packageChecksum: setup.packageChecksum, dependencyInstallChecksum: 'f'.repeat(64), allowNetworkAccess: true }))
        .rejects.toMatchObject({ code: 'PREVIEW_LOCKFILE_CHANGED' });
      expect(manager.list()).toEqual([]);
    } finally {
      await manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.skipIf(!dockerTests)('starts a resource-limited Docker preview only after the owner consents to bridge networking', async () => {
    const fixture = await createFixture();
    const manager = new WorkspacePreviewManager({ dataDir: fixture.dataDir, execution: dockerExecution });
    try {
      const setup = await manager.describe('docker-project', fixture.root);
      const preview = await manager.start({ projectId: 'docker-project', root: fixture.root, script: 'preview', packageChecksum: setup.packageChecksum, allowNetworkAccess: true });
      const response = await fetch(preview.url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('cookie=absent');
      expect(preview.executionMode).toBe('docker');
      expect(await manager.stop(preview.id)).toBe(true);
    } finally {
      await manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!dockerTests)('refuses to start when the pinned Docker image is missing instead of pulling it', async () => {
    const fixture = await createFixture();
    const execution = { ...dockerExecution, image: `node:22.12.0-bookworm-slim@sha256:${'0'.repeat(64)}` };
    const manager = new WorkspacePreviewManager({ dataDir: fixture.dataDir, execution });
    try {
      const setup = await manager.describe('docker-project', fixture.root);
      await expect(manager.start({ projectId: 'docker-project', root: fixture.root, script: 'preview', packageChecksum: setup.packageChecksum, allowNetworkAccess: true }))
        .rejects.toThrow('Agent Office không tự tải image');
      expect(manager.list()).toEqual([]);
    } finally {
      await manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function createFixture(): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-office-preview-project-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-office-preview-data-'));
  await writeFile(join(root, '.env'), 'HOST_SECRET_SENTINEL=must-not-copy');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'preview-fixture', version: '1.0.0',
    scripts: { prepreview: `node -e "console.log('pre-hook-run')"`, preview: 'node server.mjs' },
  }));
  await writeFile(join(root, 'server.mjs'), `import { createServer } from 'node:http';
import { writeFileSync, existsSync } from 'node:fs';
writeFileSync('preview-only.txt', 'only in snapshot');
createServer((req, res) => {
  if (req.url === '/external-redirect') { res.writeHead(302, { Location: 'https://example.com/' }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'preview-cookie=private' });
  res.end('cookie=' + (req.headers.cookie ? 'present' : 'absent') + (existsSync('.env') ? ':env-present' : ''));
}).listen(Number(process.env.PORT), process.env.HOST);
`);
  return { root, dataDir };
}

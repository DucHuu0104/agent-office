import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReleasePackage, RELEASE_SOURCE_PATHS, verifyReleasePackage } from '../../scripts/package-platform';

describe('Agent Office release package', () => {
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it('stages a deterministic, locked package without secrets and detects tampering or added files', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-office-package-test-'));
    const source = join(temporaryRoot, 'source');
    await createSourceFixture(source);

    const first = await buildReleasePackage(source, join(temporaryRoot, 'path-one', 'agent-office-0.1.0-uat-test'));
    const second = await buildReleasePackage(source, join(temporaryRoot, 'path-two', 'agent-office-0.1.0-uat-test'));
    const firstManifest = await verifyReleasePackage(first.path);
    const secondManifest = await verifyReleasePackage(second.path);

    expect(first.bundleSha256).toBe(second.bundleSha256);
    expect(firstManifest).toEqual(secondManifest);
    expect(firstManifest.files.map(({ path }) => path)).toContain('npm-shrinkwrap.json');
    expect(firstManifest.files.map(({ path }) => path)).not.toContain('package-lock.json');
    expect(firstManifest.files.map(({ path }) => path)).not.toContain('.env');
    expect(firstManifest.files.map(({ path }) => path)).not.toContain('agents/definitions/.env.local');
    expect(firstManifest.files.map(({ path }) => path)).toContain('visual-evidence/office-r78-working.png');
    expect(firstManifest.files.map(({ path }) => path)).toContain('visual-evidence/office-r78-activity.png');
    expect(firstManifest.files.map(({ path }) => path)).toContain('visual-evidence/office-r78-settings.png');
    expect(await readFile(join(first.path, 'README.md'), 'utf8')).toContain('prebuilt Agent Office server');
    expect(await readFile(join(first.path, 'README.md'), 'utf8')).toContain('AgentOffice-UAT-0.1.0-uat-test');
    const distinctPackage = await buildReleasePackage(source, join(temporaryRoot, 'agent-office-0.1.0-uat-isolated'));
    expect(await readFile(join(distinctPackage.path, 'README.md'), 'utf8')).toContain('AgentOffice-UAT-0.1.0-uat-isolated');

    const packageJson = JSON.parse(await readFile(join(first.path, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['office:start']).toContain('dist/server/platform.js');
    expect(packageJson.scripts['config:validate']).toContain('dist/server/platform-cli.js');

    await writeFile(join(first.path, 'unexpected.env'), 'secret=never-ship\n');
    await expect(verifyReleasePackage(first.path)).rejects.toThrow('do not match the manifest');
  });

  it('refuses to overwrite an existing output directory', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-office-package-test-'));
    const source = join(temporaryRoot, 'source');
    await createSourceFixture(source);
    const output = join(temporaryRoot, 'existing');
    await mkdir(output);
    await writeFile(join(output, 'keep.txt'), 'keep');

    await expect(buildReleasePackage(source, output)).rejects.toThrow('already exists');
    expect(await readFile(join(output, 'keep.txt'), 'utf8')).toBe('keep');
  });
});

async function createSourceFixture(source: string): Promise<void> {
  for (const path of RELEASE_SOURCE_PATHS) {
    const isDirectory = ['docs/planning/agent-office', 'agents', 'config', 'skills', 'dist'].includes(path);
    const fullPath = join(source, ...path.split('/'));
    if (isDirectory) {
      await mkdir(fullPath, { recursive: true });
      await writeFile(join(fullPath, 'fixture.txt'), `fixture:${path}\n`);
    } else {
      await mkdir(join(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, `fixture:${path}\n`);
    }
  }
  const files = [
    'package.json',
    'package-lock.json',
    'agents/roster.yaml',
    'agents/definitions/.env.local',
    'config/models.yaml',
    'config/policies.yaml',
    'config/tools.yaml',
    'docs/planning/agent-office/README.md',
    'dist/server/platform.js',
    'dist/server/platform-cli.js',
    'dist/server/platform/db-worker.js',
    'dist/server/preview-supervisor.mjs',
    'dist/client/office.html',
  ];
  for (const file of files) {
    const path = join(source, ...file.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    const content = file === 'package.json'
      ? JSON.stringify({ name: 'agent-office', version: '0.1.0', scripts: { dev: 'dev' }, dependencies: {}, devDependencies: {} })
      : file === 'package-lock.json'
        ? JSON.stringify({ name: 'agent-office', version: '0.1.0', lockfileVersion: 3, packages: {} })
        : `fixture:${file}\n`;
    await writeFile(path, content);
  }
  await writeFile(join(source, 'docs/AGENT-OFFICE-PACKAGE-README.md'), '# Agent Office release package\n\nThis folder contains the prebuilt Agent Office server.\n\nAgentOffice-UAT-__PACKAGE_ID__\n');
  await writeFile(join(source, 'README.md'), '# Source checkout\n');
  await writeFile(join(source, '.env'), 'MODEL_PRIMARY_API_KEY=secret\n');
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareWorkspaceChecks } from '../../server/platform/executor';
import { isSafeIsolatedWorkspaceApproval, resolveFixturePath } from './baseline-safety';

describe('eval baseline isolation guards', () => {
  let root: string;

  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('resolves ordinary fixture paths under the generated workspace', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-eval-guard-'));
    expect(resolveFixturePath(root, 'src/module.ts')).toBe(resolve(root, 'src/module.ts'));
  });

  it('rejects absolute, parent, empty, dot and invalid Windows filename components', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-eval-guard-'));
    for (const path of ['../outside.txt', 'src/../../outside.txt', '', '.', 'src/', 'C:\\temp\\outside.txt', 'CON.txt']) {
      expect(() => resolveFixturePath(root, path)).toThrow();
    }
  });

  it('approves only bounded writes to relative files inside the temporary workspace', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-eval-guard-'));
    const write = JSON.stringify({ path: 'src/result.ts', content: 'export const ok = true;' });
    expect(isSafeIsolatedWorkspaceApproval('workspace.write', write, root, false)).toBe(true);
    expect(isSafeIsolatedWorkspaceApproval('workspace.write', JSON.stringify({ path: '../outside.ts', content: 'bad' }), root, false)).toBe(false);
    expect(isSafeIsolatedWorkspaceApproval('workspace.write', JSON.stringify({ path: '.env', content: 'bad' }), root, false)).toBe(false);
    expect(isSafeIsolatedWorkspaceApproval('workspace.write', JSON.stringify({ path: 'large.txt', content: 'x'.repeat(200_001) }), root, false)).toBe(false);
  });

  it('validates the runtime-normalized checksum patch approval and refuses malformed or out-of-scope payloads', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-eval-guard-'));
    const patch = JSON.stringify({ path: 'src/file.ts', expectedChecksum: 'a'.repeat(64), content: 'new' });
    expect(isSafeIsolatedWorkspaceApproval('workspace.patch', patch, root, false)).toBe(true);
    expect(isSafeIsolatedWorkspaceApproval('workspace.patch', JSON.stringify({ path: 'src/file.ts', expectedChecksum: 'bad', content: 'new' }), root, false)).toBe(false);
    expect(isSafeIsolatedWorkspaceApproval('workspace.patch', JSON.stringify({ path: 'src/file.ts', expectedChecksum: 'a'.repeat(64), content: 'x'.repeat(200_001) }), root, false)).toBe(false);
    expect(isSafeIsolatedWorkspaceApproval('memory.propose', patch, root, false)).toBe(false);
    expect(isSafeIsolatedWorkspaceApproval('workspace.write', '{', root, false)).toBe(false);
  });

  it('approves only allowlisted check scripts inside Docker mode', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-eval-guard-'));
    const checks = JSON.stringify({
      packageChecksum: 'a'.repeat(64),
      packageName: 'fixture',
      execution: { mode: 'docker', image: 'node:22@sha256:' + 'b'.repeat(64), network: 'none', installDependencies: 'none', memoryMb: 2048, cpus: 2, pidsLimit: 128 },
      checks: [
        { name: 'test', command: 'npm run test', lifecycle: [{ name: 'test', command: 'node test.js' }] },
        { name: 'typecheck', command: 'npm run typecheck', lifecycle: [{ name: 'typecheck', command: 'tsc --noEmit' }] },
      ],
    });
    expect(isSafeIsolatedWorkspaceApproval('workspace.run_checks', checks, root, true)).toBe(true);
    expect(isSafeIsolatedWorkspaceApproval('workspace.run_checks', checks, root, false)).toBe(false);
    const parsed = JSON.parse(checks) as { checks: Array<Record<string, unknown>>; execution: Record<string, unknown> };
    expect(isSafeIsolatedWorkspaceApproval('workspace.run_checks', JSON.stringify({ ...parsed, checks: [{ ...parsed.checks[0], name: 'start' }] }), root, true)).toBe(false);
    expect(isSafeIsolatedWorkspaceApproval('workspace.run_checks', JSON.stringify({ ...parsed, checks: [parsed.checks[0], parsed.checks[0]] }), root, true)).toBe(false);
    expect(isSafeIsolatedWorkspaceApproval('workspace.run_checks', JSON.stringify({ ...parsed, execution: { ...parsed.execution, network: 'bridge' } }), root, true)).toBe(false);
    expect(isSafeIsolatedWorkspaceApproval('workspace.run_checks', JSON.stringify({ ...parsed, execution: { ...parsed.execution, installDependencies: 'npm-ci' } }), root, true)).toBe(false);
    expect(isSafeIsolatedWorkspaceApproval('workspace.run_checks', JSON.stringify({ ...parsed, packageChecksum: 'bad' }), root, true)).toBe(false);
  });

  it('accepts the runtime-normalized Docker proposal shape without network or dependency installation', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-eval-guard-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node test.js' } }));
    const proposal = await prepareWorkspaceChecks(root, ['test'], {
      mode: 'docker', image: `node:22@sha256:${'a'.repeat(64)}`, network: 'none', installDependencies: 'none', memoryMb: 2048, cpus: 2, pidsLimit: 128,
    });
    expect(isSafeIsolatedWorkspaceApproval('workspace.run_checks', JSON.stringify(proposal), root, true)).toBe(true);
    expect(isSafeIsolatedWorkspaceApproval('workspace.run_checks', JSON.stringify(proposal), root, false)).toBe(false);
  });
});

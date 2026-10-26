import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockerCreateArgs, prepareWorkspaceChecks, runWorkspaceChecks, validateWorkspaceCheckProposal, type DockerCheckExecution } from './executor';

const dockerExecution: DockerCheckExecution = {
  mode: 'docker', image: 'node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213', network: 'none', installDependencies: 'none', memoryMb: 1024, cpus: 1, pidsLimit: 64,
};
const dockerNpmCiExecution: DockerCheckExecution = { ...dockerExecution, network: 'bridge', installDependencies: 'npm-ci' };
const liveDockerTests = process.env.OFFICE_DOCKER_TESTS === '1';

function dockerCheckContainers(): string[] {
  return execFileSync('docker', ['ps', '--all', '--filter', 'name=agent-office-check-', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 10_000 })
    .split(/\r?\n/).filter(Boolean).sort();
}

describe('workspace check snapshots', () => {
  let root: string;
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'agent-office-executor-test-'));
    root = join(temp, 'project');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'executor-fixture',
      scripts: {
        preverify: 'node -e "console.log(\'pre-hook-ok\')"',
        verify: 'node -e "const fs=require(\'fs\'); if(fs.existsSync(\'.env\')) process.exit(31); fs.writeFileSync(\'snapshot-output.txt\',\'temporary\'); console.log(\'snapshot-check-ok\')"',
        postverify: 'node -e "console.log(\'post-hook-ok\')"',
      },
    }));
    await writeFile(join(root, '.env'), 'MODEL_PRIMARY_API_KEY=must-not-be-copied');
    await writeFile(join(root, 'source.txt'), 'original');
  });

  afterEach(async () => rm(temp, { recursive: true, force: true }));

  it('previews lifecycle hooks and runs the approved script in a secret-free temporary copy', async () => {
    const proposal = await prepareWorkspaceChecks(root, ['verify']);

    expect(proposal.checks[0]).toMatchObject({
      name: 'verify',
      lifecycle: [{ name: 'preverify' }, { name: 'verify' }, { name: 'postverify' }],
    });
    const result = await runWorkspaceChecks(root, proposal);

    expect(result).toMatchObject({ passed: true, cancelled: false, snapshot: { isolated: true } });
    expect(result.checks[0]).toMatchObject({ outcome: 'passed', exitCode: 0 });
    expect(result.checks[0]!.stdout).toContain('pre-hook-ok');
    expect(result.checks[0]!.stdout).toContain('snapshot-check-ok');
    expect(result.checks[0]!.stdout).toContain('post-hook-ok');
    await expect(readFile(join(root, 'snapshot-output.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('original');
  });

  it('rejects a package script changed after the user reviewed it', async () => {
    const proposal = await prepareWorkspaceChecks(root, ['verify']);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'executor-fixture', scripts: { verify: 'node -e "process.exit(0)"' } }));

    await expect(runWorkspaceChecks(root, proposal)).rejects.toThrow('package.json đã thay đổi');
    await expect(readFile(join(root, 'snapshot-output.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not copy hard-linked files into the execution snapshot', async () => {
    const external = join(temp, 'outside-secret.txt');
    await writeFile(external, 'hard-linked-secret-sentinel');
    await link(external, join(root, 'public-alias.txt'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'hardlink-fixture', scripts: { verify: 'node -e "const fs=require(\'fs\'); if(fs.existsSync(\'public-alias.txt\')) process.exit(43); console.log(\'hardlink-filtered\')"' } }));
    const proposal = await prepareWorkspaceChecks(root, ['verify']);

    const result = await runWorkspaceChecks(root, proposal);

    expect(result).toMatchObject({ passed: true, snapshot: { skippedHardLinks: 1 } });
    expect(result.checks[0]?.stdout).toContain('hardlink-filtered');
    expect(await readFile(external, 'utf8')).toBe('hard-linked-secret-sentinel');
  });

  it('kills a running process tree when the user cancels checks', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'executor-fixture', scripts: { verify: 'node -e "setTimeout(()=>console.log(\'should-not-finish\'),15000)"' } }));
    const proposal = await prepareWorkspaceChecks(root, ['verify']);
    const controller = new AbortController();
    const execution = runWorkspaceChecks(root, proposal, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 800));
    controller.abort();

    const result = await execution;

    expect(result.cancelled).toBe(true);
    expect(result.checks[0]?.outcome).toBe('cancelled');
    expect(result.checks[0]?.stdout).not.toContain('should-not-finish');
  });

  it('only exposes fixed check names that exist in package.json', async () => {
    await expect(prepareWorkspaceChecks(root, ['start'])).rejects.toThrow('không hợp lệ');
    await expect(prepareWorkspaceChecks(root, ['lint'])).rejects.toThrow('không khai báo script');
    await expect(prepareWorkspaceChecks(root, ['verify', 'verify'])).rejects.toThrow('bị lặp');
  });

  it('pins the approved executor configuration and rejects a changed image or network grant', async () => {
    const proposal = await prepareWorkspaceChecks(root, ['verify'], dockerExecution);

  expect(proposal.execution).toEqual(dockerExecution);
    expect(await validateWorkspaceCheckProposal(root, proposal, dockerExecution)).toEqual(proposal);
    await expect(validateWorkspaceCheckProposal(root, proposal, { ...dockerExecution, image: 'node:other' })).rejects.toThrow('đã thay đổi sau khi bạn duyệt');
    await expect(validateWorkspaceCheckProposal(root, proposal, { ...dockerExecution, network: 'bridge' })).rejects.toThrow('đã thay đổi sau khi bạn duyệt');
  });

  it('requires and hashes a lockfile before approving container dependency installation', async () => {
    await expect(prepareWorkspaceChecks(root, ['verify'], dockerNpmCiExecution)).rejects.toThrow('cần package-lock.json');
    const lock = JSON.stringify({ name: 'executor-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'executor-fixture', version: '1.0.0' } } });
    await writeFile(join(root, 'package-lock.json'), lock);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'executor-fixture', version: '1.0.0', scripts: { preinstall: 'node -e "console.log(\'preinstall\')"', prepare: 'node -e "console.log(\'prepare\')"', verify: 'node -e "console.log(\'verify\')"' } }));

    const proposal = await prepareWorkspaceChecks(root, ['verify'], dockerNpmCiExecution);

    expect(proposal.dependencyInstall).toMatchObject({ command: 'npm ci --no-audit --no-fund', lockFile: 'package-lock.json', lifecycle: [{ name: 'preinstall' }, { name: 'prepare' }] });
    expect(proposal.dependencyInstall?.lockChecksum).toMatch(/^[a-f0-9]{64}$/);
    await expect(validateWorkspaceCheckProposal(root, proposal, dockerNpmCiExecution)).resolves.toEqual(proposal);
    await writeFile(join(root, 'package-lock.json'), `${lock}\n`);
    await expect(validateWorkspaceCheckProposal(root, proposal, dockerNpmCiExecution)).rejects.toThrow('đã thay đổi sau khi bạn duyệt');
  });

  it('builds a fixed, constrained Docker invocation without host environment forwarding', () => {
    const workspacePath = join(tmpdir(), 'temporary, workspace');
    const args = dockerCreateArgs('agent-office-check-test', workspacePath, 'verify', dockerExecution);

    expect(args).toContain('--network=none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges:true');
    expect(args).toContain('--pids-limit=64');
    expect(args).toContain('--memory=1024m');
    expect(args).toContain('--memory-swap=1024m');
    expect(args).toContain('--cpus=1');
    expect(args).toContain('--user=1000:1000');
    expect(args).toContain(`--volume=${workspacePath}:/workspace:rw`);
    expect(args).toContain('--env=CI=true');
    expect(args.some((arg) => arg.includes('.env') || /\.docker[/\\]config/.test(arg))).toBe(false);
    expect(args).not.toContain('--privileged');
    expect(() => dockerCreateArgs('bad;name', root, 'verify', dockerExecution)).toThrow('Tên Docker container không hợp lệ');
  });

  it.skipIf(!liveDockerTests)('runs the approved script in a real, offline container and removes its snapshot', async () => {
    const script = "const fs=require('node:fs');const os=require('node:os');if(fs.existsSync('.env'))process.exit(31);if(!Object.keys(os.networkInterfaces()).every((name)=>name==='lo'))process.exit(32);try{fs.writeFileSync('/outside.txt','no')}catch(error){if(!['EROFS','EACCES'].includes(error.code))throw error}fs.writeFileSync('snapshot-output.txt','temporary');console.log('docker-isolated-ok')";
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'docker-fixture', scripts: { verify: `node -e ${JSON.stringify(script)}` } }));
    const containersBefore = dockerCheckContainers();
    const proposal = await prepareWorkspaceChecks(root, ['verify'], dockerExecution);

    const result = await runWorkspaceChecks(root, proposal);

    expect(result).toMatchObject({ passed: true, cancelled: false, snapshot: { isolated: true, execution: dockerExecution } });
    expect(result.checks[0]).toMatchObject({ outcome: 'passed', exitCode: 0 });
    expect(result.checks[0]?.stdout).toContain('docker-isolated-ok');
    expect(await readFile(join(root, '.env'), 'utf8')).toContain('must-not-be-copied');
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('original');
    await expect(readFile(join(root, 'snapshot-output.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(dockerCheckContainers()).toEqual(containersBefore);
  }, 60_000);

  it.skipIf(!liveDockerTests)('mounts snapshot paths containing commas without parsing them as mount options', async () => {
    const specialTemp = await mkdtemp(join(tmpdir(), 'agent-office, temporary-'));
    const oldTemp = process.env.TEMP;
    const oldTmp = process.env.TMP;
    process.env.TEMP = specialTemp;
    process.env.TMP = specialTemp;
    try {
      const proposal = await prepareWorkspaceChecks(root, ['verify'], dockerExecution);
      const result = await runWorkspaceChecks(root, proposal);
      expect(result.passed).toBe(true);
      expect(result.checks[0]?.outcome).toBe('passed');
    } finally {
      if (oldTemp === undefined) delete process.env.TEMP; else process.env.TEMP = oldTemp;
      if (oldTmp === undefined) delete process.env.TMP; else process.env.TMP = oldTmp;
      await rm(specialTemp, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!liveDockerTests)('installs lockfile dependencies inside Docker before running checks', async () => {
    const lock = JSON.stringify({ name: 'docker-install-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'docker-install-fixture', version: '1.0.0' } } });
    const verify = "const fs=require('node:fs');if(fs.existsSync('node_modules/host-only'))process.exit(42);console.log('docker-ci-ok')";
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'docker-install-fixture', version: '1.0.0',
      scripts: {
        preinstall: 'node -e "console.log(\'preinstall-ok\')"',
        prepare: 'node -e "console.log(\'prepare-ok\')"',
        verify: `node -e ${JSON.stringify(verify)}`,
      },
    }));
    await writeFile(join(root, 'package-lock.json'), lock);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'host-only'), 'Windows host modules must not enter the Linux container.');
    const containersBefore = dockerCheckContainers();
    const proposal = await prepareWorkspaceChecks(root, ['verify'], dockerNpmCiExecution);

    const result = await runWorkspaceChecks(root, proposal);

    expect(result).toMatchObject({ passed: true, cancelled: false, snapshot: { isolated: true, execution: dockerNpmCiExecution }, dependencyInstall: { outcome: 'passed', exitCode: 0 } });
    expect(result.dependencyInstall?.stdout).toContain('preinstall-ok');
    expect(result.dependencyInstall?.stdout).toContain('prepare-ok');
    expect(result.checks[0]).toMatchObject({ outcome: 'passed', exitCode: 0 });
    expect(result.checks[0]?.stdout).toContain('docker-ci-ok');
    expect(await readFile(join(root, 'node_modules', 'host-only'), 'utf8')).toContain('must not enter');
    expect(dockerCheckContainers()).toEqual(containersBefore);
  }, 90_000);

  it.skipIf(!liveDockerTests)('stops and removes a running container when its execution is cancelled', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'docker-cancel-fixture', scripts: { verify: 'node -e "setTimeout(()=>console.log(\'should-not-finish\'),15000)"' } }));
    const containersBefore = dockerCheckContainers();
    const proposal = await prepareWorkspaceChecks(root, ['verify'], dockerExecution);
    const controller = new AbortController();
    const execution = runWorkspaceChecks(root, proposal, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    controller.abort();

    const result = await execution;

    expect(result.cancelled).toBe(true);
    expect(result.checks[0]?.outcome).toBe('cancelled');
    expect(result.checks[0]?.stdout).not.toContain('should-not-finish');
    expect(dockerCheckContainers()).toEqual(containersBefore);
  }, 60_000);
});

import { spawn } from 'node:child_process';

const encoded = process.argv[2];
if (!encoded) process.exit(2);
const config = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
let child;
let stopped = false;
let stopping;

function send(message) {
  if (process.connected) process.send(message);
}

function spawnCli(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const cli = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    cli.stdout?.on('data', (chunk) => { if (stdout.length < 8000) stdout += chunk.toString('utf8').slice(0, 8000 - stdout.length); });
    cli.stderr?.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk.toString('utf8').slice(0, 8000 - stderr.length); });
    cli.once('error', reject);
    cli.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function killTree(target) {
  if (!target?.pid) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    await spawnCli(`${systemRoot}\\System32\\taskkill.exe`, ['/PID', String(target.pid), '/T', '/F']).catch(() => target.kill('SIGKILL'));
    return;
  }
  try { process.kill(-target.pid, 'SIGTERM'); } catch { target.kill('SIGTERM'); }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try { process.kill(-target.pid, 'SIGKILL'); } catch { target.kill('SIGKILL'); }
}

async function stop(reason) {
  if (stopping) return stopping;
  stopped = true;
  stopping = (async () => {
    clearInterval(containerPoll);
    clearTimeout(ttl);
    if (config.mode === 'docker') {
      await spawnCli('docker', ['rm', '--force', config.containerName], { env: process.env }).catch(() => undefined);
    } else {
      await killTree(child);
    }
    send({ type: 'stopped', reason });
    process.exitCode = 0;
    process.disconnect?.();
  })();
  return stopping;
}

process.on('message', (message) => { if (message?.type === 'stop') void stop('owner'); });
process.on('disconnect', () => { void stop('owner_disconnected'); });
process.once('SIGTERM', () => { void stop('sigterm'); });
process.once('SIGINT', () => { void stop('sigint'); });
const ttl = setTimeout(() => { void stop('ttl_expired'); }, config.ttlMs);
ttl.unref();

let containerPoll;
try {
  if (config.mode === 'docker') {
    const result = await spawnCli('docker', config.dockerArgs, { env: process.env });
    if (result.code !== 0 || stopped) throw new Error(`Docker preview could not start. ${result.stderr.slice(0, 1000)}`);
    send({ type: 'started', containerName: config.containerName });
    containerPoll = setInterval(async () => {
      if (stopped) return;
      const state = await spawnCli('docker', ['inspect', '--format', '{{.State.Running}}', config.containerName], { env: process.env }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
      if (state.code !== 0 || state.stdout.trim() !== 'true') {
        send({ type: 'process_exit', code: null, detail: 'Preview container exited.' });
        void stop('container_exited');
      }
    }, 2000);
    containerPoll.unref();
  } else {
    child = spawn(process.execPath, [config.npmCli, '--silent', 'run', config.script, ...config.npmArgs], {
      cwd: config.cwd,
      env: { ...process.env, ...config.previewEnv },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    child.stdout?.pipe(process.stdout, { end: false });
    child.stderr?.pipe(process.stderr, { end: false });
    child.once('error', (error) => { send({ type: 'process_error', message: error.message }); void stop('spawn_error'); });
    child.once('close', (code, signal) => {
      send({ type: 'process_exit', code, signal });
      if (!stopped) void stop('process_exited');
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    send({ type: 'started', pid: child.pid });
  }
} catch (error) {
  send({ type: 'start_error', message: error instanceof Error ? error.message : 'Preview start failed.' });
  await stop('start_error');
}

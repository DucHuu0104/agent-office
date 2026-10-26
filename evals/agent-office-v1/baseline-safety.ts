import { isAbsolute, relative, resolve, sep } from 'node:path';

const allowedScripts = new Set(['test', 'test:unit', 'test:e2e', 'typecheck', 'build', 'lint', 'check', 'verify']);
const sensitiveSegments = new Set(['.env', '.git', '.claude', '.codex', 'node_modules', 'secrets', 'credentials']);

export function resolveFixturePath(workspaceRoot: string, fixturePath: string): string {
  const parts = fixturePath.split(/[\\/]/);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (!fixturePath || isAbsolute(fixturePath) || parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\0]/.test(part) || /[ .]$/.test(part) || reserved.test(part))) {
    throw new Error('Eval fixture path is not a safe relative path.');
  }
  const root = resolve(workspaceRoot);
  const target = resolve(root, fixturePath);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Eval fixture path escapes the workspace.');
  return target;
}

export function isSafeIsolatedWorkspaceApproval(
  toolId: string,
  rawArguments: string,
  workspaceRoot: string,
  dockerChecks: boolean,
): boolean {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    args = parsed as Record<string, unknown>;
  } catch { return false; }
  if (toolId === 'workspace.run_checks') {
    const execution = args.execution;
    if (!dockerChecks || !execution || typeof execution !== 'object' || Array.isArray(execution)) return false;
    const docker = execution as Record<string, unknown>;
    if (typeof args.packageChecksum !== 'string' || !/^[a-f0-9]{64}$/i.test(args.packageChecksum) || typeof args.packageName !== 'string'
      || docker.mode !== 'docker' || docker.network !== 'none' || docker.installDependencies !== 'none'
      || typeof docker.image !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/i.test(docker.image)
      || !Number.isFinite(docker.memoryMb) || Number(docker.memoryMb) < 128 || Number(docker.memoryMb) > 8192
      || !Number.isFinite(docker.cpus) || Number(docker.cpus) <= 0 || Number(docker.cpus) > 16
      || !Number.isInteger(docker.pidsLimit) || Number(docker.pidsLimit) < 1 || Number(docker.pidsLimit) > 512
      || args.dependencyInstall !== undefined
      || !Array.isArray(args.checks) || args.checks.length < 1 || args.checks.length > 4) return false;
    const names = args.checks.map((check) => check && typeof check === 'object' && !Array.isArray(check) ? (check as Record<string, unknown>).name : null);
    return names.every((name) => typeof name === 'string' && allowedScripts.has(name)) && new Set(names).size === names.length;
  }
  if (toolId !== 'workspace.write' && toolId !== 'workspace.patch') return false;
  if (typeof args.path !== 'string') return false;
  let target: string;
  try { target = resolveFixturePath(workspaceRoot, args.path); }
  catch { return false; }
  const rel = relative(resolve(workspaceRoot), target);
  if (rel.split(/[\\/]/).some((part) => sensitiveSegments.has(part.toLowerCase()))) return false;
  if (toolId === 'workspace.write') return typeof args.content === 'string' && Buffer.byteLength(args.content, 'utf8') <= 200_000;
  // The runtime validates the proposed edits before requesting approval, then stores
  // the exact replacement content plus the source checksum in the approval record.
  return typeof args.content === 'string'
    && Buffer.byteLength(args.content, 'utf8') <= 200_000
    && typeof args.expectedChecksum === 'string'
    && /^[a-f0-9]{64}$/i.test(args.expectedChecksum);
}

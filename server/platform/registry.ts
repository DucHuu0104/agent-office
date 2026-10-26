import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { agentHooksSchema, type AgentHookConfiguration } from './hook-contracts';

const instructionFiles = z.object({ system: z.string(), soul: z.string(), toolNotes: z.string() }).strict();
const definitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  version: z.string().min(1).max(40),
  displayName: z.string().min(1).max(80),
  kind: z.enum(['coordinator', 'specialist']),
  capabilities: z.array(z.string().min(1)).min(1),
  modelProfile: z.string().min(1),
  instructions: instructionFiles,
  skills: z.array(z.string()),
  allowedTools: z.array(z.string()),
  memoryScopes: z.array(z.enum(['user', 'agent', 'project', 'run'])),
  hooks: z.string(),
  limits: z.object({
    maxConcurrentAssignments: z.number().int().min(1).max(4),
    maxModelTurns: z.number().int().min(1).max(32),
    maxToolCalls: z.number().int().min(0).max(100),
    runTimeoutSeconds: z.number().int().min(30).max(3600),
  }).strict(),
}).strict();

const rosterSchema = z.object({
  schemaVersion: z.literal(1),
  instances: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    definition: z.string(),
    displayName: z.string().min(1).max(80),
    enabled: z.boolean(),
    appearanceSeed: z.number().int().min(0).max(2_147_483_647),
  }).strict()),
}).strict();

const profileSchema = z.object({
  protocol: z.enum(['chat-completions', 'responses']),
  baseUrlEnv: z.string(),
  apiKeyEnv: z.string(),
  modelEnv: z.string(),
  maxOutputTokens: z.number().int().min(1).max(32768),
  requestTimeoutSeconds: z.number().int().min(1).max(600),
  capabilityRequirements: z.array(z.string()),
  pricing: z.object({
    version: z.string().min(1).max(40),
    modelName: z.string().min(1).max(120),
    inputUsdPerMillionTokens: z.number().nonnegative().max(1_000_000),
    outputUsdPerMillionTokens: z.number().nonnegative().max(1_000_000),
  }).strict().optional(),
}).strict();

export interface AgentDefinition {
  manifest: z.infer<typeof definitionSchema>;
  configHash: string;
  system: string;
  soul: string;
  tools: string;
  hooks: AgentHookConfiguration;
}

export interface AgentRosterEntry {
  id: string;
  definition: string;
  displayName: string;
  enabled: boolean;
  appearanceSeed: number;
}

export interface ModelProfile {
  id: string;
  protocol: 'chat-completions' | 'responses';
  baseUrlEnv: string;
  apiKeyEnv: string;
  modelEnv: string;
  maxOutputTokens: number;
  requestTimeoutSeconds: number;
  capabilityRequirements: string[];
  pricing?: {
    version: string;
    modelName: string;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  };
}

export interface PlatformPolicy {
  limits: {
    maxRunningExecutions: number;
    maxSpecialistExecutions: number;
    maxConcurrentModelRequests: number;
    maxConcurrentRequestsPerProvider: number;
    maxTasksPerRun: number;
    maxDelegationDepth: number;
    maxModelTurnsPerExecution: number;
    maxToolCallsPerExecution: number;
    maxOutputTokensPerCall: number;
    maxTokensPerRun: number;
    moneyBudgetUsd: number | null;
  };
  approvals: { workspaceWrite: string; externalWrite: string; shell: 'disabled' | 'docker' | 'local-trusted' };
}

export interface Registry {
  definitions: Map<string, AgentDefinition>;
  roster: AgentRosterEntry[];
  skills: Map<string, { version: string; instructions: string }>;
  profiles: Map<string, ModelProfile>;
  tools: Map<string, string>;
  policy: PlatformPolicy;
  revision: string;
}

export interface RegistryReloadDiff {
  currentRevision: string;
  candidateRevision: string;
  addedDefinitions: Array<{ id: string; version: string; displayName: string; capabilities: string[] }>;
  addedAgents: Array<{ id: string; definition: string; displayName: string }>;
  blockers: string[];
  canApply: boolean;
}

export function previewRegistryAdditions(current: Registry, candidate: Registry): RegistryReloadDiff {
  const blockers: string[] = [];
  for (const [id, existing] of current.definitions) {
    const next = candidate.definitions.get(id);
    if (!next) blockers.push(`Không thể xóa definition đang cài: ${id}.`);
    else if (next.configHash !== existing.configHash || next.manifest.version !== existing.manifest.version) blockers.push(`Definition ${id} đã thay đổi; cập nhật definition hiện có cần khởi động lại.`);
  }
  for (const [id, existing] of current.skills) {
    const next = candidate.skills.get(id);
    if (!next || next.version !== existing.version || next.instructions !== existing.instructions) blockers.push(`Skill ${id} đã thay đổi; cập nhật skill hiện có cần khởi động lại.`);
  }
  for (const [id, effect] of current.tools) if (candidate.tools.get(id) !== effect) blockers.push(`Tool ${id} đã thay đổi hoặc bị xóa.`);
  if (candidate.tools.size !== current.tools.size) blockers.push('Không thể thêm hoặc xóa tool khi đang chạy; tool mới cần implementation trong runtime.');
  if (!sameEntries(current.profiles, candidate.profiles)) blockers.push('Thay đổi model profile cần khởi động lại để nạp biến môi trường.');
  if (JSON.stringify(current.policy) !== JSON.stringify(candidate.policy)) blockers.push('Thay đổi policy cần khởi động lại để áp dụng an toàn.');

  for (const existing of current.roster) {
    const next = candidate.roster.find((entry) => entry.id === existing.id);
    if (!next) blockers.push(`Không thể xóa agent roster đang cài: ${existing.id}.`);
    else if (next.definition !== existing.definition || next.displayName !== existing.displayName || next.enabled !== existing.enabled || next.appearanceSeed !== existing.appearanceSeed) blockers.push(`Roster ${existing.id} đã thay đổi; reload nóng chỉ thêm agent mới.`);
  }

  const addedDefinitions = [...candidate.definitions.values()].filter((definition) => !current.definitions.has(definition.manifest.id)).map((definition) => ({
    id: definition.manifest.id,
    version: definition.manifest.version,
    displayName: definition.manifest.displayName,
    capabilities: [...definition.manifest.capabilities],
  }));
  const addedAgents = candidate.roster.filter((entry) => !current.roster.some((existing) => existing.id === entry.id)).map((entry) => ({
    id: entry.id, definition: entry.definition, displayName: entry.displayName,
  }));
  for (const definition of addedDefinitions) {
    if (candidate.definitions.get(definition.id)?.manifest.kind !== 'specialist') blockers.push(`Chỉ có thể nạp specialist mới: ${definition.id}.`);
  }
  if (!addedAgents.length) blockers.push('Không tìm thấy agent roster mới để nạp.');
  return {
    currentRevision: current.revision,
    candidateRevision: candidate.revision,
    addedDefinitions,
    addedAgents,
    blockers,
    canApply: blockers.length === 0,
  };
}

function sameEntries<K, V>(current: Map<K, V>, candidate: Map<K, V>): boolean {
  return current.size === candidate.size && [...current].every(([key, value]) => JSON.stringify(value) === JSON.stringify(candidate.get(key)));
}

async function readInside(root: string, relativePath: string): Promise<string> {
  if (relativePath.includes('\0') || relativePath.split(/[\\/]/).includes('..')) throw new Error(`Đường dẫn package không hợp lệ: ${relativePath}`);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(candidate) === resolve(root)) throw new Error(`Đường dẫn package vượt khỏi thư mục: ${relativePath}`);
  const [realRoot, realCandidate, stat] = await Promise.all([realpath(root), realpath(candidate), lstat(candidate)]);
  if (stat.isSymbolicLink()) throw new Error(`Không chấp nhận symlink trong package: ${relativePath}`);
  const realRel = relative(realRoot, realCandidate);
  if (realRel === '..' || realRel.startsWith(`..${sep}`)) throw new Error(`Symlink vượt khỏi package: ${relativePath}`);
  return readFile(realCandidate, 'utf8');
}

function parseYaml<T>(source: string, schema: z.ZodType<T>, label: string): T {
  let data: unknown;
  try {
    data = parse(source, { maxAliasCount: 20, uniqueKeys: true });
  } catch (error) {
    throw new Error(`${label}: YAML lỗi (${error instanceof Error ? error.message : 'không rõ'}).`);
  }
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`${label}: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return result.data;
}

export async function loadRegistry(rootDir: string): Promise<Registry> {
  const agentsRoot = join(rootDir, 'agents');
  const definitionsDir = join(agentsRoot, 'definitions');
  const definitionEntries = (await readdir(definitionsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const definitions = new Map<string, AgentDefinition>();
  const hashes: string[] = [];
  for (const entry of definitionEntries) {
    const dir = join(definitionsDir, entry.name);
    const rawManifest = await readInside(dir, 'agent.yaml');
    const manifest = parseYaml(rawManifest, definitionSchema, `${entry.name}/agent.yaml`);
    if (manifest.id !== entry.name) throw new Error(`${entry.name}/agent.yaml: id phải khớp tên thư mục.`);
    const [system, soul, tools, hooksRaw] = await Promise.all([
      readInside(dir, manifest.instructions.system),
      readInside(dir, manifest.instructions.soul),
      readInside(dir, manifest.instructions.toolNotes),
      readInside(dir, manifest.hooks),
    ]);
    const hooks = parseYaml(hooksRaw, agentHooksSchema, `${entry.name}/${manifest.hooks}`);
    const configHash = createHash('sha256').update([rawManifest, system, soul, tools, hooksRaw].join('\0')).digest('hex');
    definitions.set(manifest.id, { manifest, configHash, system, soul, tools, hooks });
    hashes.push(configHash);
  }
  const rosterRaw = await readFile(join(agentsRoot, 'roster.yaml'), 'utf8');
  const roster = parseYaml(rosterRaw, rosterSchema, 'agents/roster.yaml').instances;
  const seenInstances = new Set<string>();
  for (const item of roster) {
    if (seenInstances.has(item.id)) throw new Error(`agents/roster.yaml: instance lặp: ${item.id}`);
    seenInstances.add(item.id);
    const definition = definitions.get(item.definition);
    if (!definition || definition.manifest.kind !== 'specialist') throw new Error(`Roster ${item.id} tham chiếu specialist không hợp lệ: ${item.definition}`);
  }
  const modelRaw = await readFile(join(rootDir, 'config', 'models.yaml'), 'utf8');
  const modelDoc = parseYaml(modelRaw, z.object({
    schemaVersion: z.literal(1),
    profiles: z.record(z.string(), profileSchema),
  }).strict(), 'config/models.yaml');
  const profiles = new Map(Object.entries(modelDoc.profiles).map(([id, profile]) => [id, { id, ...profile }]));
  const toolsRaw = await readFile(join(rootDir, 'config', 'tools.yaml'), 'utf8');
  const toolsDoc = parseYaml(toolsRaw, z.object({
    schemaVersion: z.literal(1), tools: z.array(z.object({ id: z.string(), effect: z.enum(['internal', 'local-read', 'local-write', 'process-exec', 'network-read', 'external-write']) }).strict()),
  }).strict(), 'config/tools.yaml');
  const tools = new Map(toolsDoc.tools.map((tool) => [tool.id, tool.effect]));
  if (tools.size !== toolsDoc.tools.length) throw new Error('config/tools.yaml: tool ID bị trùng.');
  const policyRaw = await readFile(join(rootDir, 'config', 'policies.yaml'), 'utf8');
  const policy = parseYaml(policyRaw, z.object({
    schemaVersion: z.literal(1),
    limits: z.object({
      maxRunningExecutions: z.number().int().min(1).max(16), maxSpecialistExecutions: z.number().int().min(1).max(12),
      maxConcurrentModelRequests: z.number().int().min(1).max(32), maxConcurrentRequestsPerProvider: z.number().int().min(1).max(16),
      maxTasksPerRun: z.number().int().min(1).max(32), maxDelegationDepth: z.number().int().min(1).max(4),
      maxModelTurnsPerExecution: z.number().int().min(1).max(64), maxToolCallsPerExecution: z.number().int().min(0).max(256),
      maxOutputTokensPerCall: z.number().int().min(1).max(32768), maxTokensPerRun: z.number().int().min(1024).max(2_000_000),
      moneyBudgetUsd: z.number().min(0.000001).max(1_000_000).nullable().optional().default(null),
    }).strict(),
    approvals: z.object({ workspaceWrite: z.string(), externalWrite: z.string(), shell: z.enum(['disabled', 'docker', 'local-trusted']) }).strict(),
  }).strict(), 'config/policies.yaml');
  for (const definition of definitions.values()) {
    if (!profiles.has(definition.manifest.modelProfile)) throw new Error(`Agent ${definition.manifest.id} tham chiếu model profile không tồn tại.`);
    for (const tool of definition.manifest.allowedTools) if (!tools.has(tool)) throw new Error(`Agent ${definition.manifest.id} tham chiếu tool không tồn tại: ${tool}`);
    for (const skill of definition.manifest.skills) {
      if (!(await exists(join(rootDir, 'skills', skill, 'skill.yaml')))) throw new Error(`Agent ${definition.manifest.id} thiếu skill ${skill}.`);
    }
  }
  const skills = new Map<string, { version: string; instructions: string }>();
  for (const skillDir of await readdir(join(rootDir, 'skills'), { withFileTypes: true })) {
    if (!skillDir.isDirectory()) continue;
    const dir = join(rootDir, 'skills', skillDir.name);
    const skillManifest = parseYaml(await readFile(join(dir, 'skill.yaml'), 'utf8'), z.object({
      schemaVersion: z.literal(1), id: z.string(), version: z.string(), description: z.string(), requiredTools: z.array(z.string()),
    }).strict(), `${skillDir.name}/skill.yaml`);
    if (skillManifest.id !== skillDir.name) throw new Error(`${skillDir.name}/skill.yaml: id phải khớp tên thư mục.`);
    skills.set(skillDir.name, { version: skillManifest.version, instructions: await readFile(join(dir, 'SKILL.md'), 'utf8') });
  }
  for (const definition of definitions.values()) for (const skill of definition.manifest.skills) if (!skills.has(skill)) throw new Error(`Agent ${definition.manifest.id} thiếu skill ${skill}.`);
  for (const [id, skill] of skills) hashes.push(createHash('sha256').update(`${id}\0${skill.version}\0${skill.instructions}`).digest('hex'));
  hashes.push(createHash('sha256').update(rosterRaw + modelRaw + toolsRaw + policyRaw).digest('hex'));
  return { definitions, roster, skills, profiles, tools, policy, revision: createHash('sha256').update(hashes.sort().join(':')).digest('hex') };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

import { z } from 'zod';

export const idSchema = z.string().min(1).max(160);
export const projectStatusSchema = z.enum(['active', 'archived']);
export const agentAvailabilitySchema = z.enum(['ready', 'reserved', 'busy', 'draining', 'unavailable', 'disabled']);
export const executionStateSchema = z.enum(['ready', 'running', 'waiting', 'blocked']);
export const locationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pool') }),
  z.object({ kind: z.literal('project'), projectId: idSchema }),
]);

export const projectSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  goal: z.string().max(4000),
  status: projectStatusSchema,
  roomOrdinal: z.number().int().nonnegative(),
  coordinatorInstanceId: idSchema,
  conversationId: idSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const agentSchema = z.object({
  id: idSchema,
  definitionId: idSchema,
  displayName: z.string().min(1).max(80),
  role: z.enum(['coordinator', 'specialist']),
  capabilities: z.array(z.string()),
  availability: agentAvailabilitySchema,
  execution: executionStateSchema,
  location: locationSchema,
  projectId: idSchema.nullable(),
  currentTaskId: idSchema.nullable(),
  modelProfile: z.string(),
  appearanceSeed: z.number().int(),
  updatedAt: z.string().datetime(),
});

export const messageAttachmentSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  mimeType: z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json']),
  sizeBytes: z.number().int().nonnegative().max(65_536),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});

export const messageSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  runId: idSchema.nullable(),
  speaker: z.enum(['user', 'coordinator', 'specialist', 'system']),
  agentInstanceId: idSchema.nullable(),
  content: z.string(),
  attachments: z.array(messageAttachmentSchema).max(5).optional(),
  status: z.enum(['accepted', 'streaming', 'completed', 'failed']),
  createdAt: z.string().datetime(),
});

export const taskSchema = z.object({
  id: idSchema,
  runId: idSchema,
  key: idSchema,
  title: z.string().min(1).max(180),
  objective: z.string().min(1).max(8000),
  requiredCapabilities: z.array(z.string()).min(1),
  dependencies: z.array(idSchema),
  status: z.enum(['proposed', 'blocked_dependencies', 'ready', 'assigned', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled']),
  assignedAgentId: idSchema.nullable(),
  output: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const officeSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  serverTime: z.string().datetime(),
  projects: z.array(projectSchema),
  agents: z.array(agentSchema),
  activeRuns: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
});

export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(4000).default(''),
  workspaceRoot: z.string().trim().max(1024).optional(),
});

export const messageAttachmentInputSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json']),
  content: z.string().max(65_536),
}).strict();

export const sendMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(20000),
  mode: z.enum(['new-run', 'enqueue', 'steer']).default('new-run'),
  targetTaskId: idSchema.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  attachments: z.array(messageAttachmentInputSchema).max(5).optional(),
}).strict();

export const approvalDecisionRequestSchema = z.object({ decision: z.enum(['approve', 'deny']) }).strict();
export const pauseRunRequestSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
export const approvedRunBudgetSchema = z.object({
  tokenBudget: z.number().int().min(1_024).max(10_000_000).optional(),
  moneyBudgetUsd: z.number().positive().max(1_000_000).optional(),
}).strict().refine((budget) => budget.tokenBudget !== undefined || budget.moneyBudgetUsd !== undefined, 'At least one budget limit is required.');
export const resumeRunRequestSchema = z.object({ expectedVersion: z.number().int().min(1), approvedBudget: approvedRunBudgetSchema.optional() }).strict();

export const coordinatorPlanSchema = z.object({
  goal: z.string().min(1).max(4000),
  successCriteria: z.array(z.string().min(1).max(500)).min(1).max(12),
  tasks: z.array(z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    title: z.string().min(1).max(180),
    objective: z.string().min(1).max(8000),
    capability: z.string().min(1).max(120),
    dependsOn: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(12),
  })).max(12),
  responseToUser: z.string().max(8000).default(''),
});

export const eventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: idSchema,
  sequence: z.number().int().positive(),
  type: z.string().min(1).max(100),
  projectId: idSchema.nullable(),
  aggregateId: idSchema,
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});

/** Local-only activity for the office canvas. It carries an allow-listed tool ID and a sanitized label, never tool arguments. */
export const officeToolActivitySchema = z.object({
  eventId: idSchema,
  projectId: idSchema,
  taskId: idSchema,
  agentInstanceId: idSchema,
  toolId: z.enum([
    'memory.search', 'memory.propose', 'artifacts.create', 'research.search', 'research.fetch', 'analysis.csv_summary',
    'workspace.list', 'workspace.read', 'workspace.write', 'workspace.patch', 'workspace.run_checks',
  ]),
  target: z.string().max(80).optional(),
  createdAt: z.string().datetime(),
}).strict();

export const coordinatorClarificationSchema = z.object({
  question: z.string().trim().min(1).max(1000),
}).strict();

export type Project = z.infer<typeof projectSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;
export type MessageAttachmentInput = z.infer<typeof messageAttachmentInputSchema>;
export type Task = z.infer<typeof taskSchema>;
export type OfficeSnapshot = z.infer<typeof officeSnapshotSchema>;
export type CoordinatorPlan = z.infer<typeof coordinatorPlanSchema>;
export type MemoryScopeType = 'user' | 'agent' | 'project' | 'run';
export interface MemoryRecord {
  id: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  projectId: string | null;
  content: string;
  sourceType: string;
  sourceRef: string | null;
  sourceVersion: string | null;
  sourceChecksum: string | null;
  createdBy: string;
  confidenceLabel: string;
  status: 'proposed' | 'accepted' | 'rejected';
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectMemoryRecord extends MemoryRecord {
  scopeType: 'project';
  projectId: string;
}
export type DomainEvent = z.infer<typeof eventEnvelopeSchema>;
export type OfficeToolActivity = z.infer<typeof officeToolActivitySchema>;

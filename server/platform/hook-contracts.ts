import { z } from 'zod';

export const hookEventSchema = z.enum([
  'before_run', 'before_model_call', 'after_model_call', 'before_tool_call', 'after_tool_call', 'on_handoff', 'after_run', 'on_error',
]);
export type AgentHookEvent = z.infer<typeof hookEventSchema>;

export const hookHandlerSchema = z.enum(['context.load_project', 'policy.audit_intent', 'memory.propose_summary', 'lifecycle.audit']);
export type HookHandlerId = z.infer<typeof hookHandlerSchema>;

const handlerEvents: Record<HookHandlerId, readonly AgentHookEvent[]> = {
  'context.load_project': ['before_run'],
  'policy.audit_intent': ['before_tool_call'],
  'memory.propose_summary': ['after_run'],
  'lifecycle.audit': hookEventSchema.options,
};

const hookConfigSchema = z.object({
  handler: hookHandlerSchema,
  timeoutMs: z.number().int().min(50).max(30_000),
  onError: z.enum(['fail', 'warn']),
}).strict();

const hooksByEventSchema = z.object({
  before_run: z.array(hookConfigSchema).max(20).optional(),
  before_model_call: z.array(hookConfigSchema).max(20).optional(),
  after_model_call: z.array(hookConfigSchema).max(20).optional(),
  before_tool_call: z.array(hookConfigSchema).max(20).optional(),
  after_tool_call: z.array(hookConfigSchema).max(20).optional(),
  on_handoff: z.array(hookConfigSchema).max(20).optional(),
  after_run: z.array(hookConfigSchema).max(20).optional(),
  on_error: z.array(hookConfigSchema).max(20).optional(),
}).strict();

export const agentHooksSchema = z.object({
  schemaVersion: z.literal(1),
  hooks: hooksByEventSchema,
}).strict().superRefine((value, ctx) => {
  for (const event of hookEventSchema.options) {
    for (const [index, hook] of (value.hooks[event] ?? []).entries()) {
      if (!handlerEvents[hook.handler].includes(event)) ctx.addIssue({
        code: 'custom', path: ['hooks', event, index, 'handler'],
        message: `Handler ${hook.handler} is not registered for ${event}.`,
      });
    }
  }
});

export type AgentHook = z.infer<typeof hookConfigSchema>;
export type AgentHooks = z.infer<typeof hooksByEventSchema>;
export type AgentHookConfiguration = z.infer<typeof agentHooksSchema>;

import { basename, maskSecrets, truncate } from '../../shared/activity';
import { officeToolActivitySchema, type OfficeToolActivity } from '../../shared/platform/contracts';

/** Build a local live-activity event without retaining or sending tool arguments to the browser. */
export function createOfficeToolActivity(input: {
  eventId: string;
  projectId: string;
  taskId: string;
  agentInstanceId: string;
  toolId: string;
  argumentsRaw: string;
  createdAt?: string;
}): OfficeToolActivity {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(input.argumentsRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch { /* Malformed arguments get a generic activity label; tool validation handles the error. */ }

  const target = activityTarget(input.toolId, args);
  return officeToolActivitySchema.parse({
    eventId: input.eventId,
    projectId: input.projectId,
    taskId: input.taskId,
    agentInstanceId: input.agentInstanceId,
    toolId: input.toolId,
    ...(target ? { target } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

function activityTarget(toolId: string, args: Record<string, unknown>): string | undefined {
  let value: string | undefined;
  if (['workspace.list', 'workspace.read', 'workspace.write', 'workspace.patch'].includes(toolId)) {
    const path = stringValue(args.path);
    value = path ? basename(path) : toolId === 'workspace.list' ? 'workspace' : undefined;
  } else if (toolId === 'research.search') {
    value = stringValue(args.query);
  } else if (toolId === 'research.fetch') {
    const url = stringValue(args.url);
    try { value = url ? new URL(url).hostname : undefined; } catch { value = undefined; }
  } else if (toolId === 'artifacts.create') {
    const name = stringValue(args.name);
    value = name ? basename(name) : undefined;
  } else if (toolId === 'memory.search') {
    value = stringValue(args.query);
  } else if (toolId === 'workspace.run_checks') {
    const scripts = Array.isArray(args.scripts) ? args.scripts.filter((item): item is string => typeof item === 'string' && /^[a-z][a-z0-9:_-]{0,31}$/i.test(item)) : [];
    value = scripts.length ? scripts.join(', ') : undefined;
  }

  if (!value) return undefined;
  const clean = maskSecrets(value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim());
  return clean ? truncate(clean, 64) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

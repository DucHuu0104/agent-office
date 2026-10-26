import type { Activity } from '../../../shared/types';
import { officeToolActivitySchema, type Agent, type DomainEvent, type Project, type Task } from '../../../shared/platform/contracts';
import { tr } from './i18n';

export interface OfficeVisualEvent {
  id: string;
  projectId: string | null;
  agentId: string | null;
  taskId: string | null;
  agentName: string;
  projectName: string;
  icon: string;
  text: string;
  at: number;
  mood: 'normal' | 'success' | 'error' | 'question';
  activityKind: Activity['kind'];
}

export interface OfficeVisualContext {
  agents: readonly Agent[];
  projects: readonly Project[];
  tasks: readonly Task[];
}

/** Turn allow-listed operational events into short office activity. Raw prompts, model text and tool arguments never enter the visual feed. */
export function toOfficeVisualEvent(event: DomainEvent, context: OfficeVisualContext): OfficeVisualEvent | null {
  const payload = event.payload;
  const taskId = stringValue(payload.taskId);
  const task = taskId ? context.tasks.find((item) => item.id === taskId) : undefined;
  const project = event.projectId ? context.projects.find((item) => item.id === event.projectId) : undefined;
  const explicitAgentId = stringValue(payload.agentInstanceId);
  const taskAgentId = task?.assignedAgentId ?? context.agents.find((item) => item.currentTaskId === taskId)?.id;
  const projectAgent = project ? context.agents.find((item) => item.id === project.coordinatorInstanceId) : undefined;
  let agent = explicitAgentId ? context.agents.find((item) => item.id === explicitAgentId) : undefined;
  let icon = '';
  let text = '';
  let mood: OfficeVisualEvent['mood'] = 'normal';
  let activityKind: Activity['kind'] = 'other';

  switch (event.type) {
    case 'project.created':
      icon = '🏠'; text = tr('Nova sala pronta'); break;
    case 'run.created':
      agent ??= projectAgent; icon = '💭'; text = tr('Coordinator está planejando'); activityKind = 'plan'; break;
    case 'run.status_changed': {
      agent ??= projectAgent;
      const status = stringValue(payload.status);
      if (status === 'planning') { icon = '🧠'; text = tr('Planejando'); activityKind = 'plan'; }
      else if (status === 'executing') { icon = '🧭'; text = tr('Coordenando tarefas'); activityKind = 'delegate'; }
      else if (status === 'waiting_approval') { icon = '✋'; text = tr('Execução aguardando aprovação'); mood = 'question'; activityKind = 'ask'; }
      else if (status === 'succeeded') { icon = '✅'; text = tr('Execução concluída'); mood = 'success'; activityKind = 'done'; }
      else if (status === 'failed' || status === 'interrupted') { icon = '🚨'; text = tr('Falha na execução'); mood = 'error'; activityKind = 'error'; }
      else if (status === 'cancelled') { icon = '⏹️'; text = tr('Execução interrompida'); activityKind = 'done'; }
      break;
    }
    case 'execution.started':
      agent ??= taskAgentId ? context.agents.find((item) => item.id === taskAgentId) : undefined;
      icon = '💭'; text = task ? tr('Trabalhando em: {0}', [task.title]) : tr('Processando uma tarefa'); activityKind = 'think'; break;
    case 'approval.requested':
      agent ??= taskAgentId ? context.agents.find((item) => item.id === taskAgentId) : undefined;
      icon = '✋'; text = tr('Ação precisa de sua aprovação'); mood = 'question'; activityKind = 'ask'; break;
    case 'task.status_changed': {
      const status = stringValue(payload.status);
      agent ??= taskAgentId ? context.agents.find((item) => item.id === taskAgentId) : undefined;
      if (status === 'succeeded') { icon = '✅'; text = task ? tr('Concluída: {0}', [task.title]) : tr('Agent concluiu uma tarefa'); mood = 'success'; activityKind = 'done'; }
      else if (status === 'failed') { icon = '🚨'; text = task ? tr('Falha na tarefa: {0}', [task.title]) : tr('Agent encontrou um erro na tarefa'); mood = 'error'; activityKind = 'error'; }
      else return null;
      break;
    }
    case 'message.completed':
      agent ??= explicitAgentId ? undefined : projectAgent;
      icon = '💬'; text = tr('Resultado enviado'); activityKind = 'respond'; break;
    case 'agent.draining':
      icon = '⏸️'; text = tr('Agent pausou novas tarefas'); activityKind = 'wait'; break;
    case 'agent.resumed':
      icon = '↻'; text = tr('Agent pronto para novas tarefas'); activityKind = 'other'; break;
    default:
      return null;
  }

  if (!text) return null;
  const agentId = agent?.id ?? explicitAgentId ?? null;
  const agentName = agent?.displayName ?? tr('Coordenador');
  return {
    id: event.eventId,
    projectId: event.projectId,
    agentId,
    taskId,
    agentName,
    projectName: project?.name ?? tr('Pool compartilhado'),
    icon,
    text: truncateActivity(text),
    at: Date.parse(event.occurredAt),
    mood,
    activityKind,
  };
}

/** Convert the local, allow-listed tool event into the short activity shown above an agent and in the ticker. */
export function toOfficeToolVisualEvent(raw: unknown, context: OfficeVisualContext): OfficeVisualEvent | null {
  const parsed = officeToolActivitySchema.safeParse(raw);
  if (!parsed.success) return null;
  const event = parsed.data;
  const agent = context.agents.find((item) => item.id === event.agentInstanceId);
  if (!agent || agent.projectId && agent.projectId !== event.projectId || agent.currentTaskId && agent.currentTaskId !== event.taskId) return null;
  const project = context.projects.find((item) => item.id === event.projectId);
  const target = event.target;
  let icon = '💭';
  let text = tr('Đang làm việc');
  let activityKind: Activity['kind'] = 'think';

  switch (event.toolId) {
    case 'workspace.list': icon = '📂'; text = target ? tr('Đang liệt kê {0}', [target]) : tr('Đang liệt kê tệp trong workspace'); activityKind = 'read'; break;
    case 'workspace.read': icon = '📖'; text = target ? tr('Đang đọc {0}', [target]) : tr('Đang đọc tệp'); activityKind = 'read'; break;
    case 'workspace.write': icon = '✏️'; text = target ? tr('Đang chuẩn bị thay đổi {0}', [target]) : tr('Đang chuẩn bị thay đổi tệp'); activityKind = 'write'; break;
    case 'workspace.patch': icon = '✏️'; text = target ? tr('Đang chuẩn bị sửa {0}', [target]) : tr('Đang chuẩn bị sửa tệp'); activityKind = 'edit'; break;
    case 'workspace.run_checks': icon = '🧪'; text = target ? tr('Đang chuẩn bị kiểm tra: {0}', [target]) : tr('Đang chuẩn bị kiểm tra'); activityKind = 'test'; break;
    case 'research.search': icon = '🌐'; text = target ? tr('Đang tìm trên web: “{0}”', [target]) : tr('Đang tìm trên web'); activityKind = 'web'; break;
    case 'research.fetch': icon = '🧭'; text = target ? tr('Đang đọc {0}', [target]) : tr('Đang đọc một trang web'); activityKind = 'web'; break;
    case 'analysis.csv_summary': icon = '📊'; text = tr('Đang phân tích dữ liệu CSV'); activityKind = 'read'; break;
    case 'artifacts.create': icon = '📦'; text = target ? tr('Đang tạo artifact {0}', [target]) : tr('Đang tạo artifact'); activityKind = 'write'; break;
    case 'memory.search': icon = '🧠'; text = target ? tr('Đang tìm trong ghi nhớ: “{0}”', [target]) : tr('Đang tìm trong ghi nhớ'); activityKind = 'search'; break;
    case 'memory.propose': icon = '📝'; text = tr('Đang đề xuất ghi nhớ'); activityKind = 'write'; break;
  }

  return {
    id: event.eventId,
    projectId: event.projectId,
    agentId: agent.id,
    taskId: event.taskId,
    agentName: agent.displayName,
    projectName: project?.name ?? tr('Pool compartilhado'),
    icon,
    text: truncateActivity(text),
    at: Date.parse(event.createdAt),
    mood: 'normal',
    activityKind,
  };
}

export function toActivity(event: OfficeVisualEvent): Activity {
  return { id: event.id, kind: event.activityKind, icon: event.icon, text: event.text, at: event.at, error: event.mood === 'error' };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function truncateActivity(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 46 ? `${oneLine.slice(0, 45).trimEnd()}…` : oneLine;
}

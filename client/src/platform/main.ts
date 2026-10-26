import './office.css';
import { createWorld, DEFAULT_WORLD_OPTIONS, type WorldOptions, type WorldSnapshotStore } from '../world';
import type { Activity, OfficeSnapshot as CanvasSnapshot } from '../../../shared/types';
import { createAvatar } from '../ui/avatar';
import { eventEnvelopeSchema, type Agent, type DomainEvent, type MemoryRecord, type Message, type OfficeSnapshot, type Project, type Task } from '../../../shared/platform/contracts';
import { getLocale, setLocale, tr } from './i18n';
import { attachmentMime, MessageAttachmentDraft } from './message-attachments';
import { DurableEventTracker } from './durable-events';
import { toCanvasSnapshot } from './canvas-snapshot';
import { toActivity, toOfficeToolVisualEvent, toOfficeVisualEvent, type OfficeVisualEvent } from './office-visuals';
import { createApprovalDiff } from './approval-diff';

interface OfficeReply { snapshot: OfficeSnapshot; cursor: number }
interface Approval { id: string; runId: string; taskId: string; summary: string; toolId: string; argumentsHash: string; expiresAt: string; arguments: Record<string, unknown> }
interface ProjectReply { project: Project; workspaceAttached?: boolean; workspacePreview?: WorkspacePreviewInfo | null; agents: Agent[]; messages: Message[]; tasks: Task[]; activeRuns: Array<{ id: string; status: string; errorCode: string | null; version: number; pauseRequested: boolean }>; approvals: Approval[]; memory: MemoryRecord[] }
interface ProjectMemoryMarkdownPreview { expectedRevision: string; recordCount: number; changedCount: number; changes: Array<{ id: string; revision: number; nextRevision: number; before: string; after: string }> }
interface RegistryPreview { canApply: boolean; addedDefinitions: Array<{ id: string; version: string; displayName: string; capabilities: string[] }>; addedAgents: Array<{ id: string; definition: string; displayName: string }>; blockers: string[]; previewToken?: string }
interface Artifact { id: string; versionId: string; logicalName: string; mimeType: string; sizeBytes: number; createdAt: string }
interface WorkspacePreviewInfo { id: string; projectId: string; script: string; url: string; createdAt: string; expiresAt: string; executionMode: 'docker' | 'local-trusted'; networkAccess: boolean }
interface PreviewScript { name: string; command: string; lifecycle: Array<{ name: string; command: string }> }
interface WorkspacePreviewSetup { executionMode: 'disabled' | 'docker' | 'local-trusted'; scripts: PreviewScript[]; packageChecksum: string; dependencyInstall?: { command: string; lockFile: string; lockChecksum: string; lifecycle: Array<{ name: string; command: string }> }; active: WorkspacePreviewInfo | null }
interface UsageReply { budget: { limitTokensPerRun: number; measuredTokens: number; reservedTokens: number; measuredCostMicrousd?: number; reservedCostMicrousd?: number; unpricedRequests?: number; runs: Array<{ runId: string; status: string; limitTokens: number; measuredTokens: number; reservedTokens: number; remainingTokens: number; pendingRequests: number; unknownRequests: number; moneyBudgetMicrousd?: number | null; measuredCostMicrousd?: number; reservedCostMicrousd?: number; unpricedRequests?: number }> } }

class CanvasStore implements WorldSnapshotStore {
  snapshot: CanvasSnapshot | null = null;
  private readonly listeners = new Set<(snapshot: CanvasSnapshot) => void>();
  on(_event: 'snapshot', callback: (snapshot: CanvasSnapshot) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  set(snapshot: CanvasSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

const root = document.querySelector<HTMLElement>('#office-app')!;
const startedAt = Date.now();
const labels = {
  role: { coordinator: 'Coordinator', developer: 'Developer', reviewer: 'Reviewer', researcher: 'Researcher', analyst: 'Analyst', writer: 'Writer' } as Record<string, string>,
};
let csrfToken = '';
let snapshot: OfficeSnapshot | null = null;
const durableEvents = new DurableEventTracker();
let visibleProjects: Project[] = [];
let projectDetail: ProjectReply | null = null;
let renderedProjectId: string | null = null;
const messageDrafts = new Map<string, string>();
let selectedProjectId: string | null = null;
let refreshRequestSequence = 0;
let selectFirstWhenSelectionIsMissing = false;
let projectPanelOpen = true;
let archived = false;
let busy = false;
const attachmentDraft = new MessageAttachmentDraft();
const visualFeed: OfficeVisualEvent[] = [];
const visualActivities = new Map<string, Activity>();
const transientActivities = new Map<string, { projectId: string; taskId: string; activity: Activity }>();
const visualEventHistory: DomainEvent[] = [];
let worldOptions = loadWorldOptions();
let toastTimer: number | null = null;
let bannerTimer: number | null = null;
let streamText = '';
let streamRunId = '';
let connection: EventSource | null = null;
let browserOnline = navigator.onLine;
let eventReconnectAttempt = 0;
let eventReconnectTimer: number | null = null;
let canvasStore: CanvasStore;
let world: ReturnType<typeof createWorld>;

void start();

async function start(): Promise<void> {
  document.documentElement.lang = getLocale();
  mountShell();
  canvasStore = new CanvasStore();
  const canvas = root.querySelector<HTMLCanvasElement>('#office-canvas')!;
  world = createWorld(canvas, canvasStore);
  world.setOptions(worldOptions);
  world.setViewInsets?.({ left: 0, right: 0, top: 54, bottom: 58 });
  world.onSelect((selection) => {
    if (!selection) return;
    if (selection.type === 'room' && snapshot?.projects.some((project) => project.id === selection.id)) void selectProject(selection.id);
    if (selection.type === 'agent') {
      const agent = snapshot?.agents.find((item) => item.id === selection.id);
      if (agent?.projectId) void selectProject(agent.projectId);
    }
  });
  root.querySelector<HTMLButtonElement>('#new-project')!.onclick = () => root.querySelector<HTMLDialogElement>('#new-project-dialog')!.showModal();
  root.querySelector<HTMLButtonElement>('#reload-agents')!.onclick = reloadAgents;
  root.querySelector<HTMLButtonElement>('#language')!.onclick = () => { setLocale(getLocale() === 'vi' ? 'en' : 'vi'); location.reload(); };
  root.querySelector<HTMLButtonElement>('#world-overview')!.onclick = () => world.overview();
  root.querySelector<HTMLButtonElement>('#world-zoom-in')!.onclick = () => world.zoomBy(1.2);
  root.querySelector<HTMLButtonElement>('#world-zoom-out')!.onclick = () => world.zoomBy(1 / 1.2);
  root.querySelector<HTMLButtonElement>('#world-settings-toggle')!.onclick = () => toggleWorldPanel('#world-settings', '#world-settings-toggle');
  root.querySelector<HTMLButtonElement>('#world-help-toggle')!.onclick = () => toggleWorldPanel('#world-help', '#world-help-toggle');
  root.querySelector<HTMLButtonElement>('#world-feed-toggle')!.onclick = () => toggleWorldFeed();
  root.querySelector<HTMLButtonElement>('#project-panel-toggle')!.onclick = () => setProjectPanelOpen(!projectPanelOpen);
  root.querySelector<HTMLButtonElement>('#activity-collapse')!.onclick = () => toggleWorldFeed();
  root.querySelector<HTMLButtonElement>('[data-close-feed]')!.onclick = closeWorldPopovers;
  root.querySelectorAll<HTMLButtonElement>('[data-close-popover]').forEach((button) => { button.onclick = closeWorldPopovers; });
  root.querySelector<HTMLElement>('#world-settings')!.addEventListener('change', onWorldSettingChange);
  document.addEventListener('pointerdown', onWorldPopoverOutsideClick);
  document.addEventListener('keydown', onWorldPopoverEscape);
  root.querySelector<HTMLButtonElement>('#archive-toggle')!.onclick = async () => { archived = !archived; await refresh(); };
  root.querySelector<HTMLFormElement>('#new-project-form')!.onsubmit = createProject;
  root.querySelector<HTMLButtonElement>('#cancel-project-dialog')!.onclick = () => root.querySelector<HTMLDialogElement>('#new-project-dialog')!.close();
  try {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    if (!browserOnline) updateConnection(false);
    const session = await fetchJson<{ csrfToken: string }>('/platform/v1/session');
    csrfToken = session.csrfToken;
    await refresh();
    connectEvents();
    window.setInterval(refreshInBackground, 5000);
  } catch (error) {
    showBanner(error instanceof Error ? error.message : tr('Conectando ao escritório…'));
  }
}

function mountShell(): void {
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <header class="brand"><img src="/assets/brand/logo-mark@4x.png" alt="" /><div><strong>Agent Office</strong><span>${tr('Escritório de agentes')}</span></div></header>
        <div class="sidebar-actions"><button class="button primary" id="new-project">＋ ${tr('Criar projeto')}</button><button class="button secondary" id="reload-agents">${tr('Carregar novos agentes')}</button></div>
        <div class="section-heading"><span>${tr('Projetos')}</span><button id="archive-toggle" class="quiet-button">${tr('Mostrar arquivados')}</button></div>
        <div id="project-list" class="project-list"><p class="muted">${tr('Conectando ao escritório…')}</p></div>
        <div class="section-heading team-heading"><span>${tr('Equipe de agentes')}</span><span class="pool-count" id="pool-count">0</span></div>
        <div id="agent-list" class="agent-list"></div>
        <footer class="sidebar-footer"><span id="connection-status" class="connection"><i></i>${tr('Conectando ao escritório…')}</span><button id="language" class="language-button" aria-label="${tr('Idioma')}">${getLocale().toUpperCase()}</button></footer>
      </aside>
      <section class="world-panel">
        <canvas id="office-canvas" aria-label="${tr('Escritório de agentes')}"></canvas>
        <div class="world-toolbar" role="toolbar" aria-label="${tr('Controles do escritório')}">
          <div class="world-camera-controls"><button class="world-tool-button" id="world-overview" title="${tr('Ver o escritório inteiro')}" aria-label="${tr('Ver o escritório inteiro')}">⛶</button><button class="world-tool-button" id="world-zoom-out" title="${tr('Diminuir zoom')}" aria-label="${tr('Diminuir zoom')}">−</button><button class="world-tool-button" id="world-zoom-in" title="${tr('Aumentar zoom')}" aria-label="${tr('Aumentar zoom')}">＋</button></div>
          <div class="world-stats" id="world-stats" aria-live="polite"></div>
          <div class="world-panel-controls"><button class="world-tool-button" id="world-feed-toggle" title="${tr('Atividade')}" aria-label="${tr('Atividade')}" aria-expanded="false">▤</button><button class="world-tool-button" id="world-settings-toggle" title="${tr('Configurações visuais')}" aria-label="${tr('Configurações visuais')}" aria-expanded="false">⚙</button><button class="world-tool-button" id="world-help-toggle" title="${tr('Ajuda do escritório')}" aria-label="${tr('Ajuda do escritório')}" aria-expanded="false">?</button><button class="world-tool-button" id="project-panel-toggle" title="${tr('Conversa')}" aria-label="${tr('Conversa')}" aria-expanded="true">▣</button></div>
        </div>
        <section id="world-settings" class="world-popover world-settings" aria-label="${tr('Configurações visuais')}" hidden>
          <header><strong>${tr('Configurações visuais')}</strong><button class="popover-close" type="button" data-close-popover aria-label="${tr('Fechar')}">×</button></header>
          <label class="world-setting-row"><span>${tr('Mostrar nomes')}</span><input type="checkbox" data-world-option="showNames"></label>
          <label class="world-setting-row"><span>${tr('Balões de atividade')}</span><select data-world-option="bubbles"><option value="important">${tr('Importantes')}</option><option value="all">${tr('Todos')}</option><option value="none">${tr('Nenhum')}</option></select></label>
          <label class="world-setting-row"><span>${tr('Movimento dos agentes')}</span><select data-world-option="liveliness"><option value="calm">${tr('Calmo')}</option><option value="normal">${tr('Normal')}</option><option value="lively">${tr('Animado')}</option></select></label>
          <label class="world-setting-row"><span>${tr('Acompanhar agente selecionado')}</span><input type="checkbox" data-world-option="followSelected"></label>
          <label class="world-setting-row"><span>${tr('Iluminação')}</span><select data-world-option="daylight"><option value="auto">${tr('Automática')}</option><option value="day">${tr('Dia')}</option><option value="night">${tr('Noite')}</option></select></label>
          <label class="world-setting-row"><span>${tr('Tema sazonal')}</span><select data-world-option="theme"><option value="auto">${tr('Automático')}</option><option value="none">${tr('Padrão')}</option><option value="halloween">Halloween</option><option value="christmas">Natal</option></select></label>
        </section>
        <section id="world-help" class="world-popover world-help" aria-label="${tr('Ajuda do escritório')}" hidden>
          <header><strong>${tr('Ajuda do escritório')}</strong><button class="popover-close" type="button" data-close-popover aria-label="${tr('Fechar')}">×</button></header>
          <p>${tr('Clique em uma sala para abrir o projeto. Clique em um agente para ir até ele.')}</p><p>${tr('Use os botões de câmera para enquadrar o escritório ou ajustar o zoom.')}</p>
        </section>
        <section id="activity-feed" class="activity-feed" aria-label="${tr('Atividade recente')}" hidden><header><strong>${tr('Atividade recente')}</strong><button class="popover-close" type="button" data-close-feed aria-label="${tr('Fechar')}">×</button></header><ol id="activity-feed-list"></ol></section>
        <button class="activity-ticker" id="activity-collapse" aria-label="${tr('Abrir atividade recente')}" aria-expanded="false"><strong>${tr('Atividade')}</strong><span class="activity-ticker-copy" id="activity-latest">${tr('Sem atividade recente')}</span><span class="activity-chevron" aria-hidden="true">⌃</span></button>
        <div id="activity-toast" class="activity-toast" role="status" hidden></div>
        <div class="world-caption"><span class="pixel-dot"></span><span>${tr('Pool compartilhado')}</span></div>
      </section>
      <aside class="project-panel">
        <div id="banner" class="banner" hidden></div>
        <div id="project-content" class="project-content"><div class="empty-state"><div class="empty-icon">⌂</div><h2>${tr('Selecione ou crie um projeto para começar.')}</h2><p>${tr('Use Developer, Researcher, Analyst ou Writer para começar.')}</p><button class="button primary" data-open-project>${tr('Criar projeto')}</button></div></div>
      </aside>
    </div>
    <dialog id="new-project-dialog" class="dialog">
      <form id="new-project-form" method="dialog">
        <div class="dialog-title"><div><span class="eyebrow">${tr('Novo projeto')}</span><h2>${tr('Criar sala')}</h2></div><button class="icon-button" type="button" id="cancel-project-dialog" aria-label="${tr('Cancelar')}">×</button></div>
        <label>${tr('Nome do projeto')}<input name="name" required maxlength="120" autocomplete="off" /></label>
        <label>${tr('Objetivo do projeto')}<textarea name="goal" rows="3" maxlength="4000" placeholder="${tr('Descreva o que este projeto deve alcançar.')}"></textarea></label>
        <label>${tr('Pasta de trabalho (opcional)')}<input name="workspaceRoot" maxlength="1024" placeholder="${tr('Ex.: D:\\projetos\\site')}" /></label>
        <div class="dialog-actions"><button class="button secondary" type="button" id="cancel-project-dialog-secondary">${tr('Cancelar')}</button><button class="button primary" type="submit">${tr('Criar sala')}</button></div>
      </form>
    </dialog>`;
  root.querySelector<HTMLButtonElement>('[data-open-project]')!.onclick = () => root.querySelector<HTMLDialogElement>('#new-project-dialog')!.showModal();
  root.querySelector<HTMLButtonElement>('#cancel-project-dialog-secondary')!.onclick = () => root.querySelector<HTMLDialogElement>('#new-project-dialog')!.close();
  projectPanelOpen = window.innerWidth > 900;
  setProjectPanelOpen(projectPanelOpen);
  syncWorldSettingControls();
  renderActivityFeed();
}

async function refresh(selectFirst = true): Promise<void> {
  if (selectFirst) selectFirstWhenSelectionIsMissing = true;
  const shouldSelectFirst = selectFirstWhenSelectionIsMissing;
  const requestSequence = ++refreshRequestSequence;
  const archivedAtRequest = archived;
  const previousSelectedId = selectedProjectId;
  const projectListPath = archivedAtRequest ? '/platform/v1/projects?status=archived' : '/platform/v1/projects';
  const [office, projectList] = await Promise.all([
    fetchJson<OfficeReply>('/platform/v1/office'),
    fetchJson<{ projects: Project[] }>(projectListPath),
  ]);
  if (requestSequence !== refreshRequestSequence || archivedAtRequest !== archived) return;
  snapshot = office.snapshot;
  for (const [agentId, live] of transientActivities) {
    const agent = snapshot.agents.find((item) => item.id === agentId);
    if (!agent || agent.execution !== 'running' || agent.projectId !== live.projectId || agent.currentTaskId && agent.currentTaskId !== live.taskId) transientActivities.delete(agentId);
  }
  durableEvents.advanceTo(office.cursor);
  updateCanvasSnapshot();
  renderProjects(projectList.projects);
  renderAgents(snapshot.agents);
  renderWorldStats();
  const stillExists = projectList.projects.some((project) => project.id === selectedProjectId);
  if (!stillExists) selectedProjectId = shouldSelectFirst ? (projectList.projects[0]?.id ?? null) : null;
  // Opening the office should frame the living workspace. Focus a room only after the owner has
  // already selected a project and a refresh moves that selection to a different project.
  if (selectedProjectId) await loadProject(selectedProjectId, previousSelectedId !== null && selectedProjectId !== previousSelectedId);
  else if (!archived) renderEmpty();
  if (requestSequence === refreshRequestSequence) selectFirstWhenSelectionIsMissing = false;
  updateConnection(true);
}

async function loadProject(projectId: string, focus = false): Promise<void> {
  attachmentDraft.selectProject(projectId);
  const response = await fetchJson<ProjectReply>(`/platform/v1/projects/${encodeURIComponent(projectId)}`);
  projectDetail = response;
  selectedProjectId = projectId;
  rebuildVisualActivities(response);
  updateCanvasSnapshot();
  renderProjectPanel(response);
  if (focus) world?.focusRoom(projectId);
  renderProjects(visibleProjects);
  renderAgents(snapshot?.agents ?? []);
}

function renderProjects(projects: Project[]): void {
  visibleProjects = projects;
  const list = root.querySelector<HTMLElement>('#project-list')!;
  if (!projects.length) {
    list.innerHTML = `<p class="muted">${archived ? tr('Projeto arquivado') : tr('Selecione ou crie um projeto para começar.')}</p>`;
    return;
  }
  list.innerHTML = projects.map((project) => {
    const projectAgents = (snapshot?.agents.filter((agent) => agent.projectId === project.id) ?? [])
      .slice().sort((a, b) => Number(b.role === 'coordinator') - Number(a.role === 'coordinator') || a.displayName.localeCompare(b.displayName));
    const members = projectAgents.length;
    const selected = selectedProjectId === project.id ? ' is-selected' : '';
    const activeAgent = projectAgents.find((agent) => agent.execution === 'running' || agent.execution === 'waiting');
    const activity = (activeAgent ? activityForAgent(activeAgent.id) : undefined)
      ?? projectAgents.map((agent) => activityForAgent(agent.id)).filter((item): item is Activity => !!item).sort((a, b) => b.at - a.at)[0];
    const currentTask = activeAgent?.currentTaskId && projectDetail?.project.id === project.id ? projectDetail.tasks.find((task) => task.id === activeAgent.currentTaskId) : undefined;
    const activityText = activity?.text ?? (activeAgent?.execution === 'waiting' ? tr('Aguardando sua aprovação') : currentTask ? tr('Trabalhando em: {0}', [currentTask.title]) : activeAgent ? tr('Agent trabalhando') : tr('Sem atividade recente'));
    const presence = projectAgents.slice(0, 4).map((agent) => `<span class="project-presence-item" title="${esc(`${agent.displayName} · ${labels.role[agent.definitionId] ?? agent.definitionId}`)}"><span class="office-avatar-slot" data-agent-avatar="${esc(agent.id)}"></span><i class="${agent.execution === 'running' ? 'is-working' : agent.execution === 'waiting' ? 'is-waiting' : ''}"></i></span>`).join('');
    const extra = projectAgents.length > 4 ? `<span class="project-presence-more">+${projectAgents.length - 4}</span>` : '';
    const agentRows = projectAgents.map((agent) => renderAgentRow(agent, 'project-agent-row')).join('');
    return `<section class="project-group${selected}" data-project-group="${esc(project.id)}"><button class="project-card${selected}" data-project="${esc(project.id)}"><span class="room-glyph">▦</span><span class="project-card-copy"><strong>${esc(project.name)}</strong><small>${members} ${tr('Agentes no projeto')}</small><span class="project-presence">${presence}${extra}</span><small class="project-card-activity" title="${esc(activityText)}">${activity?.icon ?? (activeAgent?.execution === 'waiting' ? '✋' : activeAgent ? '💭' : '·')} ${esc(activityText)}</small></span><span class="project-arrow">›</span></button>${agentRows ? `<div class="project-agent-list" aria-label="${esc(tr('Agentes no projeto'))}">${agentRows}</div>` : ''}</section>`;
  }).join('');
  list.querySelectorAll<HTMLButtonElement>('[data-project]').forEach((button) => { button.onclick = () => void selectProject(button.dataset.project!); });
  hydrateOfficeAvatars(list);
  wireAgentControls(list);
}

function renderAgents(agents: Agent[]): void {
  const specialists = agents.filter((agent) => agent.role === 'specialist' && agent.location.kind === 'pool');
  const ready = specialists.filter((agent) => agent.availability === 'ready').length;
  root.querySelector<HTMLElement>('#pool-count')!.textContent = String(ready);
  root.querySelector<HTMLElement>('#agent-list')!.innerHTML = specialists.length ? specialists.map((agent) => {
    const status = agent.availability === 'draining' ? tr('Đang drain; task hiện tại vẫn chạy') : agent.availability === 'ready' ? tr('Pronto') : agent.execution === 'running' ? tr('Trabalhando') : tr('Aguardando tarefa');
    const dot = agent.availability === 'draining' ? 'draining' : agent.availability === 'ready' ? 'ready' : 'busy';
    const shouldDrain = agent.availability !== 'draining';
    const toggleLabel = shouldDrain ? tr('Ngừng nhận việc mới') : tr('Cho phép nhận việc mới');
    const currentTask = agent.currentTaskId && projectDetail?.project.id === agent.projectId ? projectDetail.tasks.find((task) => task.id === agent.currentTaskId) : undefined;
    const activity = activityForAgent(agent.id);
    const activityText = activity?.text ?? (agent.execution === 'running' ? currentTask ? tr('Trabalhando em: {0}', [currentTask.title]) : tr('Pensando enquanto trabalha…') : agent.execution === 'waiting' ? tr('Aguardando sua aprovação') : tr('Aguardando uma tarefa'));
    return `<div class="agent-card"><button class="agent-card-main" data-agent-main="${esc(agent.id)}"><span class="office-avatar-slot" data-agent-avatar="${esc(agent.id)}"></span><span class="agent-card-copy"><strong>${esc(agent.displayName)}</strong><small>${esc(labels.role[agent.definitionId] ?? agent.definitionId)} · ${esc(status)}</small><small class="agent-card-activity" title="${esc(activityText)}">${activity?.icon ?? (agent.execution === 'running' ? '💭' : agent.execution === 'waiting' ? '✋' : '·')} ${esc(activityText)}</small></span></button><span class="status-dot ${dot}" title="${esc(status)}"></span><button class="agent-drain-button" type="button" data-agent-drain="${esc(agent.id)}" data-draining="${agent.availability === 'draining'}" aria-label="${esc(toggleLabel)}" title="${esc(toggleLabel)}">${shouldDrain ? '⏸' : '↻'}</button></div>`;
  }).join('') : `<p class="muted">${tr('Nenhum agente disponível')}</p>`;
  const list = root.querySelector<HTMLElement>('#agent-list')!;
  hydrateOfficeAvatars(list);
  list.querySelectorAll<HTMLButtonElement>('[data-agent-main]').forEach((button) => { button.onclick = () => {
    const agent = snapshot?.agents.find((item) => item.id === button.dataset.agentMain);
    if (agent?.projectId) void selectProject(agent.projectId);
  }; });
  list.querySelectorAll<HTMLButtonElement>('[data-agent-drain]').forEach((button) => { button.onclick = () => void setAgentDraining(button.dataset.agentDrain!, button.dataset.draining === 'true', button); });
}

function renderAgentRow(agent: Agent, rowClass: 'project-agent-row'): string {
  const status = agent.availability === 'draining' ? tr('Đang drain; task hiện tại vẫn chạy') : agent.availability === 'ready' ? tr('Pronto') : agent.execution === 'running' ? tr('Trabalhando') : agent.execution === 'waiting' ? tr('Aguardando aprovação') : tr('Aguardando tarefa');
  const dot = agent.availability === 'draining' ? 'draining' : agent.availability === 'ready' ? 'ready' : 'busy';
  const currentTask = agent.currentTaskId && projectDetail?.project.id === agent.projectId ? projectDetail.tasks.find((task) => task.id === agent.currentTaskId) : undefined;
  const activity = activityForAgent(agent.id);
  const activityText = activity?.text ?? (agent.execution === 'running' ? currentTask ? tr('Trabalhando em: {0}', [currentTask.title]) : tr('Pensando enquanto trabalha…') : agent.execution === 'waiting' ? tr('Aguardando aprovação') : tr('Aguardando uma tarefa'));
  const role = labels.role[agent.definitionId] ?? agent.definitionId;
  const toggleLabel = agent.availability === 'draining' ? tr('Cho phép nhận việc mới') : tr('Ngừng nhận việc mới');
  const drainControl = agent.role === 'specialist'
    ? `<button class="agent-drain-button" type="button" data-agent-drain="${esc(agent.id)}" data-draining="${agent.availability === 'draining'}" aria-label="${esc(toggleLabel)}" title="${esc(toggleLabel)}">${agent.availability === 'draining' ? '↻' : '⏸'}</button>`
    : '';
  return `<div class="${rowClass}" data-project-agent="${esc(agent.id)}"><button class="agent-card-main" data-agent-main="${esc(agent.id)}"><span class="office-avatar-slot" data-agent-avatar="${esc(agent.id)}"></span><span class="agent-card-copy"><strong>${esc(agent.displayName)}</strong><small>${esc(role)} · ${esc(status)}</small><small class="agent-card-activity" title="${esc(activityText)}">${activity?.icon ?? (agent.execution === 'running' ? '💭' : agent.execution === 'waiting' ? '✋' : '·')} ${esc(activityText)}</small></span></button><span class="status-dot ${dot}" title="${esc(status)}"></span>${drainControl}</div>`;
}

function wireAgentControls(container: ParentNode): void {
  container.querySelectorAll<HTMLButtonElement>('[data-agent-main]').forEach((button) => { button.onclick = () => {
    const agent = snapshot?.agents.find((item) => item.id === button.dataset.agentMain);
    if (agent?.projectId) void selectProject(agent.projectId);
  }; });
  container.querySelectorAll<HTMLButtonElement>('[data-agent-drain]').forEach((button) => { button.onclick = () => void setAgentDraining(button.dataset.agentDrain!, button.dataset.draining === 'true', button); });
}

function hydrateOfficeAvatars(container: ParentNode): void {
  for (const slot of container.querySelectorAll<HTMLElement>('[data-agent-avatar]')) {
    const agent = snapshot?.agents.find((item) => item.id === slot.dataset.agentAvatar);
    if (!agent) continue;
    const avatar = createAvatar({ seed: agent.appearanceSeed, look: agent.appearanceSeed % 2 ? 'f' : 'm', kind: 'main' }, 'sm');
    avatar.classList.add('office-avatar');
    slot.replaceWith(avatar);
  }
}

function updateCanvasSnapshot(): void {
  if (!snapshot || !canvasStore) return;
  const tasks = projectDetail?.project.id === selectedProjectId ? projectDetail.tasks : [];
  const activities = new Map(visualActivities);
  for (const [agentId, live] of transientActivities) activities.set(agentId, live.activity);
  canvasStore.set(toCanvasSnapshot(snapshot, labels.role, startedAt, tasks, activities));
}

function activityForAgent(agentId: string): Activity | undefined {
  return transientActivities.get(agentId)?.activity ?? visualActivities.get(agentId);
}

function renderWorldStats(): void {
  if (!snapshot) return;
  const ready = snapshot.agents.filter((agent) => agent.role === 'specialist' && agent.availability === 'ready').length;
  const running = snapshot.agents.filter((agent) => agent.execution === 'running').length;
  root.querySelector<HTMLElement>('#world-stats')!.innerHTML = `<span><b>${snapshot.projects.length}</b>${tr('salas')}</span><span><b>${snapshot.agents.length}</b>${tr('agentes')}</span><span><b>${running}</b>${tr('em atividade')}</span><span><b>${ready}</b>${tr('disponíveis')}</span>`;
}

function recordVisualEvent(event: DomainEvent): void {
  if (!snapshot) return;
  visualEventHistory.push(safeVisualEvent(event));
  if (visualEventHistory.length > 500) visualEventHistory.splice(0, visualEventHistory.length - 500);
  const contextTasks = projectDetail?.project.id === event.projectId ? projectDetail.tasks : [];
  const visual = toOfficeVisualEvent(event, { agents: snapshot.agents, projects: snapshot.projects, tasks: contextTasks });
  if (!visual) return;
  visualFeed.push(visual);
  if (visualFeed.length > 80) visualFeed.splice(0, visualFeed.length - 80);
  if (visual.agentId) {
    visualActivities.set(visual.agentId, toActivity(visual));
    transientActivities.delete(visual.agentId);
  }
  renderActivityFeed();
  showActivityToast(visual);
  renderProjects(visibleProjects);
  renderAgents(snapshot.agents);
  updateCanvasSnapshot();
}

function rebuildVisualActivities(data: ProjectReply): void {
  for (const agent of data.agents) visualActivities.delete(agent.id);
  for (const event of visualEventHistory) {
    if (event.projectId !== data.project.id || !snapshot) continue;
    const visual = toOfficeVisualEvent(event, { agents: snapshot.agents, projects: snapshot.projects, tasks: data.tasks });
    if (visual?.agentId) visualActivities.set(visual.agentId, toActivity(visual));
  }
}

function safeVisualEvent(event: DomainEvent): DomainEvent {
  const payload: Record<string, unknown> = {};
  for (const key of ['taskId', 'agentInstanceId', 'status']) {
    const value = event.payload[key];
    if (typeof value === 'string' && value.length <= 160) payload[key] = value;
  }
  return { ...event, payload };
}

function renderActivityFeed(): void {
  const latest = visualFeed.at(-1);
  const ticker = root.querySelector<HTMLElement>('#activity-latest');
  if (ticker) ticker.textContent = latest ? `${latest.agentName}: ${latest.icon} ${latest.text}` : tr('Sem atividade recente');
  const list = root.querySelector<HTMLOListElement>('#activity-feed-list');
  if (list) list.innerHTML = visualFeed.slice().reverse().map((item) => `<li class="activity-feed-item is-${item.mood}" data-feed-event="${esc(item.id)}"><span class="feed-event-icon">${item.icon}</span><span class="feed-event-copy"><strong>${esc(item.agentName)} · ${esc(item.text)}</strong><small>${esc(item.projectName)} · ${esc(formatVisualTime(item.at))}</small></span></li>`).join('') || `<li class="activity-feed-empty">${tr('Sem atividade recente')}</li>`;
}

function showActivityToast(event: OfficeVisualEvent): void {
  const toast = root.querySelector<HTMLElement>('#activity-toast');
  if (!toast) return;
  toast.innerHTML = `<span aria-hidden="true">${event.icon}</span><span><strong>${esc(event.agentName)}</strong> ${esc(event.text)}<small>${esc(event.projectName)}</small></span><button type="button" aria-label="${tr('Fechar')}" data-dismiss-toast>×</button>`;
  toast.hidden = false;
  toast.querySelector<HTMLButtonElement>('[data-dismiss-toast]')!.onclick = () => { toast.hidden = true; };
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; toastTimer = null; }, 7000);
}

function formatVisualTime(at: number): string {
  return new Intl.DateTimeFormat(getLocale() === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' }).format(at);
}

function toggleWorldFeed(): void {
  const feed = root.querySelector<HTMLElement>('#activity-feed')!;
  const button = root.querySelector<HTMLButtonElement>('#world-feed-toggle')!;
  const open = feed.hidden;
  closeWorldPopovers();
  feed.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  root.querySelector<HTMLButtonElement>('#activity-collapse')!.setAttribute('aria-expanded', String(open));
  world.setViewInsets?.({ bottom: open ? 300 : 58 });
}

function setProjectPanelOpen(open: boolean): void {
  projectPanelOpen = open;
  root.querySelector<HTMLElement>('.project-panel')?.classList.toggle('is-collapsed', !open);
  root.querySelector<HTMLButtonElement>('#project-panel-toggle')?.setAttribute('aria-expanded', String(open));
}

function toggleWorldPanel(panelSelector: '#world-settings' | '#world-help', buttonSelector: '#world-settings-toggle' | '#world-help-toggle'): void {
  const panel = root.querySelector<HTMLElement>(panelSelector)!;
  const button = root.querySelector<HTMLButtonElement>(buttonSelector)!;
  const open = panel.hidden;
  closeWorldPopovers();
  panel.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open && panelSelector === '#world-settings') syncWorldSettingControls();
}

function closeWorldPopovers(): void {
  for (const [panelSelector, buttonSelector] of [['#world-settings', '#world-settings-toggle'], ['#world-help', '#world-help-toggle']] as const) {
    root.querySelector<HTMLElement>(panelSelector)!.hidden = true;
    root.querySelector<HTMLButtonElement>(buttonSelector)!.setAttribute('aria-expanded', 'false');
  }
  root.querySelector<HTMLElement>('#activity-feed')!.hidden = true;
  root.querySelector<HTMLButtonElement>('#world-feed-toggle')!.setAttribute('aria-expanded', 'false');
  root.querySelector<HTMLButtonElement>('#activity-collapse')!.setAttribute('aria-expanded', 'false');
  world.setViewInsets?.({ bottom: 58 });
}

function onWorldPopoverOutsideClick(event: PointerEvent): void {
  if (!(event.target instanceof Element) || event.target.closest('.world-toolbar, .world-popover, .activity-feed, .activity-ticker')) return;
  closeWorldPopovers();
}

function onWorldPopoverEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeWorldPopovers();
}

function onWorldSettingChange(event: Event): void {
  const control = event.target;
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) return;
  const option = control.dataset.worldOption;
  if (!option) return;
  if (option === 'showNames' || option === 'followSelected') worldOptions[option] = (control as HTMLInputElement).checked;
  else if (option === 'bubbles' && ['all', 'important', 'none'].includes(control.value)) worldOptions.bubbles = control.value as WorldOptions['bubbles'];
  else if (option === 'liveliness' && ['calm', 'normal', 'lively'].includes(control.value)) worldOptions.liveliness = control.value as WorldOptions['liveliness'];
  else if (option === 'daylight' && ['auto', 'day', 'night'].includes(control.value)) {
    const daylight = control.value as NonNullable<WorldOptions['daylight']>;
    worldOptions = { ...worldOptions, daylight, dayNight: daylight === 'auto' };
  } else if (option === 'theme' && ['auto', 'none', 'christmas', 'halloween'].includes(control.value)) worldOptions.theme = control.value as WorldOptions['theme'];
  world.setOptions(worldOptions);
  try { localStorage.setItem('agent-office:visual-settings:v1', JSON.stringify(worldOptions)); } catch { /* Browser storage may be disabled; the current tab still keeps these options. */ }
}

function syncWorldSettingControls(): void {
  for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-world-option]')) {
    const option = control.dataset.worldOption;
    if (option === 'showNames' || option === 'followSelected') (control as HTMLInputElement).checked = worldOptions[option];
    else if (option === 'bubbles') control.value = worldOptions.bubbles;
    else if (option === 'liveliness') control.value = worldOptions.liveliness;
    else if (option === 'daylight') control.value = worldOptions.daylight ?? (worldOptions.dayNight ? 'auto' : 'night');
    else if (option === 'theme') control.value = worldOptions.theme ?? 'auto';
  }
}

function loadWorldOptions(): WorldOptions {
  try {
    const saved = JSON.parse(localStorage.getItem('agent-office:visual-settings:v1') ?? 'null') as Partial<WorldOptions> | null;
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_WORLD_OPTIONS };
    return {
      ...DEFAULT_WORLD_OPTIONS,
      showNames: typeof saved.showNames === 'boolean' ? saved.showNames : DEFAULT_WORLD_OPTIONS.showNames,
      bubbles: saved.bubbles === 'all' || saved.bubbles === 'none' ? saved.bubbles : 'important',
      liveliness: saved.liveliness === 'calm' || saved.liveliness === 'lively' ? saved.liveliness : 'normal',
      followSelected: typeof saved.followSelected === 'boolean' ? saved.followSelected : DEFAULT_WORLD_OPTIONS.followSelected,
      dayNight: typeof saved.dayNight === 'boolean' ? saved.dayNight : DEFAULT_WORLD_OPTIONS.dayNight,
      ...(saved.daylight === 'auto' || saved.daylight === 'day' || saved.daylight === 'night' ? { daylight: saved.daylight } : {}),
      theme: saved.theme === 'none' || saved.theme === 'christmas' || saved.theme === 'halloween' ? saved.theme : 'auto',
    };
  } catch { return { ...DEFAULT_WORLD_OPTIONS }; }
}

async function setAgentDraining(agentId: string, currentlyDraining: boolean, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await fetchJson(`/platform/v1/agents/${encodeURIComponent(agentId)}/drain`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draining: !currentlyDraining }),
    });
    await refresh(false);
  } catch (error) {
    showBanner(error instanceof Error ? error.message : tr('Không thể thay đổi trạng thái agent.'));
  } finally { button.disabled = false; }
}

function renderProjectPanel(data: ProjectReply): void {
  const previousInput = root.querySelector<HTMLTextAreaElement>('#message-input');
  if (renderedProjectId && previousInput && !previousInput.disabled) storeMessageDraft(renderedProjectId, previousInput.value);
  const project = data.project;
  const assigned = data.agents.filter((agent) => agent.projectId === project.id);
  const running = assigned.filter((agent) => agent.execution === 'running').length;
  const waiting = assigned.filter((agent) => agent.execution === 'waiting').length;
  const activeRun = data.activeRuns.find((run) => ['queued', 'planning', 'executing', 'waiting_approval', 'paused'].includes(run.status));
  const steerableRun = data.activeRuns.find((run) => ['planning', 'executing', 'waiting_approval', 'paused'].includes(run.status) && !['WAITING_FOR_USER_INPUT', 'FINALIZING'].includes(run.errorCode ?? ''));
  const canPauseRun = !!activeRun && ['queued', 'planning', 'executing'].includes(activeRun.status) && activeRun.errorCode !== 'FINALIZING';
  const canResumeRun = activeRun?.status === 'paused' && ['USER_PAUSED', 'BUDGET_EXHAUSTED'].includes(activeRun.errorCode ?? '');
  const steerableTasks = data.tasks.filter((task) => !['succeeded', 'failed', 'cancelled'].includes(task.status));
  root.querySelector<HTMLElement>('#project-content')!.innerHTML = `
    <header class="project-header"><div class="project-title"><span class="eyebrow">${tr('Coordenação do projeto')}</span><h1>${esc(project.name)}</h1><p>${esc(project.goal || tr('Objetivo do projeto'))}</p></div><div class="project-header-actions"><button class="icon-button" id="close-project-panel" type="button" aria-label="${tr('Fechar')}" title="${tr('Fechar')}">×</button>${project.status === 'archived' ? `<button class="icon-button archive-button" id="restore-project" title="${tr('Restaurar projeto')}">↶</button>` : `<button class="icon-button archive-button" id="archive-project" title="${tr('Arquivar projeto')}">⌑</button>`}</div></header>
    <div class="project-stats"><div><strong>${assigned.length}</strong><span>${tr('Agentes no projeto')}</span></div><div><strong>${running}</strong><span>${tr('Em execução')}</span></div><div><strong>${waiting}</strong><span>${tr('Aguardando')}</span></div></div>
    <section class="team-strip"><div class="mini-heading">${tr('Coordenação do projeto')}</div><div class="room-members">${assigned.map((agent) => `<div class="member-chip"><span class="agent-avatar tiny ${esc(agent.definitionId)}">${esc(agent.displayName.slice(0, 1))}</span><span>${esc(agent.displayName)}</span><small>${tr(agent.execution === 'running' ? 'Trabalhando' : agent.execution === 'waiting' ? 'Aguardando' : 'Pronto')}</small></div>`).join('')}</div></section>
    <section class="memory-section"><div class="section-heading panel-heading"><span>${tr('Ghi nhớ')}</span><span class="task-count">${data.memory.filter((item) => item.status === 'accepted').length}</span></div><p class="memory-hint">${tr('Ghi nhớ chỉ xuất hiện trong các scope được cấp cho agent.')}</p><p class="memory-hint">${tr('A exportação preserva o histórico de revisões; anotações temporárias de execução ficam de fora.')}</p><div class="memory-transfer-actions"><button class="button secondary" id="memory-export" type="button">${tr('Exportar memória')}</button><button class="button secondary" id="memory-import-trigger" type="button">${tr('Importar memória')}</button><input id="memory-import-file" type="file" accept="application/json,.json" hidden><button class="button secondary" id="project-memory-markdown-export" type="button">${tr('Baixar memory.md')}</button><button class="button secondary" id="project-memory-markdown-import-trigger" type="button">${tr('Importar memory.md')}</button><input id="project-memory-markdown-import-file" type="file" accept=".md,text/markdown,text/plain" hidden></div><div class="memory-list">${data.memory.length ? data.memory.map(renderMemory).join('') : `<p class="muted">${tr('Chưa có ghi nhớ nào.')}</p>`}</div><form id="memory-form" class="memory-form"><select name="scopeType" id="memory-scope-type" aria-label="${tr('Phạm vi ghi nhớ')}"><option value="project">${tr('Project này')}</option><option value="user">${tr('Người dùng')}</option><option value="agent">${tr('Agent cụ thể')}</option></select><select name="scopeId" id="memory-scope-id" aria-label="${tr('Agent nhận ghi nhớ')}" hidden>${(snapshot?.agents.filter((agent) => agent.role === 'specialist').map((agent) => agent.definitionId) ?? []).filter((id, index, all) => all.indexOf(id) === index).map((id) => `<option value="${esc(id)}">${esc(labels.role[id] ?? id)}</option>`).join('')}</select><textarea name="content" rows="2" maxlength="8000" placeholder="${tr('Thêm quyết định hoặc thông tin cần nhớ…')}" required></textarea><button class="button secondary" type="submit">${tr('Lưu ghi nhớ')}</button></form></section>
    <section class="usage-section"><div class="section-heading panel-heading"><span>${tr('Uso de tokens')}</span></div><div id="usage-summary" class="usage-summary">${tr('Carregando uso de tokens…')}</div></section>
    <section class="tasks-section"><div class="section-heading panel-heading"><span>${tr('Tarefas')}</span><span class="task-count">${data.tasks.length}</span></div><div class="task-list">${data.tasks.length ? data.tasks.map(renderTask).join('') : `<p class="muted">${tr('Sem tarefas ainda.')}</p>`}</div></section>
    ${data.approvals.length ? `<section class="approvals-section"><div class="section-heading panel-heading"><span>${tr('Aprovação necessária')}</span><span class="task-count">${data.approvals.length}</span></div><div class="approval-list">${data.approvals.map(renderApproval).join('')}</div></section>` : ''}
    ${data.workspaceAttached ? `<section class="workspace-preview-section"><div class="section-heading panel-heading"><span>${tr('Pré-visualização do site')}</span><button class="button secondary preview-start-button" id="workspace-preview-start" type="button">${tr('Abrir pré-visualização do site')}</button></div><div id="workspace-preview-state">${data.workspacePreview ? renderWorkspacePreview(data.workspacePreview) : `<p class="muted">${tr('A pré-visualização executa um script do workspace numa cópia temporária por até 30 minutos.')}</p>`}</div></section>` : ''}
    <section class="artifacts-section"><div class="section-heading panel-heading"><span>${tr('Artefatos')}</span></div><div id="artifact-list" class="artifact-list"><p class="muted">${tr('Sem artifacts ainda.')}</p></div></section>
    <section class="conversation-section"><div class="section-heading panel-heading"><span>${tr('Conversa')}</span>${activeRun ? `<button id="cancel-run" class="stop-button">■ ${tr('Parar execução')}</button>` : ''}</div><div class="messages" id="messages">${renderMessages(data.messages)}</div><form id="message-form" class="composer">${steerableRun ? `<select id="message-mode" aria-label="${tr('Enviar para')}"><option value="enqueue">${tr('Enviar após o run atual')}</option><option value="steer">${tr('Orientar o run atual')}</option></select>${steerableTasks.length ? `<select id="steering-task" aria-label="${tr('Task que receberá a orientação')}" hidden><option value="">${tr('Todas as tasks')}</option>${steerableTasks.map((task) => `<option value="${esc(task.id)}">${esc(task.title)}</option>`).join('')}</select>` : ''}` : ''}<button class="attachment-button" id="pick-attachments" type="button" aria-label="${tr('Đính kèm tệp')}" title="${tr('Đính kèm tệp')}">📎</button><input id="attachment-input" type="file" accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json" multiple hidden><textarea id="message-input" name="text" rows="2" maxlength="20000" placeholder="${tr('Escreva para o Coordinator…')}" required></textarea><button class="send-button" type="submit" aria-label="${tr('Enviar')}">↑</button></form><div id="pending-attachments" class="pending-attachments"></div><div class="composer-hint">${steerableRun ? tr('Orientações são entregues no próximo ponto seguro do agente.') : activeRun ? activeRun.errorCode === 'WAITING_FOR_USER_INPUT' ? tr('Tin nhắn tiếp theo sẽ trả lời câu hỏi đang chờ.') : tr('Tin nhắn sẽ được xếp hàng sau lượt đang chạy.') : tr('Use Developer, Researcher, Analyst ou Writer para começar.')}</div></section>`;
  const messageInput = root.querySelector<HTMLTextAreaElement>('#message-input')!;
  messageInput.value = messageDrafts.get(project.id) ?? '';
  messageInput.addEventListener('input', () => storeMessageDraft(project.id, messageInput.value));
  renderedProjectId = project.id;
  const archiveButton = root.querySelector<HTMLButtonElement>('#archive-project');
  root.querySelector<HTMLButtonElement>('#close-project-panel')!.onclick = () => setProjectPanelOpen(false);
  if (archiveButton) archiveButton.onclick = archiveSelected;
  const restoreButton = root.querySelector<HTMLButtonElement>('#restore-project');
  if (restoreButton) restoreButton.onclick = restoreSelected;
  const cancelButton = root.querySelector<HTMLButtonElement>('#cancel-run');
  if (cancelButton) cancelButton.onclick = cancelActiveRun;
  const runActions = document.createElement('div');
  runActions.className = 'run-actions';
  if (canPauseRun && activeRun) {
    const pauseButton = document.createElement('button');
    pauseButton.id = 'pause-run';
    pauseButton.type = 'button';
    pauseButton.className = 'button secondary';
    pauseButton.textContent = activeRun.pauseRequested ? tr('Đang tạm dừng…') : tr('Tạm dừng');
    pauseButton.disabled = activeRun.pauseRequested;
    pauseButton.onclick = pauseActiveRun;
    runActions.appendChild(pauseButton);
  }
  if (canResumeRun) {
    const resumeButton = document.createElement('button');
    resumeButton.id = 'resume-run';
    resumeButton.type = 'button';
    resumeButton.className = 'button secondary';
    resumeButton.textContent = activeRun?.errorCode === 'BUDGET_EXHAUSTED' ? tr('Tăng ngân sách & tiếp tục') : tr('Tiếp tục');
    resumeButton.onclick = resumeActiveRun;
    runActions.appendChild(resumeButton);
  }
  if (cancelButton) {
    cancelButton.parentElement?.appendChild(runActions);
    runActions.appendChild(cancelButton);
  }
  const previewStart = root.querySelector<HTMLButtonElement>('#workspace-preview-start');
  if (previewStart) previewStart.onclick = () => void configureWorkspacePreview(project.id, previewStart);
  const previewOpen = root.querySelector<HTMLButtonElement>('[data-workspace-preview-open]');
  if (previewOpen && data.workspacePreview) previewOpen.onclick = () => openWorkspacePreview(data.workspacePreview!);
  const previewStop = root.querySelector<HTMLButtonElement>('[data-workspace-preview-stop]');
  if (previewStop && data.workspacePreview) previewStop.onclick = () => void stopWorkspacePreview(data.workspacePreview!.id, previewStop);
  const messageMode = root.querySelector<HTMLSelectElement>('#message-mode');
  if (messageMode) messageMode.onchange = () => {
    const target = root.querySelector<HTMLSelectElement>('#steering-task');
    if (target) target.hidden = messageMode.value !== 'steer';
  };
  root.querySelector<HTMLButtonElement>('#pick-attachments')!.onclick = () => { if (!busy) root.querySelector<HTMLInputElement>('#attachment-input')!.click(); };
  root.querySelector<HTMLInputElement>('#attachment-input')!.onchange = (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const incoming = Array.from(input.files ?? []);
    input.value = '';
    const error = attachmentDraft.add(incoming);
    if (error === 'too-many') { showBanner(tr('Tối đa 5 tệp cho mỗi tin nhắn.')); return; }
    if (error === 'unsupported-type') { showBanner(tr('Chỉ hỗ trợ tệp .txt, .md, .csv, .json tối đa 64 KB mỗi tệp.')); return; }
    if (error === 'file-too-large') { showBanner(tr('Chỉ hỗ trợ tệp .txt, .md, .csv, .json tối đa 64 KB mỗi tệp.')); return; }
    if (error === 'total-too-large') { showBanner(tr('Tổng tệp đính kèm không được vượt quá 160 KB.')); return; }
    renderPendingAttachments();
  };
  renderPendingAttachments();
  root.querySelectorAll<HTMLButtonElement>('[data-approval-id]').forEach((button) => {
    button.onclick = () => void decideApproval(button.dataset.approvalId!, button.dataset.decision as 'approve' | 'deny', button);
  });
  root.querySelector<HTMLFormElement>('#message-form')!.onsubmit = sendMessage;
  root.querySelector<HTMLFormElement>('#memory-form')!.onsubmit = addMemory;
  root.querySelector<HTMLButtonElement>('#memory-export')!.onclick = () => void exportMemory();
  root.querySelector<HTMLButtonElement>('#memory-import-trigger')!.onclick = () => root.querySelector<HTMLInputElement>('#memory-import-file')!.click();
  root.querySelector<HTMLInputElement>('#memory-import-file')!.onchange = (event) => void importMemory((event.currentTarget as HTMLInputElement).files?.[0]);
  root.querySelector<HTMLButtonElement>('#project-memory-markdown-export')!.onclick = () => void exportProjectMemoryMarkdown();
  root.querySelector<HTMLButtonElement>('#project-memory-markdown-import-trigger')!.onclick = () => root.querySelector<HTMLInputElement>('#project-memory-markdown-import-file')!.click();
  root.querySelector<HTMLInputElement>('#project-memory-markdown-import-file')!.onchange = (event) => void importProjectMemoryMarkdown((event.currentTarget as HTMLInputElement).files?.[0]);
  root.querySelector<HTMLSelectElement>('#memory-scope-type')!.onchange = (event) => {
    root.querySelector<HTMLSelectElement>('#memory-scope-id')!.hidden = (event.currentTarget as HTMLSelectElement).value !== 'agent';
  };
  root.querySelectorAll<HTMLButtonElement>('[data-memory-save]').forEach((button) => { button.onclick = () => void saveMemory(button); });
  root.querySelectorAll<HTMLButtonElement>('[data-memory-delete]').forEach((button) => { button.onclick = () => void deleteMemory(button); });
  root.querySelectorAll<HTMLButtonElement>('[data-memory-decision]').forEach((button) => { button.onclick = () => void decideMemory(button); });
  root.querySelector<HTMLInputElement>('#message-input')!.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); root.querySelector<HTMLFormElement>('#message-form')!.requestSubmit(); }
  });
  void loadArtifacts(project.id);
  void loadUsage(project.id, activeRun?.id);
}

function renderWorkspacePreview(preview: WorkspacePreviewInfo): string {
  const expiresAt = new Date(preview.expiresAt).toLocaleTimeString(getLocale() === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  return `<article class="workspace-preview-card"><div><strong>${esc(preview.script)}</strong><small>${tr('Pré-visualização ativa até {0}.', [expiresAt])}</small></div><div class="workspace-preview-actions"><button class="button secondary" data-workspace-preview-open type="button">${tr('Abrir site')}</button><button class="button secondary" data-workspace-preview-stop type="button">${tr('Parar pré-visualização')}</button></div></article>`;
}

async function configureWorkspacePreview(projectId: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const setup = await fetchJson<WorkspacePreviewSetup>(`/platform/v1/projects/${encodeURIComponent(projectId)}/workspace-preview`);
    if (!setup.scripts.length) { showBanner(tr('Nenhum script dev, preview, start ou serve foi encontrado no package.json.')); return; }
    const dialog = document.createElement('dialog');
    dialog.className = 'workspace-preview-setup-dialog';
    const scripts = setup.scripts.map((script) => `<option value="${esc(script.name)}">npm run ${esc(script.name)}</option>`).join('');
    const localTrusted = setup.executionMode === 'local-trusted';
    const install = setup.dependencyInstall;
    dialog.innerHTML = `<form method="dialog" class="workspace-preview-form"><div class="artifact-preview-heading"><strong>${tr('Pré-visualização do site')}</strong><button class="icon-button" type="button" data-close-preview-dialog aria-label="${tr('Fechar')}">×</button></div><div class="workspace-preview-form-body"><label>${tr('Script para executar')}<select name="script">${scripts}</select></label><div class="preview-command-label">${tr('Comando')}</div><pre id="workspace-preview-command"></pre><ul id="workspace-preview-hooks" class="preview-hook-list"></ul><p class="memory-hint">${tr('O script será executado numa cópia temporária do workspace.')}</p><p class="memory-hint">${localTrusted ? tr('No modo local confiável, o script usa sua conta do Windows e pode acessar a rede; não é um sandbox.') : tr('O container Docker usará a rede bridge e poderá acessar a internet.')}</p>${install ? `<p class="memory-hint">${tr('Será usado npm ci; revise o lockfile e os lifecycle hooks abaixo.')}</p><p class="memory-hint">${tr('SHA-256 do lockfile')}: <code>${esc(install.lockChecksum)}</code></p>` : ''}<label class="preview-network-consent"><input type="checkbox" name="networkConsent">${tr('Confirmo que este script pode acessar a rede.')}</label><small>${tr('A pré-visualização dura até 30 minutos e pode ser interrompida a qualquer momento.')}</small><div class="workspace-preview-form-actions"><button class="button secondary" type="button" data-close-preview-dialog>${tr('Fechar')}</button><button class="button primary" type="submit">${tr('Iniciar pré-visualização')}</button></div></div></form>`;
    document.body.append(dialog);
    const scriptSelect = dialog.querySelector<HTMLSelectElement>('select[name="script"]')!;
    const command = dialog.querySelector<HTMLElement>('#workspace-preview-command')!;
    const hookList = dialog.querySelector<HTMLElement>('#workspace-preview-hooks')!;
    const updateScript = () => {
      const selected = setup.scripts.find((script) => script.name === scriptSelect.value)!;
      command.textContent = `npm run ${selected.name}`;
      hookList.innerHTML = selected.lifecycle.filter((hook) => hook.name !== selected.name).map((hook) => `<li><strong>${esc(hook.name)}</strong><code>${esc(hook.command)}</code></li>`).join('');
    };
    updateScript();
    scriptSelect.onchange = updateScript;
    dialog.querySelectorAll<HTMLButtonElement>('[data-close-preview-dialog]').forEach((close) => { close.onclick = () => dialog.close(); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.onsubmit = (event) => {
      event.preventDefault();
      const consent = dialog.querySelector<HTMLInputElement>('input[name="networkConsent"]')!;
      if (!consent.checked) { showBanner(tr('Marque a caixa para confirmar o acesso à rede.')); return; }
      dialog.close();
      const script = setup.scripts.find((item) => item.name === scriptSelect.value)!;
      void startWorkspacePreview(projectId, script.name, setup.packageChecksum, setup.dependencyInstall?.lockChecksum, consent.checked, button);
    };
    dialog.showModal();
  } catch (error) {
    showBanner(error instanceof Error ? error.message : tr('Pré-visualização indisponível.'));
  } finally {
    button.disabled = false;
  }
}

async function startWorkspacePreview(projectId: string, script: string, packageChecksum: string, dependencyInstallChecksum: string | undefined, allowNetworkAccess: boolean, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const result = await fetchJson<{ preview: WorkspacePreviewInfo }>(`/platform/v1/projects/${encodeURIComponent(projectId)}/workspace-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script, packageChecksum, dependencyInstallChecksum, allowNetworkAccess }),
    });
    if (projectDetail?.project.id === projectId) {
      projectDetail.workspacePreview = result.preview;
      renderProjectPanel(projectDetail);
      openWorkspacePreview(result.preview);
    }
  } catch (error) {
    showBanner(error instanceof Error ? error.message : tr('Falha ao iniciar a pré-visualização.'));
  } finally {
    button.disabled = false;
  }
}

function openWorkspacePreview(preview: WorkspacePreviewInfo): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'artifact-preview-dialog workspace-preview-dialog';
  dialog.innerHTML = `<div class="artifact-preview-heading"><strong>${tr('Pré-visualização do site')} · ${esc(preview.script)}</strong><button class="icon-button" type="button" aria-label="${tr('Fechar')}">×</button></div><div class="workspace-preview-guidance"><p>${tr('Trang preview chạy mã trong workspace và chỉ nên mở ở tab riêng.')}</p><a class="button primary" href="${esc(preview.url)}" target="_blank" rel="noopener noreferrer">${tr('Abrir em nova guia')}</a></div>`;
  dialog.querySelector<HTMLButtonElement>('button')!.onclick = () => dialog.close();
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

async function stopWorkspacePreview(id: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await fetchJson<void>(`/platform/v1/workspace-previews/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (projectDetail?.workspacePreview?.id === id) {
      projectDetail.workspacePreview = null;
      renderProjectPanel(projectDetail);
    }
  } catch (error) {
    showBanner(error instanceof Error ? error.message : tr('Pré-visualização indisponível.'));
  } finally {
    button.disabled = false;
  }
}

function renderMemory(memory: MemoryRecord): string {
  const status = memory.status === 'accepted' ? tr('Đã chấp nhận') : memory.status === 'proposed' ? tr('Chờ bạn xem xét') : tr('Đã từ chối');
  const editable = memory.sourceType === 'owner_note' && memory.status === 'accepted';
  const scope = memory.scopeType === 'user' ? tr('Người dùng') : memory.scopeType === 'agent' ? `${tr('Agent')}: ${esc(labels.role[memory.scopeId] ?? memory.scopeId)}` : memory.scopeType === 'run' ? tr('Run hiện tại') : tr('Project này');
  const proposalActions = memory.status === 'proposed' ? `<button class="button secondary" data-memory-decision="accept" data-memory-id="${esc(memory.id)}" data-revision="${memory.revision}">${tr('Chấp nhận ghi nhớ')}</button><button class="button secondary" data-memory-decision="reject" data-memory-id="${esc(memory.id)}" data-revision="${memory.revision}">${tr('Từ chối đề xuất')}</button>` : '';
  return `<article class="memory-card"><div class="memory-meta"><span>${esc(scope)} · ${esc(status)}</span><small>${tr('Nguồn')}: ${esc(memory.sourceType)} · ${tr('Lần sửa')}: ${memory.revision}</small></div>${editable ? `<textarea data-memory-content="${esc(memory.id)}" maxlength="8000">${esc(memory.content)}</textarea><div class="memory-actions"><button class="button secondary" data-memory-save="${esc(memory.id)}" data-revision="${memory.revision}">${tr('Cập nhật')}</button>` : `<p>${esc(memory.content)}</p><div class="memory-actions">`}${proposalActions}<button class="button secondary" data-memory-delete="${esc(memory.id)}" data-revision="${memory.revision}">${tr('Xóa')}</button></div></article>`;
}

async function addMemory(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!projectDetail) return;
  const form = event.currentTarget as HTMLFormElement;
  const formData = new FormData(form);
  const content = formData.get('content');
  const scopeType = formData.get('scopeType');
  if (typeof content !== 'string') return;
  try {
    if (scopeType === 'project') {
      await fetchJson(`/platform/v1/projects/${encodeURIComponent(projectDetail.project.id)}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
    } else {
      await fetchJson('/platform/v1/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scopeType, scopeId: scopeType === 'agent' ? formData.get('scopeId') : 'local-user', content }) });
    }
    form.reset();
    await refresh(false);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Không thể lưu ghi nhớ.')); }
}

async function exportMemory(): Promise<void> {
  try {
    const bundle = await fetchJson<Record<string, unknown>>('/platform/v1/memory/export');
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `agent-office-memory-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Não foi possível exportar as memórias.')); }
}

async function importMemory(file?: File): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('#memory-import-file');
  if (!file || !input) return;
  try {
    if (file.size > 10_000_000) throw new Error(tr('O arquivo de memória excede o limite de 10 MB.'));
    const bundle: unknown = JSON.parse(await file.text());
    if (!window.confirm(tr('Importar o arquivo {0}? Registros iguais serão ignorados e conflitos não serão sobrescritos.', [file.name]))) return;
    const result = await fetchJson<{ imported: number; skipped: number }>('/platform/v1/memory/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle),
    });
    showBanner(tr('Importação concluída: {0} novas, {1} já existiam.', [result.imported, result.skipped]), 'success');
    await refresh(false);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Não foi possível importar as memórias.')); }
  finally { input.value = ''; }
}

async function exportProjectMemoryMarkdown(): Promise<void> {
  if (!projectDetail) return;
  try {
    const path = `/platform/v1/projects/${encodeURIComponent(projectDetail.project.id)}/memory.md`;
    const response = await fetch(path, { credentials: 'same-origin' });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? tr('Não foi possível exportar memory.md.'));
    }
    const blob = new Blob([await response.text()], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'memory.md';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Não foi possível exportar memory.md.')); }
}

async function importProjectMemoryMarkdown(file?: File): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('#project-memory-markdown-import-file');
  if (!file || !input || !projectDetail) return;
  try {
    if (file.size > 20_000_000) throw new Error(tr('O arquivo memory.md excede o limite de 20 MB.'));
    const markdown = await file.text();
    const projectPath = `/platform/v1/projects/${encodeURIComponent(projectDetail.project.id)}/memory.md`;
    const preview = await fetchJson<ProjectMemoryMarkdownPreview>(`${projectPath}/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown }),
    });
    if (!preview.changedCount) {
      showBanner(tr('memory.md não contém alterações para aplicar.'), 'info');
      return;
    }
    const changes = preview.changes.slice(0, 8).map((change) => `${change.id.slice(0, 8)}: “${change.before}” → “${change.after}”`).join('\n');
    const remainder = preview.changedCount > preview.changes.length ? `\n${tr('Ainda há {0} alterações.', [preview.changedCount - preview.changes.length])}` : '';
    if (!window.confirm(tr('Aplicar {0} alteração(ões) de memory.md?\n\n{1}{2}\n\nAs notas atualizadas receberão a próxima revisão.', [preview.changedCount, changes, remainder]))) return;
    const result = await fetchJson<ProjectMemoryMarkdownPreview>(projectPath, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: preview.expectedRevision, markdown }),
    });
    showBanner(tr('{0} notas foram atualizadas a partir de memory.md.', [result.changedCount]), 'success');
    await refresh(false);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Não foi possível importar memory.md.')); }
  finally { input.value = ''; }
}

async function saveMemory(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.memorySave;
  const content = id ? root.querySelector<HTMLTextAreaElement>(`[data-memory-content="${CSS.escape(id)}"]`)?.value : undefined;
  if (!id || content === undefined) return;
  try {
    await fetchJson(`/platform/v1/memory/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: Number(button.dataset.revision), content }) });
    await refresh(false);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Không thể cập nhật ghi nhớ.')); }
}

async function deleteMemory(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.memoryDelete;
  if (!id || !window.confirm(tr('Bạn có chắc muốn xóa ghi nhớ này?'))) return;
  try {
    await fetchJson(`/platform/v1/memory/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: Number(button.dataset.revision) }) });
    await refresh(false);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Không thể xóa ghi nhớ.')); }
}

async function decideMemory(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.memoryId;
  const decision = button.dataset.memoryDecision;
  if (!id || (decision !== 'accept' && decision !== 'reject')) return;
  try {
    await fetchJson(`/platform/v1/memory/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: Number(button.dataset.revision), decision }) });
    await refresh(false);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Không thể ghi nhận quyết định.')); }
}

function renderTask(task: Task): string {
  const label = task.status === 'succeeded' ? tr('Concluída') : task.status === 'running' ? tr('Executando') : task.status === 'failed' ? tr('Falhou') : task.status === 'waiting_approval' ? tr('Aguardando sua aprovação') : task.status === 'blocked_dependencies' ? tr('Bloqueada por dependência') : tr('Planejada');
  const symbol = task.status === 'succeeded' ? '✓' : task.status === 'failed' ? '!' : task.status === 'running' ? '◌' : task.status === 'waiting_approval' ? '!' : '·';
  return `<details class="task-card"><summary><span class="task-state ${esc(task.status)}">${symbol}</span><span class="task-copy"><strong>${esc(task.title)}</strong><small>${esc(label)}</small></span><span class="task-chevron">⌄</span></summary><div class="task-detail"><p>${esc(task.objective)}</p>${task.output ? `<pre>${esc(task.output)}</pre>` : ''}</div></details>`;
}

function renderApproval(approval: Approval): string {
  if (approval.toolId === 'workspace.run_checks') {
    const checks = Array.isArray(approval.arguments.checks) ? approval.arguments.checks.filter((item): item is { name: string; command: string; lifecycle: Array<{ name: string; command: string }> } => !!item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' && typeof (item as { command?: unknown }).command === 'string') : [];
    const scripts = checks.map((check) => `<li><strong>${esc(check.name)}</strong><pre>${esc((Array.isArray(check.lifecycle) ? check.lifecycle : []).map((part) => `${part.name}: ${part.command}`).join('\n') || `${check.name}: ${check.command}`)}</pre></li>`).join('');
    const execution = approval.arguments.execution && typeof approval.arguments.execution === 'object' ? approval.arguments.execution as Record<string, unknown> : {};
    const dependencyInstall = approval.arguments.dependencyInstall && typeof approval.arguments.dependencyInstall === 'object' ? approval.arguments.dependencyInstall as Record<string, unknown> : null;
    const docker = execution.mode === 'docker';
    const network = execution.network === 'bridge' ? tr('Container được phép truy cập mạng.') : tr('Container không có kết nối mạng.');
    const installLifecycle = dependencyInstall && Array.isArray(dependencyInstall.lifecycle)
      ? dependencyInstall.lifecycle.filter((item): item is { name: string; command: string } => !!item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' && typeof (item as { command?: unknown }).command === 'string').map((item) => `${item.name}: ${item.command}`).join('\n')
      : '';
    const installDetails = dependencyInstall
      ? `<p><strong>${tr('Cài dependencies bằng npm ci')}:</strong> <code>${esc(String(dependencyInstall.command ?? 'npm ci'))}</code> · ${tr('SHA-256 lockfile')}: <code>${esc(String(dependencyInstall.lockChecksum ?? ''))}</code></p>${installLifecycle ? `<details><summary>${tr('Xem lifecycle hooks cài đặt')}</summary><pre>${esc(installLifecycle)}</pre></details>` : ''}<p>${tr('npm ci chạy lifecycle hooks của project và package dependencies bên trong container.')}</p>`
      : '';
    const executionDetails = docker
      ? `<p><strong>${tr('Sandbox Docker')}:</strong> ${tr('Docker image')}: <code>${esc(String(execution.image ?? ''))}</code> · ${tr('Network mode')}: <code>${esc(String(execution.network ?? 'none'))}</code>.</p><p>${network}</p>${installDetails}<p>${tr('Giới hạn: CPU {0}, RAM {1} MB, tối đa {2} process.', [execution.cpus ?? '?', execution.memoryMb ?? '?', execution.pidsLimit ?? '?'])}</p><p>${tr('Mỗi lệnh chạy tối đa 10 phút; output mỗi lệnh tối đa 24 KB.')}</p><p>${tr('Chỉ bản sao workspace đã lọc được mount; root filesystem chỉ đọc. Container bị xóa khi kết thúc.')}</p><p>${tr('Container không nhận API key hoặc environment của Agent Office.')}</p>`
      : `<p><strong>${tr('Chế độ local-trusted')}:</strong> ${tr('Script chạy bằng tài khoản Windows hiện tại, có thể truy cập mạng; không phải sandbox.')}</p><p>${tr('Lệnh chạy trên bản sao tạm; các thay đổi trong bản sao sẽ bị xóa.')}</p>`;
    return `<article class="approval-card"><div class="approval-heading"><strong>${tr('Chạy kiểm tra workspace')}</strong><code>${esc(String(approval.arguments.packageName ?? 'package'))}</code></div>${executionDetails}<details open><summary>${tr('Xem scripts và lệnh')}</summary><ol>${scripts || `<li>${tr('Không có script hợp lệ để hiển thị.')}</li>`}</ol></details><small>${tr('SHA-256 package.json')}: <code>${esc(String(approval.arguments.packageChecksum ?? ''))}</code></small><small>${tr('Hash da solicitação')}: <code>${esc(approval.argumentsHash)}</code></small><div class="approval-actions"><button class="button secondary" data-approval-id="${esc(approval.id)}" data-decision="deny">${tr('Recusar')}</button><button class="button primary" data-approval-id="${esc(approval.id)}" data-decision="approve">${tr('Aprovar e executar')}</button></div></article>`;
  }
  const path = typeof approval.arguments.path === 'string' ? approval.arguments.path : '';
  const content = typeof approval.arguments.content === 'string' ? approval.arguments.content : '';
  const checksum = typeof approval.arguments.expectedChecksum === 'string' ? approval.arguments.expectedChecksum : null;
  const action = checksum ? tr('Substituir arquivo') : tr('Criar arquivo');
  const diff = renderApprovalDiff(approval.arguments, content);
  return `<article class="approval-card"><div class="approval-heading"><strong>${esc(action)}</strong><code>${esc(path)}</code></div><p>${tr('O conteúdo será gravado depois da sua aprovação.')}</p>${diff}<details><summary>${tr('Ver conteúdo proposto')} · ${formatSize(new TextEncoder().encode(content).byteLength)}</summary><pre>${esc(content)}</pre></details>${checksum ? `<small>${tr('SHA-256 atual')}: <code>${esc(checksum)}</code></small>` : ''}<small>${tr('Hash da solicitação')}: <code>${esc(approval.argumentsHash)}</code></small><div class="approval-actions"><button class="button secondary" data-approval-id="${esc(approval.id)}" data-decision="deny">${tr('Recusar')}</button><button class="button primary" data-approval-id="${esc(approval.id)}" data-decision="approve">${tr('Aprovar e gravar arquivo')}</button></div></article>`;
}

function renderApprovalDiff(approvalArguments: Record<string, unknown>, proposedContent: string): string {
  const before = approvalArguments.previewBaseContent;
  if (typeof before !== 'string') return approvalArguments.previewBaseAvailable === false
    ? `<p class="approval-diff-unavailable">${tr('Não foi possível gerar diff para este arquivo. O tamanho ou formato impede uma comparação lado a lado.')}</p>`
    : '';
  const diff = createApprovalDiff(before, proposedContent);
  if (!diff.available) return `<p class="approval-diff-unavailable">${tr('Diff muito grande para exibir linha a linha. Confira o conteúdo atual e o conteúdo proposto.')}</p><details><summary>${tr('Conteúdo atual')}</summary><pre>${esc(before)}</pre></details>`;
  if (!diff.lines.length) return `<p class="approval-diff-empty">${tr('O conteúdo atual e o proposto são iguais.')}</p>`;
  const summary = tr('+ {0} linhas · − {1} linhas', [diff.additions, diff.deletions]);
  const lines = diff.lines.map((line) => {
    const marker = line.kind === 'addition' ? '+ ' : line.kind === 'deletion' ? '− ' : '  ';
    return `<span class="approval-diff-line ${line.kind}">${esc(marker + line.text)}</span>`;
  }).join('\n');
  return `<details class="approval-diff" open><summary>${tr('Ver diff')} · ${summary}</summary><pre>${lines}</pre></details>`;
}

function renderMessages(messages: Message[]): string {
  const items = messages.map((message) => `<article class="message ${message.speaker === 'user' ? 'user-message' : 'agent-message'}"><div class="message-label">${esc(message.speaker === 'user' ? 'Bạn' : message.speaker === 'specialist' ? agentName(message.agentInstanceId) : 'Coordinator')}<time>${new Date(message.createdAt).toLocaleTimeString(getLocale() === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}</time></div><div class="message-body">${esc(message.content)}${message.attachments?.length ? `<div class="message-attachments">${message.attachments.map((file) => `<span class="message-attachment">📎 ${esc(file.name)} <small>${formatSize(file.sizeBytes)}</small></span>`).join('')}</div>` : ''}</div></article>`).join('');
  const streaming = streamText && projectDetail?.messages.some((message) => message.runId === streamRunId) ? `<article class="message agent-message streaming-message"><div class="message-label">${tr('Escrevendo…')}</div><div class="message-body">${esc(streamText)}<span class="typing-cursor"></span></div></article>` : '';
  return `${items}${streaming}` || `<div class="empty-messages"><span>✦</span><p>${tr('Selecione ou crie um projeto para começar.')}</p></div>`;
}

async function loadArtifacts(projectId: string): Promise<void> {
  const target = root.querySelector<HTMLElement>('#artifact-list');
  if (!target) return;
  try {
    const data = await fetchJson<{ artifacts: Artifact[] }>(`/platform/v1/artifacts?projectId=${encodeURIComponent(projectId)}`);
    if (!root.querySelector('#artifact-list')) return;
    target.innerHTML = data.artifacts.length ? data.artifacts.map((artifact) => `<div class="artifact-row"><button class="artifact-preview-button" type="button" data-artifact-preview="${esc(artifact.versionId)}" aria-label="${tr('Pré-visualizar')}" title="${tr('Pré-visualizar')}">${tr('Pré-visualizar')}</button><a class="artifact-link" href="/platform/v1/artifact-versions/${encodeURIComponent(artifact.versionId)}/content"><span class="artifact-icon">▤</span><span><strong>${esc(artifact.logicalName)}</strong><small>${formatSize(artifact.sizeBytes)}</small></span><span>↓</span></a></div>`).join('') : `<p class="muted">${tr('Sem artifacts ainda.')}</p>`;
    target.querySelectorAll<HTMLButtonElement>('[data-artifact-preview]').forEach((button) => {
      button.onclick = () => void previewArtifact(button.dataset.artifactPreview!, projectId, button);
    });
  } catch { target.innerHTML = `<p class="muted">${tr('Sem artifacts ainda.')}</p>`; }
}

async function previewArtifact(versionId: string, projectId: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const preview = await fetchJson<{ url: string }>(`/platform/v1/artifacts/${encodeURIComponent(versionId)}/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }),
    });
    const target = new URL(preview.url, window.location.origin);
    if (target.origin !== window.location.origin || !target.pathname.startsWith('/platform/v1/artifact-previews/')) throw new Error(tr('Não foi possível abrir a pré-visualização.'));
    const dialog = document.createElement('dialog');
    dialog.className = 'artifact-preview-dialog';
    dialog.innerHTML = `<div class="artifact-preview-heading"><strong>${tr('Pré-visualização segura')}</strong><button class="icon-button" type="button" aria-label="${tr('Fechar pré-visualização')}">×</button></div><iframe class="artifact-preview-frame" title="${tr('Pré-visualização segura')}" sandbox="" src="${esc(target.pathname)}"></iframe>`;
    dialog.querySelector<HTMLButtonElement>('button')!.onclick = () => dialog.close();
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => {
      dialog.remove();
      void fetchJson<void>(target.pathname, { method: 'DELETE' }).catch(() => undefined);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  } catch (error) {
    showBanner(error instanceof Error ? error.message : tr('Não foi possível abrir a pré-visualização.'));
  } finally {
    button.disabled = false;
  }
}

async function loadUsage(projectId: string, activeRunId?: string): Promise<void> {
  const target = root.querySelector<HTMLElement>('#usage-summary');
  if (!target) return;
  try {
    const result = await fetchJson<UsageReply>(`/platform/v1/usage?projectId=${encodeURIComponent(projectId)}`);
    if (!root.querySelector('#usage-summary')) return;
    const run = result.budget.runs.find((item) => item.runId === activeRunId) ?? result.budget.runs[0];
    const number = new Intl.NumberFormat(getLocale() === 'vi' ? 'vi-VN' : 'en-US');
    if (!run) {
      target.innerHTML = `<p class="muted">${tr('Sem uso de model ainda.')}</p>`;
      return;
    }
    const runTotal = run.measuredTokens + run.reservedTokens;
    const percent = Math.min(100, Math.round(runTotal / run.limitTokens * 100));
    const money = new Intl.NumberFormat(getLocale() === 'vi' ? 'vi-VN' : 'en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
    const measuredCostMicrousd = run.measuredCostMicrousd ?? 0;
    const reservedCostMicrousd = run.reservedCostMicrousd ?? 0;
    const moneyBudgetMicrousd = run.moneyBudgetMicrousd ?? null;
    const unpricedRequests = run.unpricedRequests ?? 0;
    const runKnownCostMicrousd = measuredCostMicrousd + reservedCostMicrousd;
    const costRows = moneyBudgetMicrousd !== null || runKnownCostMicrousd > 0
      ? `<div class="usage-line"><span>${tr('Custo conhecido (USD)')}</span><strong>${money.format(measuredCostMicrousd / 1_000_000)}</strong></div>
         <div class="usage-line"><span>${tr('Reserva de custo conservadora (USD)')}</span><strong>${money.format(reservedCostMicrousd / 1_000_000)}</strong></div>
         ${moneyBudgetMicrousd !== null ? `<div class="usage-meter money" role="meter" aria-label="${tr('Orçamento monetário do run')}" aria-valuemin="0" aria-valuemax="${moneyBudgetMicrousd / 1_000_000}" aria-valuenow="${Math.min(runKnownCostMicrousd, moneyBudgetMicrousd) / 1_000_000}"><span style="width:${Math.min(100, Math.round(runKnownCostMicrousd / moneyBudgetMicrousd * 100))}%"></span></div>
         <div class="usage-line"><span>${tr('Orçamento monetário do run')}</span><strong>${money.format(runKnownCostMicrousd / 1_000_000)} / ${money.format(moneyBudgetMicrousd / 1_000_000)}</strong></div>` : ''}`
      : '';
    target.innerHTML = `<div class="usage-meter" role="meter" aria-label="${tr('Orçamento do run')}" aria-valuemin="0" aria-valuemax="${run.limitTokens}" aria-valuenow="${Math.min(runTotal, run.limitTokens)}"><span style="width:${percent}%"></span></div>
      <div class="usage-line"><span>${tr('Run atual')}</span><strong>${number.format(runTotal)} / ${number.format(run.limitTokens)}</strong></div>
      <div class="usage-line"><span>${tr('Tokens medidos')}</span><strong>${number.format(run.measuredTokens)}</strong></div>
      <div class="usage-line"><span>${tr('Reserva conservadora')}</span><strong>${number.format(run.reservedTokens)}</strong></div>
      <small>${tr('Tokens medidos no projeto: {0}', [number.format(result.budget.measuredTokens)])}</small>
      ${costRows}
      ${unpricedRequests ? `<small class="usage-warning">${tr('Chamadas sem preço configurado: {0}', [unpricedRequests])}</small>` : ''}
      ${run.unknownRequests ? `<small class="usage-warning">${tr('Chamadas sem usage confirmado: {0}', [run.unknownRequests])}</small>` : ''}`;
  } catch {
    target.innerHTML = `<p class="muted">${tr('Não foi possível carregar o uso de tokens.')}</p>`;
  }
}

async function createProject(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  button.disabled = true;
  try {
    const result = await fetchJson<{ project: Project }>('/platform/v1/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ name: data.get('name'), goal: data.get('goal'), workspaceRoot: data.get('workspaceRoot') || undefined }),
    });
    root.querySelector<HTMLDialogElement>('#new-project-dialog')!.close();
    form.reset();
    archived = false;
    await refresh(false);
    await selectProject(result.project.id);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Não foi possível criar o projeto.')); }
  finally { button.disabled = false; }
}

async function reloadAgents(): Promise<void> {
  const button = root.querySelector<HTMLButtonElement>('#reload-agents');
  if (!button || button.disabled) return;
  button.disabled = true;
  button.textContent = tr('Verificando novos agentes…');
  try {
    const preview = await fetchJson<RegistryPreview>('/platform/v1/registry/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!preview.canApply || !preview.previewToken) {
      showBanner(tr('Nenhum agente novo compatível foi encontrado. Verifique a configuração e tente novamente.'), 'info');
      return;
    }
    const agents = preview.addedAgents.map((agent) => `${agent.displayName} (${agent.id})`).join(', ');
    if (!window.confirm(tr('Carregar os novos agentes no escritório?\n\n{0}', [agents]))) return;
    const result = await fetchJson<{ applied: boolean; addedAgents: Array<{ id: string; displayName: string }> }>('/platform/v1/registry/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    await refresh(false);
    showBanner(tr('Novos agentes carregados no escritório: {0}.', [result.addedAgents.length]), 'success');
  } catch (error) {
    showBanner(error instanceof Error ? error.message : tr('Não foi possível carregar novos agentes.'));
  } finally {
    button.disabled = false;
    button.textContent = tr('Carregar novos agentes');
  }
}

async function sendMessage(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!projectDetail || busy) return;
  const submittedProject = projectDetail.project;
  const form = event.currentTarget as HTMLFormElement;
  const input = form.querySelector<HTMLTextAreaElement>('#message-input')!;
  const activeRun = projectDetail.activeRuns.find((run) => ['queued', 'planning', 'executing', 'waiting_approval', 'paused'].includes(run.status));
  const mode = form.querySelector<HTMLSelectElement>('#message-mode')?.value ?? (activeRun ? 'enqueue' : 'new-run');
  const steerableRun = projectDetail.activeRuns.find((run) => ['planning', 'executing', 'waiting_approval', 'paused'].includes(run.status) && !['WAITING_FOR_USER_INPUT', 'FINALIZING'].includes(run.errorCode ?? ''));
  const targetTaskId = mode === 'steer' ? form.querySelector<HTMLSelectElement>('#steering-task')?.value : undefined;
  const text = input.value.trim();
  if (!text) return;
  messageDrafts.delete(submittedProject.id);
  busy = true;
  input.value = '';
  input.disabled = true;
  root.querySelector<HTMLButtonElement>('#pick-attachments')!.disabled = true;
  try {
    const attachments = await Promise.all(attachmentDraft.files.map(async (file) => ({ name: file.name, mimeType: attachmentMime(file.name)!, content: await file.text() })));
    await fetchJson(`/platform/v1/conversations/${encodeURIComponent(submittedProject.conversationId)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ text, mode, ...(targetTaskId ? { targetTaskId } : {}), ...(mode === 'steer' && steerableRun ? { expectedVersion: steerableRun.version } : {}), ...(attachments.length ? { attachments } : {}) }),
    });
    attachmentDraft.clear();
    await refresh(false);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Não foi possível enviar a mensagem.')); input.value = text; storeMessageDraft(submittedProject.id, text); }
  finally { busy = false; input.disabled = false; renderPendingAttachments(); input.focus(); }
}

function storeMessageDraft(projectId: string, text: string): void {
  messageDrafts.delete(projectId);
  messageDrafts.set(projectId, text);
  while (messageDrafts.size > 100) messageDrafts.delete(messageDrafts.keys().next().value!);
}

async function archiveSelected(): Promise<void> {
  if (!selectedProjectId) return;
  try {
    await fetchJson(`/platform/v1/projects/${encodeURIComponent(selectedProjectId)}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    selectedProjectId = null;
    await refresh();
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Não foi possível arquivar o projeto.')); }
}

async function restoreSelected(): Promise<void> {
  const projectId = selectedProjectId;
  if (!projectId) return;
  try {
    await fetchJson(`/platform/v1/projects/${encodeURIComponent(projectId)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    archived = false;
    selectedProjectId = projectId;
    await refresh();
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Não foi possível restaurar o projeto.')); }
}

async function decideApproval(approvalId: string, decision: 'approve' | 'deny', button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await fetchJson(`/platform/v1/approvals/${encodeURIComponent(approvalId)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
    await refresh(false);
  } catch (error) {
    showBanner(error instanceof Error ? error.message : tr('Não foi possível registrar a decisão.'));
    button.disabled = false;
  }
}

async function cancelActiveRun(): Promise<void> {
  const run = projectDetail?.activeRuns.find((item) => ['queued', 'planning', 'executing', 'waiting_approval', 'paused'].includes(item.status));
  if (!run) return;
  try { await fetchJson(`/platform/v1/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await refresh(false); }
  catch (error) { showBanner(error instanceof Error ? error.message : tr('Não foi possível parar a execução.')); }
}

async function pauseActiveRun(): Promise<void> {
  const run = projectDetail?.activeRuns.find((item) => ['queued', 'planning', 'executing'].includes(item.status));
  if (!run || run.pauseRequested) return;
  try {
    await fetchJson(`/platform/v1/runs/${encodeURIComponent(run.id)}/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: run.version }) });
    await refresh(false);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Không thể tạm dừng run.')); }
}

async function resumeActiveRun(): Promise<void> {
  const run = projectDetail?.activeRuns.find((item) => item.status === 'paused' && ['USER_PAUSED', 'BUDGET_EXHAUSTED'].includes(item.errorCode ?? ''));
  if (!run) return;
  let approvedBudget: { tokenBudget?: number; moneyBudgetUsd?: number } | undefined;
  if (run.errorCode === 'BUDGET_EXHAUSTED') {
    const rawTokens = window.prompt(tr('Ngân sách token mới (tổng; để trống nếu chỉ tăng USD):'));
    if (rawTokens === null) return;
    const rawUsd = window.prompt(tr('Ngân sách USD mới (để trống nếu chỉ tăng token):'));
    if (rawUsd === null) return;
    const tokenText = rawTokens.trim();
    const usdText = rawUsd.trim();
    const tokenBudget = tokenText ? Number(tokenText) : undefined;
    const moneyBudgetUsd = usdText ? Number(usdText) : undefined;
    if (tokenText && (!Number.isSafeInteger(tokenBudget) || tokenBudget! < 1024 || tokenBudget! > 10_000_000)
      || usdText && (!Number.isFinite(moneyBudgetUsd) || moneyBudgetUsd! <= 0 || moneyBudgetUsd! > 1_000_000)
      || tokenBudget === undefined && moneyBudgetUsd === undefined) {
      showBanner(tr('Hãy nhập ít nhất một ngân sách hợp lệ.'));
      return;
    }
    approvedBudget = {
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      ...(moneyBudgetUsd !== undefined ? { moneyBudgetUsd } : {}),
    };
  }
  try {
    await fetchJson(`/platform/v1/runs/${encodeURIComponent(run.id)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: run.version, ...(approvedBudget ? { approvedBudget } : {}) }) });
    await refresh(false);
  } catch (error) { showBanner(error instanceof Error ? error.message : tr('Không thể tiếp tục run.')); }
}

function connectEvents(): void {
  if (eventReconnectTimer !== null) {
    window.clearTimeout(eventReconnectTimer);
    eventReconnectTimer = null;
  }
  connection?.close();
  const source = new EventSource(`/platform/v1/events?since=${durableEvents.cursor}`);
  connection = source;
  source.addEventListener('open', () => {
    if (connection !== source) return;
    eventReconnectAttempt = 0;
    updateConnection(true);
    refreshInBackground();
  });
  source.addEventListener('error', () => {
    if (connection !== source) return;
    updateConnection(false);
    if (source.readyState === EventSource.CLOSED) scheduleEventReconnect();
  });
  source.addEventListener('snapshot.required', refreshInBackground);
  source.addEventListener('office.event', (event) => {
    let parsedResult: ReturnType<typeof eventEnvelopeSchema.safeParse>;
    try { parsedResult = eventEnvelopeSchema.safeParse(JSON.parse((event as MessageEvent).data)); }
    catch { refreshInBackground(); return; }
    if (!parsedResult.success) { refreshInBackground(); return; }
    const parsed = parsedResult.data;
    const observation = durableEvents.observe(parsed);
    if (!observation.accepted) return;
    recordVisualEvent(parsed);
    if (observation.gap) { refreshInBackground(); return; }
    if (parsed.type === 'project.created' || parsed.type === 'project.archived' || parsed.type === 'project.restored' || parsed.type === 'registry.updated' || parsed.type.startsWith('agent.') || parsed.type.startsWith('assignment.') || parsed.type.startsWith('task.') || parsed.type.startsWith('run.') || parsed.type.startsWith('message.') || parsed.type.startsWith('artifact.') || parsed.type.startsWith('approval.') || parsed.type.startsWith('memory.')) refreshInBackground();
  });
  source.addEventListener('office.activity', (event) => {
    if (!snapshot) return;
    let payload: unknown;
    try { payload = JSON.parse((event as MessageEvent).data); }
    catch { return; }
    const visual = toOfficeToolVisualEvent(payload, {
      agents: snapshot.agents,
      projects: snapshot.projects,
      tasks: projectDetail?.tasks ?? [],
    });
    if (!visual?.agentId || !visual.taskId || !visual.projectId) return;
    const activity = toActivity(visual);
    transientActivities.set(visual.agentId, { projectId: visual.projectId, taskId: visual.taskId, activity });
    visualFeed.push(visual);
    if (visualFeed.length > 80) visualFeed.splice(0, visualFeed.length - 80);
    renderActivityFeed();
    renderProjects(visibleProjects);
    renderAgents(snapshot.agents);
    updateCanvasSnapshot();
  });
  source.addEventListener('message.delta', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as { runId: string; delta: string };
    streamRunId = data.runId;
    streamText += data.delta;
    const messages = root.querySelector<HTMLElement>('#messages');
    if (messages) { messages.innerHTML = renderMessages(projectDetail?.messages ?? []); messages.scrollTop = messages.scrollHeight; }
  });
  source.addEventListener('task.delta', refreshInBackground);
}

function handleOnline(): void {
  browserOnline = true;
  eventReconnectAttempt = 0;
  if (eventReconnectTimer !== null) {
    window.clearTimeout(eventReconnectTimer);
    eventReconnectTimer = null;
  }
  if (connection && connection.readyState === EventSource.OPEN) {
    updateConnection(true);
    return;
  }
  connectEvents();
}

function handleOffline(): void {
  browserOnline = false;
  updateConnection(false);
  if (eventReconnectTimer !== null) {
    window.clearTimeout(eventReconnectTimer);
    eventReconnectTimer = null;
  }
  connection?.close();
  connection = null;
}

function scheduleEventReconnect(): void {
  if (eventReconnectTimer !== null) return;
  const delayMs = Math.min(30_000, 2_000 * 2 ** Math.min(eventReconnectAttempt, 4));
  eventReconnectAttempt++;
  eventReconnectTimer = window.setTimeout(() => {
    eventReconnectTimer = null;
    connectEvents();
  }, delayMs);
}

async function selectProject(projectId: string): Promise<void> {
  selectedProjectId = projectId;
  if (window.innerWidth <= 900) setProjectPanelOpen(true);
  streamText = '';
  streamRunId = '';
  await loadProject(projectId, true);
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (csrfToken && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | T | null;
  if (!response.ok) {
    const apiError = (body as { error?: { code?: string; message?: string } } | null)?.error;
    const message = apiError?.code === 'SERVER_SHUTTING_DOWN'
      ? tr('O Agent Office está encerrando. Aguarde um momento e tente novamente.')
      : tr(apiError?.message ?? `HTTP ${response.status}`);
    throw new Error(message);
  }
  return body as T;
}

function updateConnection(connected: boolean): void {
  const status = root.querySelector<HTMLElement>('#connection-status');
  if (!status) return;
  connected = connected && browserOnline;
  status.classList.toggle('is-offline', !connected);
  status.innerHTML = `<i></i>${connected ? tr('Conectado') : tr('Conectando ao escritório…')}`;
}

function refreshInBackground(): void {
  void refresh(false).catch(() => updateConnection(false));
}

function showBanner(message: string, kind: 'error' | 'success' | 'info' = 'error'): void {
  const banner = root.querySelector<HTMLElement>('#banner');
  if (!banner) return;
  banner.textContent = tr(message);
  banner.classList.toggle('banner--success', kind === 'success');
  banner.classList.toggle('banner--info', kind === 'info');
  banner.hidden = false;
  if (bannerTimer !== null) window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => { banner.hidden = true; bannerTimer = null; }, 7000);
}

function renderEmpty(): void {
  const content = root.querySelector<HTMLElement>('#project-content');
  if (!content) return;
  content.innerHTML = `<div class="empty-state"><div class="empty-icon">⌂</div><h2>${tr('Selecione ou crie um projeto para começar.')}</h2><p>${tr('Use Developer, Researcher, Analyst ou Writer para começar.')}</p><button class="button primary" id="empty-new-project">${tr('Criar projeto')}</button></div>`;
  content.querySelector<HTMLButtonElement>('#empty-new-project')!.onclick = () => root.querySelector<HTMLDialogElement>('#new-project-dialog')!.showModal();
  projectDetail = null;
}

function agentName(id: string | null): string {
  return snapshot?.agents.find((agent) => agent.id === id)?.displayName ?? 'Agent';
}
function esc(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
function formatSize(bytes: number): string { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function renderPendingAttachments(): void {
  const target = root.querySelector<HTMLElement>('#pending-attachments');
  if (!target) return;
  target.innerHTML = attachmentDraft.files.map((file, index) => `<span class="pending-attachment">📎 ${esc(file.name)} <small>${formatSize(file.size)}</small><button type="button" data-remove-attachment="${index}" aria-label="${tr('Xóa tệp')}">×</button></span>`).join('');
  target.querySelectorAll<HTMLButtonElement>('[data-remove-attachment]').forEach((button) => {
    button.disabled = busy;
    button.onclick = () => { if (busy) return; attachmentDraft.remove(Number(button.dataset.removeAttachment)); renderPendingAttachments(); };
  });
  const picker = root.querySelector<HTMLButtonElement>('#pick-attachments');
  if (picker) picker.disabled = busy;
}

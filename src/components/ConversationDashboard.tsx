import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Archive, ArchiveRestore, ArrowLeft, CalendarDays, FolderClosed, Gauge, MessageSquare, Pencil, Plus, RefreshCw, Search } from "lucide-react";
import type { Note, NoteContentUpdate } from "../types/note";
import type { Category } from "../types/category";
import { codeChangeEvidencePrefix, conversationProjectIds, conversationTasks, dateInRange, datePeriodOptions, dateRangeForPeriod, isOverdue,
  emptyDateRange, type ChatTask, type ChatTaskSource, type CodexProject, type DatePeriod, type ProjectCatalog, type ProjectSettings } from "../services/chatInsightsService";
import { localDateKey, schedulePartsFromIso } from "../services/noteDateService";
import { ConversationProjects } from "./ConversationProjects";
import { ProjectUsageDashboard } from "./ProjectUsageDashboard";
import { CodexThreadPicker, ConversationTaskDispatch, conversationDispatchMessage, sendConversationTask } from "./ConversationTaskDispatch";
import { NoteCard } from "./NoteCard";
import { CalendarDatePicker } from "./CalendarDatePicker";
import { SelectField } from "./SelectField";
import "./ConversationDashboard.css";

interface Props {
  notes: Note[];
  categories: Category[];
  sidebarCollapsed?: boolean;
  showCodexQuota?: boolean;
  appAlert?: ReactNode;
  onNotesChanged: () => Promise<void>;
  onEdit: (id: number, input: NoteContentUpdate) => Promise<boolean>;
  saveDraftBeforeClose?: MutableRefObject<(() => Promise<boolean>) | null>;
}
interface SyncStatus { enabled: boolean; pending: number; failed: number; lastError?: string | null; }
const emptyCatalog: ProjectCatalog = { projects: [], sessionProjects: {} };
const usageNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const compactUsageNumber = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const quotaWindowLabel = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440} 天`
  : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
const dateLabel = (value: string | null) => {
  if (!value || Number.isNaN(new Date(value).getTime())) return "时间未知";
  return new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const timelineDateLabel = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
function timelineTimestamp({ note, sources }: ChatTask) {
  return [note.completedAt, sources[0].syncedAt, note.createdAt]
    .find((value) => value && Number.isFinite(Date.parse(value))) ?? null;
}
function groupTimeline(items: ChatTask[]) {
  const now = new Date();
  const today = localDateKey(now);
  now.setDate(now.getDate() - 1);
  const yesterday = localDateKey(now);
  const groups = new Map<string, { label: string; items: ChatTask[] }>();
  const dated = items.map((item) => {
    const timestamp = timelineTimestamp(item);
    return { item, date: timestamp ? new Date(timestamp) : null };
  }).sort((a, b) => (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity));
  for (const { item, date } of dated) {
    const day = date ? localDateKey(date) : "";
    const existing = groups.get(day);
    if (existing) existing.items.push(item);
    else groups.set(day, {
      label: day === today ? "今天" : day === yesterday ? "昨天" : !date ? "日期未知"
        : day.startsWith(today.slice(0, 4)) ? timelineDateLabel.format(date) : day,
      items: [item]
    });
  }
  return groups;
}

interface TaskActivity { skills: string[]; agents: string[]; }

function CodexTaskActivity({ noteId }: { noteId: number }) {
  const [activity, setActivity] = useState<"loading" | "error" | TaskActivity>("loading");
  useEffect(() => {
    let active = true;
    invoke<TaskActivity>("get_chat_task_activity", { noteId }).then(
      (result) => { if (active) setActivity(result); },
      () => { if (active) setActivity("error"); }
    );
    return () => { active = false; };
  }, [noteId]);

  const rows = typeof activity === "object" ? [
    { label: "技能", names: activity.skills },
    { label: "子智能体", names: activity.agents }
  ] : [];
  return <section className="ci-editor-activity" aria-label="调用记录">
    <h3>调用记录</h3>
    {activity === "loading" ? <p role="status">正在读取调用记录…</p>
      : activity === "error" ? <p role="status">无法读取调用记录</p>
      : rows.some(({ names }) => names.length) ? <dl>
        {rows.map(({ label, names }) => <div key={label}>
          <dt>{label}</dt>
          <dd>{names.length ? names.map((name) => <code key={name}>{name}</code>) : "暂无记录"}</dd>
        </div>)}
      </dl> : <p>暂无技能或子智能体调用记录</p>}
  </section>;
}

export function ConversationDashboard({ notes, categories, sidebarCollapsed = false, showCodexQuota = true,
  appAlert, onNotesChanged, onEdit, saveDraftBeforeClose }: Props) {
  const [sources, setSources] = useState<ChatTaskSource[] | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [projectError, setProjectError] = useState("");
  const catalogRevision = useRef(0);
  const sourceRevision = useRef(0);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [reading, setReading] = useState(false);
  const [search, setSearch] = useState("");
  const [project, setProject] = useState("all");
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const usageButton = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<{ content: string; projectId: string } | null>(null);
  const [choosingDraftThread, setChoosingDraftThread] = useState(false);
  const [adding, setAdding] = useState<"save" | "send" | null>(null);
  const addInFlight = useRef(false);
  const outsideSaveInFlight = useRef<Promise<boolean> | null>(null);
  const [addError, setAddError] = useState("");
  const [addFeedback, setAddFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [period, setPeriod] = useState<DatePeriod>("all");
  const [customDates, setCustomDates] = useState(emptyDateRange);
  const [editingId, setEditingId] = useState<number | null>(null);
  const dashboardRef = useRef<HTMLElement>(null);
  const archiveToggle = useRef<HTMLButtonElement>(null);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const addForm = useRef<HTMLFormElement>(null);
  const draftThreadTrigger = useRef<HTMLButtonElement>(null);
  const returnToAddTrigger = useRef(false);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const editing = notes.find(({ id }) => id === editingId);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  useEffect(() => {
    if (editing) return;
    editTrigger.current?.focus({ preventScroll: true });
    editTrigger.current = null;
  }, [editing]);
  useEffect(() => {
    if (draft || !returnToAddTrigger.current) return;
    returnToAddTrigger.current = false;
    addTrigger.current?.focus({ preventScroll: true });
  }, [draft]);
  const openEditor = (noteId: number, trigger: HTMLButtonElement) => {
    editTrigger.current = trigger;
    setEditingId(noteId);
  };
  useEffect(() => {
    let active = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      const readingRevision = catalogRevision.current;
      const readingSourceRevision = sourceRevision.current;
      setReading(true);
      try {
        const [tasks, status, projects] = await Promise.allSettled([
          invoke<ChatTaskSource[]>("get_chat_sync_tasks"), invoke<SyncStatus>("get_chat_sync_status"),
          invoke<ProjectCatalog>("get_chat_sync_projects")
        ]);
        if (!active) return;
        if (readingRevision === catalogRevision.current) {
          if (projects.status === "fulfilled") { setCatalog(projects.value); setProjectError(""); }
          else setProjectError(String(projects.reason));
        }
        if (tasks.status === "fulfilled" && readingSourceRevision === sourceRevision.current) setSources(tasks.value);
        if (status.status === "fulfilled") setSync(status.value);
        setError(tasks.status === "rejected" ? String(tasks.reason) : status.status === "rejected" ? String(status.reason) : "");
      }
      finally { pending = false; if (active) setReading(false); }
    };
    void read();
    const timer = window.setInterval(() => void read(), 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh, notes]);

  const tasks = useMemo(() => conversationTasks(notes, sources ?? []), [notes, sources]);
  const projectIds = useMemo(() => conversationProjectIds(tasks, categories, catalog ?? emptyCatalog), [tasks, categories, catalog]);
  const registered = [...(catalog?.projects ?? [])].sort((a, b) => Number(b.settings.tracked) - Number(a.settings.tracked));
  const registeredById = new Map(registered.map((item) => [item.id, item]));
  const projectsByLabel = new Map<string, typeof registered>();
  for (const item of registered) {
    const label = item.settings.displayName ?? item.name;
    const group = projectsByLabel.get(label) ?? [];
    group.push(item);
    projectsByLabel.set(label, group);
  }
  const projectDescriptions = new Map<string, string>();
  for (const group of projectsByLabel.values()) {
    if (group.length === 1) continue;
    for (const { id, rootPaths } of group) {
      const path = rootPaths[0];
      const sharesPath = group.some((item) => item.id !== id && item.rootPaths[0] === path);
      const suffix = `#${id.slice(-6)}`;
      projectDescriptions.set(id, path ? sharesPath ? `${path} · ${suffix}` : path : suffix);
    }
  }
  const legacy = [...new Set(projectIds.values())].filter((id) => id.startsWith("category:"));
  const visibleProjectIds = registered.filter(({ hidden, settings }) => !hidden && (!trackedOnly || settings.tracked)).map(({ id }) => id);
  const options = trackedOnly ? visibleProjectIds : [...visibleProjectIds, ...legacy];
  const railCoversProjectFilter = !sidebarCollapsed && visibleProjectIds.length > 0 && (trackedOnly || legacy.length === 0);
  const activeProject = options.includes(project) ? project : "all";
  const categoryFor = (id: string) => categories.find((category) => `category:${category.id}` === id);
  const projectName = (id: string) => {
    const item = registeredById.get(id);
    return item ? item.settings.displayName ?? item.name : categoryFor(id)?.name ?? "未分类";
  };
  const projectOption = (id: string) => {
    const label = projectName(id);
    return projectDescriptions.has(id) ? `${label} · #${id.slice(-6)}` : label;
  };
  const activeProjectPath = projectDescriptions.get(activeProject) ?? registeredById.get(activeProject)?.rootPaths.join("\n");
  const dateRange = dateRangeForPeriod(period, customDates);
  const invalidDates = Boolean(dateRange.start && dateRange.end && dateRange.start > dateRange.end);
  const periodTasks = tasks.filter((task) => {
    const timestamp = timelineTimestamp(task);
    return dateInRange(timestamp ? localDateKey(new Date(timestamp)) : null, dateRange);
  });
  const archivedCount = tasks.filter(({ sources }) => sources[0].archived).length;
  const boardTasks = periodTasks.filter(({ sources }) => sources[0].archived === showArchived);
  const counts = new Map<string, number>();
  for (const { note } of boardTasks) {
    const id = projectIds.get(note.id)!;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const searchTerm = search.trim().toLocaleLowerCase();
  const scopedTasks = periodTasks.filter(({ note }) => {
    const id = projectIds.get(note.id)!;
    const registeredProject = registeredById.get(id);
    return !registeredProject?.hidden && (!trackedOnly || registeredProject?.settings.tracked)
      && (activeProject === "all" || id === activeProject)
      && `${note.title} ${note.details ?? ""}`.toLocaleLowerCase().includes(searchTerm);
  });
  const filtered = scopedTasks.filter(({ sources }) => sources[0].archived === showArchived);
  const timeline = groupTimeline(filtered);
  const overdue = filtered.filter(({ note }) => isOverdue(note)).length;
  const hasFilters = activeProject !== "all" || trackedOnly || period !== "all" || Boolean(searchTerm);
  const noMatchingTasks = filtered.length === 0 && hasFilters && (!showArchived || archivedCount > 0);
  const emptyProject = activeProject !== "all" && !tasks.some(({ note }) => projectIds.get(note.id) === activeProject);
  const editorSources = tasks.find(({ note }) => note.id === editingId)?.sources.filter(({ evidence }) => evidence) ?? [];
  const closeDraft = useCallback((restoreFocus = true) => {
    returnToAddTrigger.current = restoreFocus;
    setChoosingDraftThread(false);
    setDraft(null);
  }, []);
  const addTask = useCallback(async ({ threadId, outsideClick = false }: { threadId?: string | null; outsideClick?: boolean } = {}) => {
    if (addInFlight.current || !draft) return false;
    const prompt = draft.content.trim();
    if (!prompt) return false;
    const projectId = draft.projectId || null;
    addInFlight.current = true;
    setAdding(threadId === undefined ? "save" : "send");
    setAddError("");
    setAddFeedback(null);
    try {
      const task = await invoke<ChatTaskSource>("create_chat_board_task", { title: prompt, details: "", projectId });
      sourceRevision.current++;
      setSources((current) => [...(current ?? []).filter((source) => source.noteId !== task.noteId), task]);
      let feedback: typeof addFeedback = null;
      if (threadId !== undefined) {
        try {
          const result = await sendConversationTask(task.noteId, threadId, projectId);
          const message = conversationDispatchMessage(result);
          if (message) feedback = { message, error: false };
        } catch (error) {
          feedback = { message: `事项已添加，可在卡片上重试发送。\n${String(error)}`, error: true };
        }
      }
      try {
        await onNotesChanged();
      } catch {
        feedback = { message: [feedback?.message, "事项已添加，刷新列表失败。"].filter(Boolean).join("\n"), error: true };
      }
      setAddFeedback(feedback);
      closeDraft(!outsideClick);
      if (!outsideClick) {
        setShowArchived(false); setSearch(""); setPeriod("all");
        setProject(projectId ?? "all"); setTrackedOnly(false);
      }
      return true;
    } catch (error) {
      setAddError(outsideClick ? `自动保存失败，内容已保留。\n${String(error)}` : String(error));
      return false;
    }
    finally { addInFlight.current = false; setAdding(null); }
  }, [closeDraft, draft, onNotesChanged]);
  const saveDraft = useCallback(() => {
    if (outsideSaveInFlight.current) return outsideSaveInFlight.current;
    if (addInFlight.current) return Promise.resolve(false);
    if (!draft?.content.trim()) return Promise.resolve(true);
    const save = addTask({ outsideClick: true }).finally(() => { outsideSaveInFlight.current = null; });
    outsideSaveInFlight.current = save;
    return save;
  }, [addTask, draft]);
  useEffect(() => {
    if (!saveDraftBeforeClose) return;
    saveDraftBeforeClose.current = saveDraft;
    return () => { saveDraftBeforeClose.current = null; };
  }, [saveDraft, saveDraftBeforeClose]);
  useEffect(() => {
    if (!draft || choosingDraftThread || showArchived) return;
    const shell = dashboardRef.current?.closest(".app-shell") ?? dashboardRef.current;
    const handleOutsideClick = (event: MouseEvent) => {
      const form = addForm.current;
      const target = event.target;
      if (!form || addInFlight.current || event.button !== 0 || !(target instanceof Node)
        || !shell?.contains(target) || form.contains(target)
        || (target instanceof Element && target.closest("[data-window-close-control]"))) return;
      if (!draft.content.trim()) {
        closeDraft(false);
        return;
      }
      void saveDraft();
    };
    document.addEventListener("click", handleOutsideClick, true);
    return () => document.removeEventListener("click", handleOutsideClick, true);
  }, [choosingDraftThread, closeDraft, draft, saveDraft, showArchived]);
  const setArchived = async (noteId: number, archived: boolean, trigger: HTMLButtonElement) => {
    if (archiving) return;
    const returnFocus = document.activeElement === trigger;
    setArchiving(true);
    setArchiveError("");
    try {
      await invoke("set_chat_sync_task_archived", { noteId, archived });
      sourceRevision.current++;
      setSources((current) => current?.map((source) => source.noteId === noteId ? { ...source, archived } : source) ?? null);
      if (returnFocus && (document.activeElement === trigger || document.activeElement === document.body)) {
        archiveToggle.current?.focus({ preventScroll: true });
      }
    } catch (error) { setArchiveError(String(error)); }
    finally { setArchiving(false); }
  };
  const updateProject = (projectId: string, patch: Partial<Pick<CodexProject, "settings" | "hidden">>) => {
    catalogRevision.current++;
    setCatalog((current) => current && {
      ...current, projects: current.projects.map((item) => item.id === projectId ? { ...item, ...patch } : item)
    });
  };
  const saveProject = async (projectId: string, settings: ProjectSettings) => {
    const saved = await invoke<ProjectSettings>("save_chat_sync_project", {
      projectId, displayName: settings.displayName ?? "", tracked: settings.tracked
    });
    updateProject(projectId, { settings: saved });
    if (trackedOnly && !saved.tracked) setProject((current) => current === projectId ? "all" : current);
  };
  const setProjectHidden = async (projectId: string, hidden: boolean) => {
    await invoke("set_chat_sync_project_hidden", { projectId, hidden });
    updateProject(projectId, { hidden });
    if (hidden) setProject((current) => current === projectId ? "all" : current);
    setRefresh((value) => value + 1);
  };

  function renderTask({ note, sources: evidence }: ChatTask) {
    const timestamp = timelineTimestamp({ note, sources: evidence });
    const { date, time } = schedulePartsFromIso(timestamp);
    const canSend = !showArchived && !note.completed && note.status === "todo";
    const latestEvidence = evidence.find((source) => source.evidence);
    const excerpt = latestEvidence?.evidence;
    const isCodeChange = excerpt?.startsWith(codeChangeEvidencePrefix);
    const summary = isCodeChange ? null
      : latestEvidence?.conversation && excerpt === note.title ? note.details : excerpt || note.details;
    const projectId = projectIds.get(note.id)!;
    const taskProject = evidence.find((source) => source.manual && source.projectId)?.projectId
      ?? (registeredById.has(projectId) ? projectId : null);
    const dispatch = evidence.find(({ dispatchThreadId }) => dispatchThreadId);
    const usage = evidence.find(({ manual, codexUsage }) => manual && codexUsage)?.codexUsage ?? latestEvidence?.codexUsage;
    const preferredThreadId = dispatch?.dispatchThreadId ?? evidence.find((source) => source.manual && source.sessionId)?.sessionId ?? evidence.find(({ sessionId }) => sessionId)?.sessionId ?? "";
    return <article className="ci-task" key={note.id}
      onClick={(event) => {
        const { target, currentTarget } = event;
        if (!(target instanceof Element) || !currentTarget.contains(target) || target.closest("button, a, .ci-task-dispatch")) return;
        const trigger = currentTarget.querySelector<HTMLButtonElement>(".ci-task-open");
        if (trigger) openEditor(note.id, trigger);
      }}>
      <div className="ci-task-meta">
        <span className="ci-task-project" title={projectName(projectId)}>{projectName(projectId)}</span>
        {latestEvidence?.conversation && <span className="ci-task-kind"><MessageSquare size={12} aria-hidden="true" />对话记录</span>}
        {isCodeChange && <span className="ci-task-kind">代码改动</span>}
      </div>
      <button type="button" className="ci-task-open" aria-label={`编辑：${note.title}`} aria-haspopup="dialog"
        onClick={(event) => openEditor(note.id, event.currentTarget)}>
        <strong>{note.title}</strong>{summary && <span className="ci-task-evidence">{summary}</span>}
      </button>
      {usage && (usage.totalTokens != null || (showCodexQuota && usage.quotaChanges.length > 0)) && <div className="ci-task-usage">
        {usage.totalTokens != null && <div className="ci-task-token-usage"
          title={`本轮 Codex 用量 ${usageNumber.format(usage.totalTokens)} Token`}>
          <span>Codex 用量</span>
          <strong>{compactUsageNumber.format(usage.totalTokens)} Token</strong>
        </div>}
        {showCodexQuota && usage.quotaChanges.length > 0 && <div className="ci-task-quota">
          {usage.quotaChanges.map(({ windowMinutes, percentagePoints }, index) => {
            const windowLabel = quotaWindowLabel(windowMinutes);
            const points = usageNumber.format(percentagePoints);
            return <div className="ci-task-quota-meter" key={`${windowMinutes}-${index}`} role="meter"
              aria-label={`${windowLabel}剩余额度降幅`} aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={percentagePoints} aria-valuetext={`减少 ${points} 个百分点`}
              title={`${windowLabel}剩余额度减少 ${points} 个百分点。来自账户快照，可能包含同期其他对话。`}>
              <span className="ci-task-quota-label" aria-hidden="true"><span>{windowLabel}额度</span><strong>−{points} 点</strong></span>
              <span className="ci-task-quota-track" aria-hidden="true">
                <span style={{ width: `${percentagePoints}%` }} />
              </span>
            </div>;
          })}
        </div>}
      </div>}
      <ConversationTaskDispatch noteId={note.id} title={note.title} disabled={archiving} canSend={canSend}
        projectId={taskProject} projectLabel={taskProject && registeredById.has(taskProject) ? projectOption(taskProject) : undefined}
        preferredThreadId={preferredThreadId} onSent={onNotesChanged} dispatchState={dispatch?.dispatchState}
        completion={timestamp && date && time && <time className="ci-task-completed-at" dateTime={timestamp}
          title={`${note.completedAt ? "完成于" : "记录于"} ${date} ${time}`}>{time}</time>}
        cardActions={<>
          <button type="button" title={showArchived ? "恢复事项" : "归档事项"} disabled={archiving}
            aria-label={`${showArchived ? "恢复事项" : "归档事项"} ${note.title}`}
            onClick={(event) => void setArchived(note.id, !showArchived, event.currentTarget)}>
            {showArchived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
          </button>
          <button type="button" className="ci-task-edit" title="编辑事项" aria-label={`编辑事项 ${note.title}`} aria-haspopup="dialog"
            onClick={(event) => openEditor(note.id, event.currentTarget)}><Pencil size={14} aria-hidden="true" /></button>
        </>} />
    </article>;
  }

  if (showUsage && catalog) return <section className="ci-dashboard ci-analysis-view">
    <ProjectUsageDashboard
      projects={registered.filter(({ hidden, settings }) => !hidden && (!trackedOnly || settings.tracked))}
      tasks={tasks} projectIds={projectIds} initialProject={activeProject}
      onBack={() => { setShowUsage(false); requestAnimationFrame(() => usageButton.current?.focus()); }}
      onSelect={(id) => { setProject(id); setShowUsage(false); }} />
  </section>;

  return <section ref={dashboardRef} className="ci-dashboard" aria-label="对话分析看板">
    <div className={`ci-workspace ${!sidebarCollapsed && (catalog || projectError) ? "has-projects" : ""}`}>
      <aside id="ci-project-sidebar" className="ci-project-rail" aria-label="项目侧边栏"
        aria-hidden={sidebarCollapsed || undefined} {...(sidebarCollapsed ? { inert: "" } : {})}>
        <div className="ci-project-rail-scroll">
          <div className="ci-project-rail-content">
            {projectError && <p className="ci-error" role="alert">{projectError}
              <button type="button" onClick={() => setRefresh((value) => value + 1)}>重新读取项目</button></p>}
            {catalog && <ConversationProjects projects={registered} counts={counts} descriptions={projectDescriptions}
              selected={activeProject} trackedOnly={trackedOnly}
              onSelect={setProject} onTrackedOnly={(enabled) => { setTrackedOnly(enabled); setProject("all"); }}
              onSave={saveProject} onSetHidden={setProjectHidden} />}
            {catalog && <button ref={usageButton} className="ci-usage-entry" type="button"
              onClick={() => setShowUsage(true)}><Gauge size={16} aria-hidden="true" /><span>仪表盘</span><span aria-hidden="true">↗</span></button>}
          </div>
        </div>
      </aside>
      <section className="ci-actions" aria-label="行动看板">
        {appAlert}
        <header className="ci-header">
          <div className="ci-title">
            <span className="ci-title-icon"><CalendarDays size={22} aria-hidden="true" /></span>
            <div>
              <h1>{showArchived ? "归档记录" : "记录时间线"}</h1>
              <div className="ci-connection">
                <span className={`ci-signal ${sync?.enabled ? "connected" : ""}`} />
                <span>{sync ? sync.enabled ? "自动同步已开启" : "同步未连接" : "正在读取同步状态"}</span>
                {sync?.pending ? <span>{sync.pending} 轮待分析</span> : null}
                {sync?.failed ? <span className="ci-warning">{sync.failed} 轮分析失败</span> : null}
                {overdue > 0 && !showArchived && <span className="ci-warning">{overdue} 项已过期</span>}
              </div>
            </div>
          </div>
          {sources && !showArchived && <div className="ci-record-actions">
            <button ref={addTrigger} className="ci-add-task" type="button" aria-label="添加待处理事项"
              aria-expanded={Boolean(draft)} disabled={Boolean(draft)} onClick={() => {
                setAddError("");
                setDraft({ content: "", projectId: registeredById.has(activeProject) ? activeProject : "" });
              }}><Plus size={16} aria-hidden="true" />添加事项</button>
          </div>}
          <button className="ci-refresh" type="button" aria-label="刷新对话看板" title="刷新看板" disabled={reading}
            onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" /></button>
        </header>
        {error && <p className="ci-error" role="alert">读取失败：{error}<button type="button" onClick={() => setRefresh((value) => value + 1)}>重试</button></p>}
        {archiveError && <p className="ci-error" role="alert">{archiveError}</p>}
        {addFeedback && <p className={addFeedback.error ? "ci-error" : "ci-filter-empty"}
          role={addFeedback.error ? "alert" : "status"}>{addFeedback.message}</p>}
        {showArchived && draft && addError && <p className="ci-error" role="alert">{addError}</p>}
        {sources === null ? <div className="ci-empty" role="status"><MessageSquare size={30} /><h2>{error ? "暂时无法读取看板" : "正在整理对话事项…"}</h2><p>从本机同步记录读取来源与进度。</p></div> : <>
          <div className="ci-board-controls">
            <div className="ci-toolbar">
              <div className="ci-period-picker">
                <SelectField label="记录日期范围" variant="toolbar" value={period} options={datePeriodOptions}
                  leadingIcon={<CalendarDays size={14} />} onChange={setPeriod} />
              </div>
              <div className={`ci-project-picker${railCoversProjectFilter ? " ci-project-picker-redundant" : ""}`}>
                <SelectField label="项目筛选" variant="toolbar" value={activeProject} title={activeProjectPath || undefined}
                  leadingIcon={<FolderClosed size={14} />} onChange={setProject}
                  options={[{ value: "all", label: trackedOnly ? "追踪的项目" : "所有项目" },
                    ...options.map((id) => ({ value: id, label: projectOption(id) }))]} />
              </div>
              <label className="ci-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索对话事项" placeholder="搜索事项" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
              <button className="ci-archive-toggle" type="button" ref={archiveToggle} onClick={() => {
                setShowArchived(!showArchived); setArchiveError("");
              }}>{showArchived ? <ArrowLeft size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                {showArchived ? "返回看板" : `已归档 ${archivedCount}`}</button>
            </div>
            {period === "custom" && <div className="ci-date-range" role="group" aria-label="自定义记录日期">
              <div className="ci-date-field"><span aria-hidden="true">开始日期</span>
                <CalendarDatePicker variant="field" label="开始日期" placeholder="" invalid={invalidDates}
                  value={customDates.start} onChange={(start) => setCustomDates((current) => ({ ...current, start }))} />
              </div>
              <div className="ci-date-field"><span aria-hidden="true">结束日期</span>
                <CalendarDatePicker variant="field" label="结束日期" placeholder="" invalid={invalidDates}
                  value={customDates.end} onChange={(end) => setCustomDates((current) => ({ ...current, end }))} />
              </div>
              {invalidDates && <span className="ci-warning" role="alert">开始日期不能晚于结束日期</span>}
            </div>}
          </div>
          {noMatchingTasks && <div className="ci-filter-empty">
            <span role="status">{emptyProject ? "此项目暂无同步事项" : "没有匹配的事项"}</span>
            <button type="button" onClick={() => { setSearch(""); setProject("all"); setTrackedOnly(false); setPeriod("all"); setCustomDates(emptyDateRange); }}>清除筛选</button>
          </div>}
          {!showArchived && draft && <div className="ci-timeline-composer">
            {draft && <form ref={addForm} className="ci-create-task" data-popover-root aria-label="添加待处理事项" onSubmit={(event) => { event.preventDefault(); void addTask(); }}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || adding) return;
                event.preventDefault();
                closeDraft();
              }}>
              <input type="text" autoFocus required aria-label="Codex 提示词"
                value={draft.content} disabled={adding !== null} onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text/plain");
                  if (!/[\r\n]/.test(pasted)) return;
                  event.preventDefault();
                  const field = event.currentTarget;
                  field.setRangeText(pasted.replace(/[\t ]*[\r\n][\t \r\n]*/g, " "),
                    field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, "end");
                  setDraft({ ...draft, content: field.value });
                }} />
              {visibleProjectIds.length > 0 && <SelectField label="待处理事项项目" variant="form"
                value={draft.projectId} disabled={adding !== null}
                options={[{ value: "", label: "不指定项目" },
                  ...visibleProjectIds.map((id) => ({ value: id, label: projectOption(id) }))]}
                onChange={(projectId) => setDraft({ ...draft, projectId })} />}
              {!choosingDraftThread && addError && <p className="ci-error" role="alert">{addError}</p>}
              <div className="ci-create-task-dispatch ci-send-buttons" role="group" aria-label="添加并发送给 Codex">
                <button type="button" className="ci-send-new" disabled={adding !== null || !draft.content.trim()}
                  onClick={() => void addTask({ threadId: null })}>{adding === "send" && !choosingDraftThread ? "发送中…" : "开启新对话"}</button>
                <button type="button" ref={draftThreadTrigger} disabled={adding !== null || !draft.content.trim()}
                  onClick={() => { setAddError(""); setChoosingDraftThread(true); }}>沿用之前对话</button>
              </div>
              <div className="ci-create-task-actions">
                <button type="button" disabled={adding !== null} onClick={() => closeDraft()}>取消</button>
                <button type="submit" disabled={adding !== null || !draft.content.trim()}>{adding === "save" ? "保存中…" : "添加"}</button>
              </div>
            </form>}
          </div>}
          {draft && choosingDraftThread && createPortal(
            <CodexThreadPicker key={draft.projectId} projectId={draft.projectId || null}
              projectLabel={draft.projectId ? projectOption(draft.projectId) : undefined}
              preferredId="" sending={adding !== null} sendError={addError} onSend={(threadId) => void addTask({ threadId })}
              onClose={() => { setChoosingDraftThread(false); setAddError(""); draftThreadTrigger.current?.focus({ preventScroll: true }); }} />,
            dashboardRef.current?.closest(".app-shell") ?? document.body,
          )}
          <section className="ci-records" aria-label={showArchived ? "归档记录" : "时间线记录"}
            tabIndex={filtered.length ? 0 : undefined}>
            {[...timeline].map(([day, { label, items }]) => <section className="ci-timeline-day" key={day}>
              <h2>{day ? <time dateTime={day}>{label}</time> : label}</h2>
              <div className="ci-timeline-list">{items.map((task) => renderTask(task))}</div>
            </section>)}
            {filtered.length === 0 && !noMatchingTasks && <div className="ci-empty">
              <h2>{showArchived ? "暂无归档事项" : "暂无记录"}</h2>
            </div>}
          </section>
        </>}
      </section>
    </div>
    {editing && createPortal(
      <div className="dialog-backdrop board-detail-backdrop">
        <div className="board-detail-dialog ci-editor-dialog" role="dialog" aria-modal="true" aria-label="编辑事项"
          onKeyDown={(event) => {
            if (event.key !== "Tab" || event.defaultPrevented) return;
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
              "button, input, textarea, select, summary, [contenteditable='true']"
            )].filter((control) => control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length > 0);
            const first = controls[0];
            const last = controls[controls.length - 1];
            const edge = event.shiftKey ? first : last;
            if (edge === document.activeElement) {
              event.preventDefault();
              (event.shiftKey ? last : first)?.focus();
            }
          }}>
          <div className="board-detail-heading"><strong>编辑事项</strong></div>
          <NoteCard key={editing.id} note={editing} categories={categories} contentOnly
            onEdit={(input) => onEdit(editing.id, input)} onCloseEditor={() => setEditingId(null)}
            editorSupplement={<>
              <CodexTaskActivity noteId={editing.id} />
              {editorSources.length > 0 && <details className="ci-editor-sources">
                <summary>事项依据</summary>
                {editorSources.map((source) => <div className="ci-source" key={source.sessionId}>
                  <blockquote>{source.evidence}</blockquote>
                  <time dateTime={source.syncedAt ?? undefined}>{dateLabel(source.syncedAt)}</time>
                  <details><summary>来源对话</summary><code>{source.sessionId}</code></details>
                </div>)}
              </details>}
            </>} />
        </div>
      </div>, dashboardRef.current?.closest(".app-shell") ?? document.body
    )}
  </section>;
}

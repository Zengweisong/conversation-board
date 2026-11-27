import type { Note } from "../types/note";
import type { Category } from "../types/category";
import { localDateKey, noteDateKey } from "./noteDateService";

export const codeChangeEvidencePrefix = "Codex 已修改：";

interface CodexTurnUsage {
  totalTokens: number | null;
  quotaChanges: { windowMinutes: number; percentagePoints: number }[];
}

export interface CodexSessionUsage {
  sessionId: string;
  projectId: string | null;
  days: { date: string | null; totalTokens: number | null; turns: number }[];
}

export interface ChatTaskSource {
  noteId: number;
  sessionId: string;
  evidence: string;
  syncedAt: string | null;
  archived: boolean;
  manual?: boolean;
  conversation?: boolean;
  projectId?: string | null;
  dispatchThreadId?: string | null;
  dispatchState?: "running" | "completed" | "failed" | null;
  codexUsage?: CodexTurnUsage;
}
export interface ChatTask { note: Note; sources: ChatTaskSource[]; }
export interface ProjectSettings { displayName: string | null; tracked: boolean; }
export interface CodexProject {
  id: string;
  name: string;
  rootPaths: string[];
  settings: ProjectSettings;
  hidden: boolean;
}
export interface ProjectCatalog { projects: CodexProject[]; sessionProjects: Record<string, string>; }

export function conversationProjectIds(tasks: readonly ChatTask[], categories: readonly Category[], catalog: ProjectCatalog) {
  const idsByName = new Map<string, Set<string>>();
  for (const project of catalog.projects) {
    const names = [project.name, ...project.rootPaths.map((path) => path.split(/[\\/]/).filter(Boolean).pop() ?? "")];
    for (const name of names) {
      const key = name.toLowerCase();
      const ids = idsByName.get(key) ?? new Set<string>();
      ids.add(project.id);
      idsByName.set(key, ids);
    }
  }
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const sessionProjects = new Map(Object.entries(catalog.sessionProjects));
  return new Map(tasks.map(({ note, sources }) => {
    const manual = sources.find((source) => source.manual);
    const assigned = manual?.projectId && catalog.projects.some(({ id }) => id === manual.projectId)
      ? manual.projectId
      : sources.map(({ sessionId }) => sessionProjects.get(sessionId)).find(Boolean);
    const category = note.categoryId == null ? undefined : categoriesById.get(note.categoryId);
    const candidates = category && !category.isSystem ? idsByName.get(category.name.toLowerCase()) : undefined;
    const legacyMatch = candidates?.size === 1 ? [...candidates][0] : undefined;
    return [note.id, assigned ?? legacyMatch ?? `category:${note.categoryId ?? "none"}`];
  }));
}

/** Links, rather than categories or AI-looking titles, identify conversation tasks. */
export function conversationTasks(notes: readonly Note[], sources: readonly ChatTaskSource[]): ChatTask[] {
  const byNote = new Map<number, ChatTaskSource[]>();
  for (const source of sources) {
    const list = byNote.get(source.noteId) ?? [];
    list.push(source);
    byNote.set(source.noteId, list);
  }
  return notes.flatMap((note) => {
    const linked = byNote.get(note.id);
    return linked ? [{ note, sources: linked.sort((a, b) => (b.syncedAt ?? "").localeCompare(a.syncedAt ?? "")) }] : [];
  }).sort((a, b) => (b.sources[0].syncedAt ?? "").localeCompare(a.sources[0].syncedAt ?? ""));
}

export function isOverdue(note: Note, now = new Date()) {
  const date = noteDateKey(note);
  return !note.completed && date !== null && date < localDateKey(now);
}

export function conversationStats(tasks: readonly ChatTask[], now = new Date()) {
  const completed = tasks.filter(({ note }) => note.completed).length;
  return {
    total: tasks.length,
    completed,
    doing: tasks.filter(({ note }) => !note.completed && note.status === "doing").length,
    overdue: tasks.filter(({ note }) => isOverdue(note, now)).length,
    sessions: new Set(tasks.flatMap((task) => task.sources.map((source) => source.sessionId)).filter(Boolean)).size,
    completionRate: tasks.length ? Math.round(completed / tasks.length * 100) : 0
  };
}

export interface SyncDateRange { start: string; end: string; }

const recentPeriods = { today: 1, week: 7, month: 30 } as const;
export type DatePeriod = "all" | "custom" | keyof typeof recentPeriods;
export const datePeriodOptions: readonly { value: DatePeriod; label: string }[] = [
  { value: "all", label: "全部日期" },
  { value: "today", label: "今天" },
  { value: "week", label: "近 7 天" },
  { value: "month", label: "近 30 天" },
  { value: "custom", label: "自定义日期" }
];
export const emptyDateRange: SyncDateRange = { start: "", end: "" };

export function recentSyncDateRange(days: number, now = new Date()): SyncDateRange {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  return { start: localDateKey(start), end: localDateKey(now) };
}

export function dateRangeForPeriod(period: DatePeriod, customDates: SyncDateRange): SyncDateRange {
  return period === "all" ? emptyDateRange : period === "custom" ? customDates : recentSyncDateRange(recentPeriods[period]);
}

export function dateInRange(day: string | null, { start, end }: SyncDateRange) {
  return (!start && !end) || (day !== null && (!start || day >= start) && (!end || day <= end));
}

export function syncedInDateRange(task: ChatTask, range: SyncDateRange) {
  if (!range.start && !range.end) return true;
  return task.sources.some(({ syncedAt }) => {
    if (!syncedAt) return false;
    const date = new Date(syncedAt);
    return !Number.isNaN(date.getTime()) && dateInRange(localDateKey(date), range);
  });
}

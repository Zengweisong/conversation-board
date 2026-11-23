import type { Note } from "../src/types/note";
import type { ChatTaskSource } from "../src/services/chatInsightsService";

export function insightNote(id: number, patch: Partial<Note> = {}): Note {
  return {
    id, title: `事项 ${id}`, details: null, categoryId: 1, completed: false, pinned: false,
    priority: "normal", createdAt: "2026-11-17T03:00:00Z", updatedAt: "2026-11-17T03:00:00Z",
    completedAt: null, dueAt: null, sortOrder: id, scheduledAt: null, scheduledDate: null, scheduledTime: null,
    repeatSeriesId: null, repeatOccurrenceAt: null, reminderEnabled: false, reminderAt: null,
    reminderOffsetMinutes: 0, reminderTriggeredAt: null, boardColumnId: "todo", boardOrder: id,
    status: "todo", previousBoardColumnId: null, ...patch
  };
}
export const insightSources: ChatTaskSource[] = [
  { noteId: 1, sessionId: "session-a", evidence: "明天整理接口文档", syncedAt: "2026-11-17T03:00:00Z", archived: false },
  { noteId: 1, sessionId: "session-b", evidence: "接口文档要写清楚错误码", syncedAt: "2026-11-17T04:00:00Z", archived: false },
  { noteId: 2, sessionId: "session-a", evidence: "正在做登录功能", syncedAt: "2026-11-16T03:00:00Z", archived: false },
  { noteId: 3, sessionId: "session-c", evidence: "已经完成看板设计", syncedAt: "2026-11-01T03:00:00Z", archived: false },
  { noteId: 99, sessionId: "deleted", evidence: "已删除事项", syncedAt: "2026-11-17T03:00:00Z", archived: false }
];

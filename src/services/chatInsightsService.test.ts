import { expect, it } from "vitest";
import { insightNote, insightSources } from "../../tests/chatInsightsFixtures";
import { conversationStats, conversationTasks, recentSyncDateRange, syncedInDateRange } from "./chatInsightsService";

it("excludes manual and deleted tasks, deduplicates linked tasks, and retains their conversations", () => {
  const tasks = conversationTasks([insightNote(1), insightNote(2, { status: "doing", scheduledDate: "2026-11-16" }),
    insightNote(3, { completed: true, status: "completed" }), insightNote(4)], insightSources);
  expect(tasks.map(({ note }) => note.id)).toEqual([1, 2, 3]);
  expect(tasks[0].sources).toHaveLength(2);
  expect(tasks[0].sources[0].sessionId).toBe("session-b");
  expect(conversationStats(tasks, new Date(2026, 10, 17))).toEqual({
    total: 3, completed: 1, doing: 1, overdue: 1, sessions: 3, completionRate: 33
  });
});
it("uses the local seven-calendar-day range and rejects missing or future sync dates", () => {
  const now = new Date(2026, 10, 17, 12);
  const range = recentSyncDateRange(7, now);
  const tasks = conversationTasks([insightNote(1), insightNote(3)], insightSources);
  expect(tasks.filter((task) => syncedInDateRange(task, range)).map(({ note }) => note.id)).toEqual([1]);
  const task = tasks[0];
  expect(syncedInDateRange({ ...task, sources: [{ ...task.sources[0], syncedAt: null }] }, range)).toBe(false);
  expect(syncedInDateRange({ ...task, sources: [{ ...task.sources[0], syncedAt: new Date(2026, 10, 18).toISOString() }] }, range)).toBe(false);
  const dates = [new Date(2026, 10, 12, 0), new Date(2026, 10, 15, 23, 59, 59, 999)];
  for (const date of dates) {
    expect(syncedInDateRange({ ...task, sources: [{ ...task.sources[0], syncedAt: date.toISOString() }] }, {
      start: "2026-11-12", end: "2026-11-15"
    })).toBe(true);
  }
  expect(conversationStats([]).completionRate).toBe(0);
});

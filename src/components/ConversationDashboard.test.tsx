// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { insightNote, insightSources } from "../../tests/chatInsightsFixtures";
import { ConversationDashboard } from "./ConversationDashboard";
import { localDateKey } from "../services/noteDateService";
import type { CodexSessionUsage } from "../services/chatInsightsService";
import type { Note } from "../types/note";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.resetAllMocks(); vi.useRealTimers(); });
const filterTrigger = (label: string) => container.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${label}"]`)!;
it("counts conversations without board items and opens the project from the usage ranking", async () => {
  const repeatedSource = { ...insightSources[0], noteId: 5, syncedAt: new Date().toISOString() };
  mockRecords(false, [...insightSources, repeatedSource].map((source) => source.sessionId === "session-a" ? {
    ...source, codexUsage: { totalTokens: 1200, quotaChanges: [] },
    evidence: source.noteId === 1 ? "Codex 已修改：./src/App.tsx、src/App.tsx、src/styles.css"
      : source.noteId === 5 ? "Codex 已修改：src\\App.tsx" : source.evidence
  } : source), [
    { sessionId: "session-a", projectId: null, days: [{ date: null, totalTokens: 1200, turns: 1 }] },
    { sessionId: "question-only", projectId: "app", days: [{ date: null, totalTokens: 800, turns: 2 }] },
    { sessionId: "no-token-data", projectId: "empty", days: [{ date: null, totalTokens: null, turns: 1 }] }
  ]);
  await render(() => [insightNote(5, { title: "登录功能！" })]);

  expect(container.querySelector(".ci-analysis")).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>(".ci-usage-entry")!.click());
  const usage = container.querySelector(".ci-usage")!;
  expect(usage.querySelector(".ci-usage-total")?.getAttribute("title")).toBe("2,000 Token");
  expect(usage.querySelector(".ci-usage-caption")?.textContent).toContain("3 个对话");
  expect(usage.querySelector('[aria-label="还没有事项的项目，Token 暂无记录 · 1 轮 · 1 个对话"]')).not.toBeNull();
  const pie = usage.querySelector<HTMLElement>(".ci-usage-pie")!;
  vi.spyOn(pie, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 200));
  await act(async () => pie.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 180, clientY: 100 })));
  expect(pie.querySelector(".ci-usage-total")?.textContent).toBe("开发工具2,000Token");
  await act(async () => pie.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 })));
  expect(pie.querySelector(".ci-usage-total")?.textContent).toContain("总 Token");
  expect(usage.querySelector(".ci-usage-ranking")?.textContent).toContain("100.0%");
  expect(container.querySelector(".ci-analysis-timeline")?.textContent).toContain("登录功能！");
  expect(container.querySelector(".ci-analysis-radar li")?.textContent).toBe("src/App.tsx2 次");
  const datePicker = container.querySelector<HTMLButtonElement>('button[aria-label="工作日期"]')!;
  await act(async () => datePicker.click());
  const calendar = document.getElementById(datePicker.getAttribute("aria-controls")!)!;
  expect(calendar.getAttribute("role")).toBe("dialog");
  await act(async () => calendar.querySelector<HTMLButtonElement>(".date-popover-today")!.click());
  const radarProject = filterTrigger("雷达项目");
  await act(async () => radarProject.click());
  await act(async () => filterOptions(radarProject).find((option) => option.textContent?.includes("还没有事项的项目"))!.click());
  expect(container.querySelector(".ci-analysis-radar")).toBeNull();
  expect(container.textContent).toContain("该项目暂无文件改动记录");
  const project = usage.querySelector<HTMLButtonElement>('button[aria-label="开发工具，2,000 Token · 3 轮 · 2 个对话"]')!;
  await act(async () => project.click());
  expect(container.querySelector(".ci-analysis")).toBeNull();
  expect(container.querySelector('.ci-project-select[aria-pressed="true"]')?.textContent).toContain("开发工具");
});
const filterOptions = (trigger: HTMLButtonElement) =>
  [...document.getElementById(trigger.getAttribute("aria-controls")!)!.querySelectorAll<HTMLElement>('[role="option"]')];
it("analyzes the selected radar project on demand and shows counts with original requests", async () => {
  mockRecords();
  const native = vi.mocked(invoke).getMockImplementation()!;
  let finish!: (result: unknown) => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "analyze_chat_project_requirements") {
      if ((args as { projectId: string }).projectId === "empty") throw new Error("请先填写 API 配置");
      return new Promise((resolve) => { finish = resolve; });
    }
    return native(command, args);
  });
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>(".ci-usage-entry")!.click());
  expect(invoke).not.toHaveBeenCalledWith("analyze_chat_project_requirements", expect.anything());
  const radar = container.querySelector(".ci-repeat-card")!;
  const action = () => radar.querySelector<HTMLButtonElement>(".ci-repeated-actions button")!;
  await act(async () => action().click());
  expect(action().disabled).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("analyze_chat_project_requirements", { projectId: "app" });
  await act(async () => finish({
    reviewedRequests: 5,
    groups: [{ title: "增加日期筛选", count: 2, examples: ["补一个起止日期选择"] }]
  }));
  expect(action().disabled).toBe(false);
  const results = container.querySelector(".ci-analysis-result")!;
  expect(results).toBe(radar.nextElementSibling);
  expect(radar.querySelector(".ci-repeated-results")).toBeNull();
  expect(results.querySelector(".ci-repeated-results summary")?.textContent).toBe("增加日期筛选2 次");
  expect(results.querySelector("blockquote")?.textContent).toBe("补一个起止日期选择");
  const project = filterTrigger("雷达项目");
  await act(async () => project.click());
  await act(async () => filterOptions(project).find((option) => option.textContent === "还没有事项的项目")!.click());
  expect(container.querySelector(".ci-analysis-result")).toBeNull();
  await act(async () => action().click());
  expect(invoke).toHaveBeenLastCalledWith("analyze_chat_project_requirements", { projectId: "empty" });
  expect(container.querySelector('.ci-analysis-result [role="alert"]')?.textContent).toContain("请先填写 API 配置");
});
it("filters usage by local turn dates and counts a conversation only once across matching days", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 26, 12));
  mockRecords(false, insightSources, [
    { sessionId: "multi-day", projectId: "app", days: [
      { date: "2026-11-20", totalTokens: 200, turns: 1 },
      { date: "2026-11-26", totalTokens: 100, turns: 2 }
    ] },
    { sessionId: "another", projectId: "empty", days: [{ date: "2026-11-20", totalTokens: 300, turns: 1 }] },
    { sessionId: "earlier", projectId: "app", days: [{ date: "2026-11-11", totalTokens: 400, turns: 1 }] },
    { sessionId: "undated", projectId: "app", days: [{ date: null, totalTokens: 200, turns: 1 }] }
  ]);
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>(".ci-usage-entry")!.click());
  const usage = container.querySelector(".ci-analysis-share")!;
  const range = filterTrigger("用量日期范围");
  const pickRange = async (label: string) => {
    await act(async () => range.click());
    await act(async () => filterOptions(range).find((option) => option.textContent === label)!.click());
  };
  const expectUsage = (tokens: string, sessions: number) => {
    expect(usage.querySelector(".ci-usage-total")?.getAttribute("title")).toBe(`${tokens} Token`);
    expect(usage.querySelector(".ci-usage-caption")?.textContent).toContain(`${sessions} 个对话`);
  };
  expectUsage("1,200", 4);
  await pickRange("今天");
  expectUsage("100", 1);
  expect(usage.querySelector('[aria-label="开发工具，100 Token · 2 轮 · 1 个对话"]')).not.toBeNull();
  await pickRange("近 7 天");
  expectUsage("600", 2);
  expect(usage.querySelector(".ci-usage-ranking strong")?.textContent).toBe("50.0%");
  await pickRange("近 30 天");
  expectUsage("1,000", 3);
  await pickRange("自定义日期");
  const pickDate = async (field: string, date: number) => {
    const trigger = usage.querySelector<HTMLButtonElement>(`[aria-label="${field}"]`)!;
    await act(async () => trigger.click());
    const calendar = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    const label = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date(2026, 10, date));
    await act(async () => calendar.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  };
  await pickDate("用量开始日期", 20);
  await pickDate("用量结束日期", 20);
  expectUsage("500", 2);
  expect(usage.querySelector(".ci-usage-ranking strong")?.textContent).toBe("60.0%");
  await pickDate("用量开始日期", 21);
  expect(usage.querySelector('[role="alert"]')?.textContent).toContain("开始日期不能晚于结束日期");
  expect(usage.querySelector(".ci-usage-total")).toBeNull();
  await pickRange("全部日期");
  expectUsage("1,200", 4);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "get_chat_sync_project_usage")).toHaveLength(1);
});
const enterTaskContent = (form: HTMLFormElement, content: string) => act(async () => {
  const field = form.querySelector<HTMLInputElement>("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, content);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
async function render(readManualNotes: () => Note[] = () => [], completedAt: string | null = null) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const onEdit = vi.fn().mockResolvedValue(true);
  let setSidebarCollapsed!: (collapsed: boolean) => void;
  const initialNotes = [insightNote(1, { title: "整理接口文档" }), insightNote(2, { title: "登录功能", status: "doing" }),
    insightNote(3, { title: "看板设计", completed: true, status: "completed", completedAt }),
    insightNote(4, { title: "手动事项" })];
  function Dashboard() {
    const [notes, setNotes] = useState(() => [...initialNotes, ...readManualNotes()]);
    const [sidebarCollapsed, setCollapsed] = useState(false);
    setSidebarCollapsed = setCollapsed;
    return <ConversationDashboard notes={notes} categories={[]} sidebarCollapsed={sidebarCollapsed}
      onNotesChanged={async () => setNotes([...initialNotes, ...readManualNotes()])}
      onEdit={async (id, input) => {
        const saved = await onEdit(id, input);
        if (saved) setNotes((current) => current.map((note) => note.id === id ? { ...note, title: input.title, details: input.details ?? null } : note));
        return saved;
      }} />;
  }
  await act(async () => root.render(<Dashboard />));
  return { onEdit, setSidebarCollapsed };
}
function mockRecords(duplicateNames = false, sources = insightSources, usage: CodexSessionUsage[] = []) {
  const archived = new Set<number>();
  const projects = [
    { id: "app", name: "开发工具", rootPaths: ["C:/dev/app"], hidden: false, settings: { displayName: null as string | null, tracked: false } },
    { id: "empty", name: duplicateNames ? "开发工具" : "还没有事项的项目",
      rootPaths: [duplicateNames ? "C:/dev/app" : "C:/dev/empty"], hidden: false, settings: { displayName: null as string | null, tracked: false } }
  ];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "get_chat_sync_tasks") return sources.map((source) => ({ ...source, archived: archived.has(source.noteId) }));
    if (command === "get_chat_sync_project_usage") return usage;
    if (command === "set_chat_sync_task_archived") {
      const { noteId, archived: shouldArchive } = args as { noteId: number; archived: boolean };
      if (shouldArchive) archived.add(noteId);
      else archived.delete(noteId);
      return;
    }
    if (command === "get_chat_sync_projects") return { projects, sessionProjects: { "session-a": "app", "session-b": "app" } };
    if (command === "set_chat_sync_project_hidden") {
      const { projectId, hidden } = args as { projectId: string; hidden: boolean };
      projects.find(({ id }) => id === projectId)!.hidden = hidden;
      return;
    }
    if (command === "save_chat_sync_project") {
      const { projectId, displayName, tracked } = args as { projectId: string; displayName: string; tracked: boolean };
      const item = projects.find(({ id }) => id === projectId)!;
      item.settings = { displayName: displayName || null, tracked };
      return item.settings;
    }
    return { enabled: true, pending: 2, failed: 0 };
  });
}
it("lists projects with zero tasks, saves editable project settings, and filters the board by tracking", async () => {
  mockRecords(); await render();
  const projectButtons = () => [...container.querySelectorAll<HTMLButtonElement>(".ci-project-select")];
  expect(projectButtons().map(({ textContent }) => textContent)).toEqual(["开发工具2 项", "还没有事项的项目0 项"]);
  expect(projectButtons().map(({ title }) => title)).toEqual(["C:/dev/app", "C:/dev/empty"]);
  await act(async () => projectButtons()[1].click());
  expect(container.textContent).toContain("此项目暂无同步事项");
  await act(async () => projectButtons()[0].click());
  expect(container.querySelectorAll(".ci-task")).toHaveLength(2);

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="编辑项目 还没有事项的项目"]')!.click());
  const form = container.querySelector<HTMLFormElement>(".ci-project-form")!;
  const displayName = form.querySelector<HTMLInputElement>('input[placeholder]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(displayName, "新方向");
    displayName.dispatchEvent(new Event("input", { bubbles: true }));
    form.querySelector<HTMLInputElement>('[type="checkbox"]')!.click();
  });
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(invoke).toHaveBeenCalledWith("save_chat_sync_project", { projectId: "empty", displayName: "新方向", tracked: true });
  expect(projectButtons()[0].textContent).toBe("新方向0 项");
  await act(async () => container.querySelector<HTMLButtonElement>(".ci-project-filter")!.click());
  expect(projectButtons().map(({ textContent }) => textContent)).toEqual(["新方向0 项"]);
  expect(container.querySelectorAll(".ci-task")).toHaveLength(0);
  await act(async () => container.querySelector<HTMLButtonElement>(".ci-project-filter")!.click());
  expect(projectButtons()).toHaveLength(2);
  expect(container.querySelectorAll(".ci-task")).toHaveLength(3);
});
it("keeps the sidebar mounted for the transition while blocking interaction when collapsed", async () => {
  mockRecords(); const { setSidebarCollapsed } = await render();
  const sidebar = container.querySelector<HTMLElement>("#ci-project-sidebar")!;
  const workspace = sidebar.parentElement!;
  const project = sidebar.querySelector<HTMLButtonElement>(".ci-project-select")!;
  await act(async () => project.click());
  expect(project.getAttribute("aria-pressed")).toBe("true");

  await act(async () => setSidebarCollapsed(true));
  expect(workspace.classList.contains("has-projects")).toBe(false);
  expect(sidebar.hidden).toBe(false);
  expect(sidebar.hasAttribute("inert")).toBe(true);
  expect(sidebar.getAttribute("aria-hidden")).toBe("true");
  expect(sidebar.contains(project)).toBe(true);
  expect(filterTrigger("项目筛选").textContent).toBe("开发工具");

  await act(async () => setSidebarCollapsed(false));
  expect(workspace.classList.contains("has-projects")).toBe(true);
  expect(sidebar.hasAttribute("inert")).toBe(false);
  expect(sidebar.hasAttribute("aria-hidden")).toBe(false);
  expect(project.getAttribute("aria-pressed")).toBe("true");
});
it("tracks a project from its row and adds another directly from the tracked view", async () => {
  mockRecords(); await render();
  const star = container.querySelector<HTMLButtonElement>('[aria-label="追踪项目 开发工具"]')!;
  const filter = container.querySelector<HTMLButtonElement>(".ci-project-filter")!;
  const toggle = container.querySelector<HTMLButtonElement>(".ci-project-all")!;
  expect(star.getAttribute("aria-pressed")).toBe("false");

  vi.mocked(invoke).mockRejectedValueOnce(new Error("保存失败"));
  await act(async () => star.click());
  expect(container.querySelector(".ci-projects [role=alert]")?.textContent).toContain("保存失败");
  expect(star.getAttribute("aria-pressed")).toBe("false");
  await act(async () => star.click());
  expect(invoke).toHaveBeenLastCalledWith("save_chat_sync_project", { projectId: "app", displayName: "", tracked: true });
  expect(star.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector(".ci-projects [role=alert]")).toBeNull();

  await act(async () => filter.click());
  expect(container.querySelectorAll(".ci-project-select")).toHaveLength(1);
  const add = filterTrigger("添加追踪项目");
  await act(async () => add.click());
  const [option] = filterOptions(add);
  expect(option.textContent).toBe("还没有事项的项目");
  await act(async () => option.click());
  expect(invoke).toHaveBeenLastCalledWith("save_chat_sync_project", { projectId: "empty", displayName: "", tracked: true });
  expect(container.querySelectorAll(".ci-project-select")).toHaveLength(2);
  expect(filterTrigger("添加追踪项目")).toBeNull();
  expect(document.activeElement).toBe(toggle);

  const row = star.closest("li")!;
  await act(async () => row.querySelector<HTMLButtonElement>(".ci-project-select")!.click());
  star.focus();
  await act(async () => star.click());
  expect(invoke).toHaveBeenLastCalledWith("save_chat_sync_project", { projectId: "app", displayName: "", tracked: false });
  expect(row.isConnected).toBe(false);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(toggle);
  expect(filterTrigger("添加追踪项目")).toBeTruthy();
});
it("distinguishes separate Codex project IDs even when name and path match", async () => {
  mockRecords(true); await render();
  const projectButtons = [...container.querySelectorAll<HTMLButtonElement>(".ci-project-select")];
  expect(projectButtons.map(({ textContent }) => textContent)).toEqual(["开发工具2 项", "开发工具0 项"]);
  expect(projectButtons.map(({ title }) => title))
    .toEqual(["C:/dev/app · #app", "C:/dev/app · #empty"]);
  const picker = filterTrigger("项目筛选");
  await act(async () => picker.click());
  const options = filterOptions(picker);
  expect(options.map(({ textContent }) => textContent)).toEqual(["所有项目", "开发工具 · #app", "开发工具 · #empty", "未分类"]);
  await act(async () => options[2].click());
  expect(picker.title).toBe("C:/dev/app · #empty");
  expect(projectButtons[1].getAttribute("aria-pressed")).toBe("true");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="编辑项目 开发工具 · C:/dev/app · #empty"]')!.click());
  const heading = container.querySelector<HTMLElement>("form strong");
  expect(heading?.textContent).toBe("编辑 开发工具");
  expect(heading?.title).toBe("C:/dev/app · #empty");
});
it("quickly removes projects and their tasks from the board, with undo and later restoration", async () => {
  mockRecords(); await render();
  const removeProject = () => container.querySelector<HTMLButtonElement>('[aria-label="移出看板 开发工具"]')!;
  await act(async () => removeProject().click());
  expect(invoke).toHaveBeenCalledWith("set_chat_sync_project_hidden", { projectId: "app", hidden: true });
  expect(removeProject()).toBeNull();
  expect(container.querySelectorAll(".ci-task")).toHaveLength(1);
  const picker = filterTrigger("项目筛选");
  await act(async () => picker.click());
  expect(filterOptions(picker).map(({ textContent }) => textContent)).not.toContain("开发工具");
  await act(async () => picker.click());

  await act(async () => container.querySelector<HTMLButtonElement>(".ci-project-undo button")!.click());
  expect(invoke).toHaveBeenCalledWith("set_chat_sync_project_hidden", { projectId: "app", hidden: false });
  expect(container.querySelectorAll(".ci-task")).toHaveLength(3);

  await act(async () => container.querySelector<HTMLButtonElement>(".ci-project-select")!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })
  ));
  await act(async () => root.unmount());
  container.remove();
  await render();
  expect(removeProject()).toBeNull();
  expect(container.querySelector(".ci-project-undo")).toBeNull();
  expect(container.querySelector(".ci-removed-projects summary")?.textContent).toContain("已移除");
  const removedLabel = container.querySelector<HTMLElement>(".ci-removed-projects .ci-project-label");
  expect(removedLabel?.textContent).toBe("开发工具");
  expect(removedLabel?.title).toBe("C:/dev/app");
  await act(async () => {
    container.querySelector<HTMLDetailsElement>(".ci-removed-projects")!.open = true;
    container.querySelector<HTMLButtonElement>('[aria-label="恢复项目 开发工具"]')!.click();
  });
  expect(removeProject()).not.toBeNull();
  expect(container.querySelectorAll(".ci-task")).toHaveLength(3);
});
it("dismisses the latest removal notice after three seconds and keeps keyboard undo available", async () => {
  vi.useFakeTimers();
  mockRecords(); await render();
  const notice = () => container.querySelector(".ci-project-undo");
  const remove = (name: string) => act(async () => {
    container.querySelector<HTMLButtonElement>(`[aria-label="移出看板 ${name}"]`)!.click();
  });
  const pressUndo = (target: HTMLElement) => {
    const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  await remove("开发工具");
  expect(notice()?.textContent).toContain("开发工具");
  await act(async () => { vi.advanceTimersByTime(2000); });
  await remove("还没有事项的项目");
  await act(async () => { vi.advanceTimersByTime(2999); });
  expect(notice()?.textContent).toContain("还没有事项的项目");
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(notice()).toBeNull();

  const search = container.querySelector<HTMLInputElement>('[aria-label="搜索对话事项"]')!;
  search.focus();
  expect(pressUndo(search)).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith("set_chat_sync_project_hidden", { projectId: "empty", hidden: false });

  const allProjects = container.querySelector<HTMLButtonElement>(".ci-project-all")!;
  allProjects.focus();
  await act(async () => { expect(pressUndo(allProjects)).toBe(true); });
  expect(invoke).toHaveBeenCalledWith("set_chat_sync_project_hidden", { projectId: "empty", hidden: false });
  expect(container.querySelectorAll(".ci-project-select")).toHaveLength(1);
  expect(notice()).toBeNull();
  expect(pressUndo(allProjects)).toBe(false);
});
it("shows the matching turn's token use and observed quota changes on the card", async () => {
  mockRecords();
  const read = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command !== "get_chat_sync_tasks") return read(command, args);
    return Promise.resolve(insightSources.map((source) => ({
      ...source,
      codexUsage: source.noteId !== 1 ? undefined : {
        totalTokens: source.sessionId === "session-b" ? 11522554 : 160,
        quotaChanges: [{ windowMinutes: 300, percentagePoints: 20 }, { windowMinutes: 10080, percentagePoints: 3 }]
      }
    })));
  });
  await render();
  const usage = container.querySelector('[aria-label="编辑：整理接口文档"]')?.closest(".ci-task")?.querySelector(".ci-task-usage");
  expect(usage?.querySelector(".ci-task-token-usage strong")?.textContent).toBe("1152.3万 Token");
  expect(usage?.querySelector(".ci-task-token-usage")?.getAttribute("title")).toContain("11,522,554 Token");
  const meters = [...usage!.querySelectorAll('[role="meter"]')];
  expect(meters.map((meter) => meter.getAttribute("aria-label"))).toEqual(["5 小时剩余额度降幅", "7 天剩余额度降幅"]);
  expect(meters.map((meter) => meter.getAttribute("aria-valuetext"))).toEqual(["减少 20 个百分点", "减少 3 个百分点"]);
  expect(meters.map((meter) => meter.querySelector("strong")?.textContent)).toEqual(["−20 点", "−3 点"]);
  expect(meters.map((meter) => (meter.querySelector(".ci-task-quota-track > span") as HTMLElement).style.width)).toEqual(["20%", "3%"]);
  expect(container.querySelectorAll(".ci-task-usage")).toHaveLength(1);
});
it("keeps the synced file names in the card details", async () => {
  mockRecords();
  const read = vi.mocked(invoke).getMockImplementation()!;
  const fileEvidence = "Codex 已修改：Board.tsx、board.css";
  vi.mocked(invoke).mockImplementation((command, args) => command === "get_chat_sync_tasks"
    ? Promise.resolve(insightSources.map((source) => source.noteId === 3 ? { ...source, evidence: fileEvidence } : source))
    : read(command, args));
  await render();
  const card = container.querySelector(".ci-completed .ci-task")!;
  expect(card.textContent).not.toMatch(/Board\.tsx|board\.css/);
  await act(async () => card.querySelector<HTMLButtonElement>(".ci-task-open")!.click());
  const details = document.querySelector<HTMLDetailsElement>(".ci-editor-dialog .ci-editor-sources")!;
  await act(async () => details.querySelector("summary")!.click());
  expect(details.open).toBe(true);
  expect(details.querySelector("blockquote")?.textContent).toBe(fileEvidence);
});
it("opens the editor from the card surface and provides its synced evidence", async () => {
  mockRecords(); await render();
  expect(container.querySelectorAll(".ci-task")).toHaveLength(3);
  expect(container.querySelector(".ci-task footer, .ci-task select, .ci-task time")).toBeNull();
  const pending = container.querySelector('[data-status="todo"]')!;
  expect(pending.lastElementChild).toBe(pending.querySelector(".ci-add-task"));
  expect(container.textContent).not.toContain("手动事项");
  expect(container.querySelector(".ci-doing")?.textContent).toContain("登录功能");
  const card = pending.querySelector<HTMLElement>(".ci-task")!;
  await act(async () => card.click());
  const editor = document.querySelector(".ci-editor-dialog")!;
  const title = editor.querySelector<HTMLTextAreaElement>('[aria-label="事项标题"]')!;
  expect(title.value).toBe("整理接口文档");
  expect(document.activeElement).toBe(title);
  const sources = editor.querySelector<HTMLDetailsElement>(".ci-editor-sources")!;
  await act(async () => sources.querySelector("summary")!.click());
  expect(sources.open).toBe(true);
  expect(sources.textContent).toContain("接口文档要写清楚错误码");
  expect(sources.textContent).not.toMatch(/当前状态|计划日期/);
  expect(sources.querySelectorAll(".ci-source")).toHaveLength(2);
  await act(async () => title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(editor.isConnected).toBe(false);
  expect(document.activeElement).toBe(card.querySelector(".ci-task-open"));
});
it("archives a completed card, keeps it archived after reopening the board, and restores it", async () => {
  mockRecords(); await render();
  const archive = () => container.querySelector<HTMLButtonElement>('[aria-label="归档事项 看板设计"]');
  const archiveView = () => container.querySelector<HTMLButtonElement>(".ci-archive-toggle")!;
  vi.mocked(invoke).mockRejectedValueOnce("保存归档失败");
  await act(async () => archive()!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("保存归档失败");
  expect(archive()).not.toBeNull();

  archive()!.focus();
  await act(async () => archive()!.click());
  expect(invoke).toHaveBeenLastCalledWith("set_chat_sync_task_archived", { noteId: 3, archived: true });
  expect(archive()).toBeNull();
  expect(archiveView().textContent).toBe("已归档 1");
  expect(document.activeElement).toBe(archiveView());

  await act(async () => root.unmount());
  container.remove();
  await render();
  expect(archive()).toBeNull();
  await act(async () => archiveView().click());
  expect(container.querySelector('[data-status="completed"] .ci-task')?.textContent).toContain("已经完成看板设计");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="恢复事项 看板设计"]')!.click());
  expect(invoke).toHaveBeenLastCalledWith("set_chat_sync_task_archived", { noteId: 3, archived: false });
  expect(container.textContent).toContain("暂无归档事项");
  await act(async () => archiveView().click());
  expect(container.querySelector('[data-status="completed"] .ci-task')?.contains(archive())).toBe(true);
});
it("adds the first item directly inside the selected project's pending column", async () => {
  mockRecords();
  const native = vi.mocked(invoke).getMockImplementation()!;
  const manual: Note[] = [];
  const source = { noteId: 5, sessionId: "", evidence: "", syncedAt: "2026-11-19T00:00:00Z", archived: false, manual: true, projectId: "empty" };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "get_chat_sync_tasks") return manual.length ? [source] : [];
    if (command === "create_chat_board_task") {
      const { title } = args as { title: string };
      manual.push(insightNote(source.noteId, { title }));
      return source;
    }
    return native(command, args);
  });
  await render(() => manual);
  const project = container.querySelectorAll<HTMLButtonElement>(".ci-project-select")[1];
  await act(async () => project.click());

  const pending = () => container.querySelector<HTMLElement>('[data-status="todo"]')!;
  const trigger = () => pending().querySelector<HTMLButtonElement>(".ci-add-task")!;
  const form = () => pending().querySelector<HTMLFormElement>(".ci-create-task")!;
  await act(async () => trigger().click());
  const firstInput = form().querySelector<HTMLInputElement>('input[aria-label="Codex 提示词"]')!;
  expect(firstInput.type).toBe("text");
  expect(firstInput.hasAttribute("placeholder")).toBe(false);
  expect(document.activeElement).toBe(firstInput);
  await act(async () => firstInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(form()).toBeNull();
  expect(document.activeElement).toBe(trigger());

  await act(async () => trigger().click());
  expect(filterTrigger("待处理事项项目").textContent).toBe("还没有事项的项目");
  await enterTaskContent(form(), "项目的第一个事项");
  await act(async () => form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(invoke).toHaveBeenCalledWith("create_chat_board_task", { title: "项目的第一个事项", details: "", projectId: "empty" });
  expect(form()).toBeNull();
  expect(pending().querySelector(".ci-task-open strong")?.textContent).toBe("项目的第一个事项");
  expect(project.getAttribute("aria-pressed")).toBe("true");
});
it("closes a blank composer and saves a filled one without overriding the clicked project", async () => {
  mockRecords();
  const native = vi.mocked(invoke).getMockImplementation()!;
  const manual: Note[] = [];
  const source = { noteId: 5, sessionId: "", evidence: "", syncedAt: "2026-11-19T00:00:00Z",
    archived: false, manual: true, projectId: "empty" };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "create_chat_board_task") {
      const { title, details } = args as { title: string; details: string };
      manual.push(insightNote(source.noteId, { title, details }));
      return source;
    }
    if (command === "get_chat_sync_tasks" && manual.length) return [...insightSources, source];
    return native(command, args);
  });
  await render(() => manual);
  const trigger = () => container.querySelector<HTMLButtonElement>(".ci-add-task")!;
  const form = () => container.querySelector<HTMLFormElement>(".ci-create-task")!;
  const projects = container.querySelectorAll<HTMLButtonElement>(".ci-project-select");
  const search = container.querySelector<HTMLInputElement>('[aria-label="搜索对话事项"]')!;

  await act(async () => trigger().click());
  await enterTaskContent(form(), "   ");
  await act(async () => { search.focus(); search.click(); });
  expect(form()).toBeNull();
  expect(document.activeElement).toBe(search);
  expect(invoke).not.toHaveBeenCalledWith("create_chat_board_task", expect.anything());

  await act(async () => trigger().click());
  const input = form().querySelector<HTMLInputElement>("input")!;
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => "记录测试结果\r\n \r\n补上两条说明" } });
  await act(async () => input.dispatchEvent(paste));
  expect(input.value).toBe("记录测试结果 补上两条说明");
  const picker = filterTrigger("待处理事项项目");
  await act(async () => picker.click());
  const projectOption = filterOptions(picker).find((option) => option.textContent === "还没有事项的项目")!;
  await act(async () => {
    projectOption.click();
    document.body.click();
  });
  expect(form()).not.toBeNull();
  expect(picker.textContent).toBe("还没有事项的项目");
  expect(invoke).not.toHaveBeenCalledWith("create_chat_board_task", expect.anything());
  await act(async () => projects[0].click());
  expect(invoke).toHaveBeenCalledWith("create_chat_board_task", { title: "记录测试结果 补上两条说明", details: "", projectId: "empty" });
  expect(invoke).not.toHaveBeenCalledWith("send_chat_board_task", expect.anything());
  expect(form()).toBeNull();
  expect(projects[0].getAttribute("aria-pressed")).toBe("true");
  await act(async () => projects[1].click());
  expect(container.querySelector(".ci-todo .ci-task-open")?.textContent).toContain("记录测试结果");
});
it("retains composer text after an outside save fails and avoids submitting twice while saving", async () => {
  mockRecords();
  const native = vi.mocked(invoke).getMockImplementation()!;
  let rejectSave!: (reason: Error) => void;
  const pending = new Promise<never>((_, reject) => { rejectSave = reject; });
  const save = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({
    noteId: 5, sessionId: "", evidence: "", syncedAt: null, archived: false, manual: true, projectId: null
  });
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "create_chat_board_task" ? save(args) : native(command, args));
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>(".ci-add-task")!.click());
  const form = container.querySelector<HTMLFormElement>(".ci-create-task")!;
  const input = form.querySelector("input")!;
  const outside = container.querySelector<HTMLElement>(".ci-header h1")!;
  await enterTaskContent(form, "要保存的事项");
  await act(async () => { outside.click(); outside.click(); });
  expect(save).toHaveBeenCalledOnce();

  await act(async () => rejectSave(new Error("保存失败")));
  expect(input.value).toBe("要保存的事项");
  expect(input.disabled).toBe(false);
  expect(form.querySelector('[role="alert"]')?.textContent).toContain("自动保存失败，内容已保留");
  await act(async () => outside.click());
  expect(save).toHaveBeenCalledTimes(2);
  expect(form.isConnected).toBe(false);
});
it("adds a pending item, sends it in a new conversation, or lets the user choose an existing conversation", async () => {
  mockRecords();
  const native = vi.mocked(invoke).getMockImplementation()!;
  const manual: Note[] = [];
  const source = { noteId: 5, sessionId: "", evidence: "", syncedAt: "2026-11-19T00:00:00Z", archived: false, manual: true, projectId: "app",
    dispatchThreadId: "", dispatchState: null as "running" | "completed" | null };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "create_chat_board_task") {
      const { title, details } = args as { title: string; details: string };
      manual.push(insightNote(5, { title, details }));
      return source;
    }
    if (command === "get_chat_sync_tasks" && manual.length) return [...insightSources, source];
    if (command === "list_chat_board_threads") {
      const { search, cursor } = args as { search: string; cursor: string | null };
      const existing = { id: "existing-thread", name: "接口项目", preview: "", cwd: "C:/dev/app" };
      if (search) return { nextCursor: null, data: [existing] };
      if (cursor) return { nextCursor: null, data: [{ id: "older-thread", name: "较早的对话", preview: "", cwd: "C:/dev/app" }] };
      return { nextCursor: "more", data: [existing, { id: "new-thread", name: "刚发送的事项", preview: "", cwd: "C:/dev/app" }] };
    }
    if (command === "send_chat_board_task") {
      source.sessionId = (args as { threadId: string | null }).threadId ?? "new-thread";
      source.dispatchThreadId = source.sessionId;
      source.dispatchState = "running";
      manual[0] = { ...manual[0], status: "doing" };
      return { threadId: source.sessionId, saved: true };
    }
    if (command === "open_chat_board_thread") return;
    return native(command, args);
  });
  await render(() => manual);
  await act(async () => container.querySelector<HTMLButtonElement>(".ci-add-task")!.click());
  const form = container.querySelector<HTMLFormElement>(".ci-create-task")!;
  const prompt = "补齐接口文档，补上两个示例";
  await enterTaskContent(form, prompt);
  const project = filterTrigger("待处理事项项目");
  await act(async () => project.click());
  await act(async () => filterOptions(project).find((option) => option.textContent === "开发工具")!.click());
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(invoke).toHaveBeenCalledWith("create_chat_board_task", { title: prompt, details: "", projectId: "app" });
  const findCard = (column: string) => [...container.querySelectorAll(`.ci-${column} .ci-task`)].find((item) => item.textContent?.includes(prompt))!;
  const card = findCard("todo");
  expect(card.textContent).toContain("补上两个示例");
  expect(invoke).not.toHaveBeenCalledWith("send_chat_board_task", expect.anything());
  await act(async () => card.querySelector<HTMLButtonElement>(`[aria-label="开启新对话 ${prompt}"]`)!.click());
  expect(invoke).toHaveBeenCalledWith("send_chat_board_task", { noteId: 5, threadId: null, projectId: "app" });
  expect(invoke).not.toHaveBeenCalledWith("open_chat_board_thread", expect.anything());
  expect(findCard("todo")).toBeUndefined();
  expect(findCard("doing").querySelector('[role="status"]')?.textContent).toBe("Codex 处理中");
  await act(async () => findCard("doing").querySelector<HTMLButtonElement>(`[aria-label="在 Codex 中查看 ${prompt}"]`)!.click());
  expect(invoke).toHaveBeenCalledWith("open_chat_board_thread", { threadId: "new-thread" });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "send_chat_board_task")).toHaveLength(1);

  await act(async () => root.unmount());
  container.remove();
  manual[0] = { ...manual[0], status: "todo" };
  source.dispatchState = null;
  await render(() => manual);
  await act(async () => findCard("todo").querySelector<HTMLButtonElement>(`[aria-label="沿用之前对话 ${prompt}"]`)!.click());
  expect(document.querySelector(".ci-editor-dialog")).toBeNull();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="选择 Codex 对话"]')!;
  const options = () => [...dialog.querySelectorAll<HTMLInputElement>('[role="radiogroup"] input')];
  expect(options().find((option) => option.checked)?.value).toBe("new-thread");
  expect(dialog.querySelector(".ci-thread-scope")?.textContent).toBe("项目 · 开发工具");
  expect(invoke).toHaveBeenCalledWith("list_chat_board_threads", { search: "", cursor: null, projectId: "app" });
  const nextPage = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "加载更多")!;
  await act(async () => nextPage.click());
  expect(invoke).toHaveBeenCalledWith("list_chat_board_threads", { search: "", cursor: "more", projectId: "app" });
  expect(options().map((option) => option.value)).toContain("older-thread");
  const searchForm = dialog.querySelector<HTMLFormElement>(".ci-thread-search")!;
  const search = searchForm.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "接口");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(invoke).toHaveBeenCalledWith("list_chat_board_threads", { search: "接口", cursor: null, projectId: "app" });
  expect(options().map((option) => option.value)).toEqual(["existing-thread"]);
  expect(options()[0].checked).toBe(false);
  await act(async () => options()[0].click());
  await act(async () => dialog.querySelector<HTMLButtonElement>(".ci-thread-actions button:last-child")!.click());
  expect(invoke).toHaveBeenCalledWith("send_chat_board_task", { noteId: 5, threadId: "existing-thread", projectId: "app" });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "open_chat_board_thread")).toHaveLength(1);
  expect(dialog.isConnected).toBe(false);

  await act(async () => root.unmount());
  container.remove();
  manual[0] = { ...manual[0], status: "completed", completed: true };
  source.dispatchState = "completed";
  await render(() => manual);
  const completed = findCard("completed");
  const view = completed.querySelector<HTMLButtonElement>(`.ci-task-actions [aria-label="在 Codex 中查看 ${prompt}"]`)!;
  expect(view.textContent).toBe("");
  expect(view.title).toBe("在 Codex 中查看");
  expect(completed.querySelector(".ci-task-dispatch")).toBeNull();
  await act(async () => view.click());
  expect(invoke).toHaveBeenLastCalledWith("open_chat_board_thread", { threadId: "existing-thread" });
  expect(document.querySelector(".ci-editor-dialog")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "send_chat_board_task")).toHaveLength(2);
});
it.each([
  { action: "开启新对话", threadId: null, outcome: "sent" },
  { action: "沿用之前对话", threadId: "session-a", outcome: "draft" },
  { action: "开启新对话", threadId: null, outcome: "failed" }
] as const)("adds and dispatches directly from the composer ($outcome)", async ({ action, threadId, outcome }) => {
  mockRecords();
  const native = vi.mocked(invoke).getMockImplementation()!;
  let created: Note | undefined;
  const source = { noteId: 5, sessionId: "", evidence: "", syncedAt: "2026-11-19T00:00:00Z",
    archived: false, manual: true, projectId: "app" };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "create_chat_board_task") {
      const { title, details } = args as { title: string; details: string };
      created = insightNote(source.noteId, { title, details });
      return source;
    }
    if (command === "get_chat_sync_tasks" && created) return [...insightSources, source];
    if (command === "list_chat_board_threads") {
      return { nextCursor: null, data: [{ id: "session-a", name: "接口项目", preview: "", cwd: "C:/dev/app" }] };
    }
    if (command === "send_chat_board_task") {
      if (outcome === "failed") throw new Error("Codex 连接失败");
      if (outcome === "draft") return { threadId, saved: false, draftOpened: true };
      created = { ...created!, status: "doing" };
      return { threadId: "new-thread", saved: true };
    }
    return native(command, args);
  });

  await render(() => created ? [created] : []);
  await act(async () => container.querySelector<HTMLButtonElement>(".ci-project-select")!.click());
  await act(async () => container.querySelector<HTMLButtonElement>(".ci-add-task")!.click());
  const form = container.querySelector<HTMLFormElement>(".ci-create-task")!;
  const button = [...form.querySelectorAll("button")].find(({ textContent }) => textContent === action)!;
  expect(button.disabled).toBe(true);
  await enterTaskContent(form, "  补齐接口文档并补两个示例  ");
  await act(async () => button.click());

  if (threadId) {
    const picker = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="选择 Codex 对话"]')!;
    expect(invoke).toHaveBeenCalledWith("list_chat_board_threads", { search: "", cursor: null, projectId: "app" });
    await act(async () => picker().querySelector<HTMLButtonElement>('[aria-label="关闭对话选择"]')!.click());
    expect(invoke).not.toHaveBeenCalledWith("create_chat_board_task", expect.anything());
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    const thread = picker().querySelector<HTMLInputElement>('input[type="radio"]')!;
    expect(thread.value).toBe(threadId);
    await act(async () => thread.click());
    await act(async () => picker().querySelector<HTMLButtonElement>(".ci-thread-actions button:last-child")!.click());
    expect(picker()).toBeNull();
  }

  const actions = vi.mocked(invoke).mock.calls.filter(([command]) =>
    command === "create_chat_board_task" || command === "send_chat_board_task");
  expect(actions).toEqual([
    ["create_chat_board_task", { title: "补齐接口文档并补两个示例", details: "", projectId: "app" }],
    ["send_chat_board_task", { noteId: 5, threadId, projectId: "app" }]
  ]);
  expect(form.isConnected).toBe(false);
  const column = outcome === "sent" ? "doing" : "todo";
  expect(container.querySelector(`.ci-${column}`)?.textContent).toContain("补齐接口文档");
  if (outcome === "draft") expect(container.textContent).toContain("已准备草稿，请在 Codex 中发送。");
  if (outcome === "failed") expect(container.querySelector('[role="alert"]')?.textContent).toContain("事项已添加，可在卡片上重试发送。");
});
it("keeps a task pending when Codex opens a draft in the selected conversation", async () => {
  mockRecords();
  const native = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_chat_board_threads") {
      return { nextCursor: null, data: [{ id: "session-a", name: "接口项目", preview: "", cwd: "C:/dev/app" }] };
    }
    if (command === "send_chat_board_task") return { threadId: "session-a", saved: false, draftOpened: true };
    return native(command, args);
  });
  await render();
  const card = container.querySelector(".ci-todo .ci-task")!;
  await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="沿用之前对话 整理接口文档"]')!.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="选择 Codex 对话"]')!;
  const thread = dialog.querySelector<HTMLInputElement>('input[type="radio"]')!;
  await act(async () => thread.click());
  await act(async () => dialog.querySelector<HTMLButtonElement>(".ci-thread-actions button:last-child")!.click());
  expect(invoke).toHaveBeenCalledWith("send_chat_board_task", { noteId: 1, threadId: "session-a", projectId: "app" });
  expect(dialog.isConnected).toBe(false);
  expect(container.querySelector(".ci-todo .ci-task")).toBe(card);
  expect(card.querySelector('[role="status"]')?.textContent).toBe("已准备草稿，请在 Codex 中发送。");
});
it("filters with preset and inclusive custom sync dates and resets project counts", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(insightSources[0].syncedAt!));
  mockRecords(); await render();
  const picker = filterTrigger("同步日期范围");
  const pick = async (label: string) => {
    await act(async () => picker.click());
    await act(async () => filterOptions(picker).find(({ textContent }) => textContent === label)!.click());
  };
  const titles = () => [...container.querySelectorAll(".ci-task-open strong")].map(({ textContent }) => textContent);
  await pick("今天"); expect(titles()).toEqual(["整理接口文档"]);
  await pick("近 7 天"); expect(titles()).toEqual(["整理接口文档", "登录功能"]);
  await pick("近 30 天"); expect(titles()).toHaveLength(3);
  await pick("自定义日期");
  const [start, end] = [...container.querySelectorAll<HTMLInputElement>('.ci-date-range input')];
  const setDate = (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const loginDay = localDateKey(new Date(insightSources[2].syncedAt!));
  await setDate(start, loginDay);
  await setDate(end, loginDay);
  expect(titles()).toEqual(["登录功能"]);
  expect(container.querySelector(".ci-project-select small")?.textContent).toBe("1 项");
  await setDate(start, "2026-12-01");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("开始日期不能晚于结束日期");
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "清除筛选")!.click());
  expect(picker.textContent).toBe("全部日期");
  expect(titles()).toHaveLength(3);
});
it("shows tasks by status without drag controls", async () => {
  const completedAt = new Date(2026, 10, 19, 14, 5).toISOString();
  mockRecords(); await render(undefined, completedAt);
  expect(container.querySelector(".ci-todo .ci-task-open strong")?.textContent).toBe("整理接口文档");
  expect(container.querySelector(".ci-doing .ci-task-open strong")?.textContent).toBe("登录功能");
  expect(container.querySelector(".ci-completed .ci-task-open strong")?.textContent).toBe("看板设计");
  const completion = container.querySelector<HTMLTimeElement>(".ci-completed .ci-task time");
  expect(completion?.dateTime).toBe(completedAt);
  expect(completion?.textContent).toBe("11-19 14:05");
  expect(completion?.title).toBe("完成于 2026-11-19 14:05");
  expect(container.querySelector('.ci-task [aria-label^="拖动事项"]')).toBeNull();
});
it("filters tasks by text and provides a reset when nothing matches", async () => {
  mockRecords(); await render();
  const search = container.querySelector<HTMLInputElement>('[aria-label="搜索对话事项"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "不存在");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelectorAll(".ci-task")).toHaveLength(0);
  expect(container.textContent).toContain("没有匹配的事项");
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "清除筛选")!.click());
  expect(container.querySelectorAll(".ci-task")).toHaveLength(3);
});
it("only edits the title and notes of a completed item and keeps its status and evidence", async () => {
  mockRecords(); const { onEdit } = await render();
  const edit = container.querySelector<HTMLButtonElement>('[aria-label="编辑事项 看板设计"]')!;
  await act(async () => edit.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="编辑事项"]')!;
  const title = dialog.querySelector<HTMLTextAreaElement>('[aria-label="事项标题"]')!;
  expect(title.value).toBe("看板设计");
  expect(document.activeElement).toBe(title);
  expect(dialog.querySelector(".markdown-editor-toolbar")?.textContent).toBe("备注");
  expect(dialog.textContent).not.toMatch(/所属分类|优先级|事项时间|重复方式|编辑范围|提醒/);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, "完成看板设计评审");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = dialog.querySelector<HTMLButtonElement>(".note-edit-actions button:last-child")!;
  onEdit.mockResolvedValueOnce(false);
  await act(async () => save.click());
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("保存失败");
  expect(title.value).toBe("完成看板设计评审");
  await act(async () => save.click());
  expect(onEdit).toHaveBeenLastCalledWith(3, { title: "完成看板设计评审", details: "" });
  expect(document.querySelector(".ci-editor-dialog")).toBeNull();
  expect(document.activeElement).toBe(edit);

  const completed = container.querySelector<HTMLElement>('[data-status="completed"]')!;
  expect(completed.querySelector(".ci-task-open strong")?.textContent).toBe("完成看板设计评审");
  const open = completed.querySelector<HTMLButtonElement>(".ci-task-open")!;
  await act(async () => open.click());
  const reopenedEditor = document.querySelector(".ci-editor-dialog")!;
  const reopened = reopenedEditor.querySelector<HTMLTextAreaElement>('[aria-label="事项标题"]')!;
  expect(reopened.value).toBe("完成看板设计评审");
  expect(reopenedEditor.querySelector("blockquote")?.textContent).toBe("已经完成看板设计");
  await act(async () => reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(reopenedEditor.isConnected).toBe(false);
  expect(document.activeElement).toBe(open);
  expect(onEdit).toHaveBeenCalledTimes(2);
});
it("polls while open and stops polling after unmount", async () => {
  vi.useFakeTimers(); mockRecords(); await render();
  expect(invoke).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(invoke).toHaveBeenCalledTimes(6);
  await act(async () => root.unmount());
  await vi.advanceTimersByTimeAsync(8000);
  expect(invoke).toHaveBeenCalledTimes(6);
});
it("shows failures and a retry instead of presenting a successful empty board", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("读取失败")); await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("读取失败");
  expect(container.querySelectorAll(".ci-metric")).toHaveLength(0);
  mockRecords();
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "重试")!.click());
  expect(container.querySelectorAll(".ci-task")).toHaveLength(3);
});

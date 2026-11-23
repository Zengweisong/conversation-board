// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDatabase } from "./database";
import { ReminderService } from "./reminderService";

const database = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  onAction: vi.fn().mockRejectedValue("Command registerListener not found")
}));
vi.mock("./database", () => ({ getDatabase: vi.fn().mockResolvedValue(database) }));

afterEach(() => {
  ReminderService.dispose();
  vi.unstubAllGlobals();
});

it("restores due reminders on Windows using its native notification action event", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  database.select.mockResolvedValueOnce([{
    id: 4,
    title: "待提醒事项",
    details: null,
    category_name: null,
    scheduled_at: null,
    scheduled_date: null,
    scheduled_time: null,
    repeat_series_id: null,
    reminder_at: "2026-01-01T00:00:00.000Z"
  }]).mockResolvedValueOnce([]);
  database.execute.mockResolvedValue({ rowsAffected: 1 });

  await expect(ReminderService.restorePendingReminders()).resolves.toBe(1);
  await expect(ReminderService.restorePendingReminders()).resolves.toBe(0);
  expect(getDatabase).toHaveBeenCalledTimes(2);
  expect(listen).toHaveBeenCalledOnce();
  expect(listen).toHaveBeenCalledWith("notification-activated", expect.any(Function));
  expect(invoke).toHaveBeenCalledWith("show_reminder_notification", expect.objectContaining({ noteId: 4 }));

  ReminderService.dispose();
  expect(unlisten).toHaveBeenCalledOnce();
});

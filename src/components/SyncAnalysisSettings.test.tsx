// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SyncAnalysisSettings } from "./SyncAnalysisSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("requires a saved API configuration and turns naming off when it is cleared", async () => {
  const config = { endpoint: "https://example.com/v1", model: "test-model", namingEnabled: false };
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(config)
    .mockResolvedValueOnce({ ...config, namingEnabled: true })
    .mockResolvedValueOnce(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SyncAnalysisSettings />));
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    const form = container.querySelector("form")!;
    const fields = [config.endpoint, config.model, "test-key"];
    form.querySelectorAll("input").forEach((input, index) => { input.value = fields[index]; });
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(invoke).toHaveBeenCalledWith("save_sync_analysis_config", {
      endpoint: config.endpoint, model: config.model, apiKey: "test-key"
    });
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).not.toContain("新建事项的提示词");
    await act(async () => toggle.click());
    expect(invoke).toHaveBeenLastCalledWith("set_ai_card_naming", { enabled: true });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => container.querySelector<HTMLButtonElement>("form button[type=button]")!.click());
    expect(invoke).toHaveBeenLastCalledWith("clear_sync_analysis_config");
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.resetAllMocks();
  }
});

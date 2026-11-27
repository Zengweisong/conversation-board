import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Gauge, Minus, Moon, PanelLeftClose, PanelLeftOpen, Settings, Square, X } from "lucide-react";
import { ChatSyncSettings } from "./components/ChatSyncSettings";
import { SyncAnalysisSettings } from "./components/SyncAnalysisSettings";
import { ConversationDashboard } from "./components/ConversationDashboard";
import { SelectField, type SelectOption } from "./components/SelectField";
import { ThemeColorPicker } from "./components/ThemeColorPicker";
import { useCategories } from "./hooks/useCategories";
import { useNotes } from "./hooks/useNotes";
import { startBackgroundTaskService } from "./services/backgroundTaskService";
import { loadSettings, saveAppearance, saveCloseAction, saveCodexQuotaVisibility } from "./services/settingsService";
import { themeColorStyle } from "./services/themeColor";
import type { AppearanceSettings, AppSettings, CloseAction } from "./types/settings";
import "./styles.css";
import "./window.css";

const closeActionOptions: readonly SelectOption<CloseAction>[] = [
  { value: "ask", label: "每次询问" },
  { value: "minimize", label: "最小化到托盘" },
  { value: "quit", label: "直接关闭" }
];

function ConversationBoardApp() {
  const [error, setError] = useState("");
  const [appearance, setAppearance] = useState<AppSettings | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const [themeError, setThemeError] = useState("");
  const [quotaBusy, setQuotaBusy] = useState(false);
  const [quotaError, setQuotaError] = useState("");
  const [themeColorDraft, setThemeColorDraft] = useState<string | null>();
  const [settingsSession, setSettingsSession] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState("");
  const [closeSettingsError, setCloseSettingsError] = useState("");
  const settings = useRef<HTMLDialogElement>(null);
  const closeDialog = useRef<HTMLDialogElement>(null);
  const rememberChoice = useRef<HTMLInputElement>(null);
  const closeAction = useRef<CloseAction>("ask");
  const settingsRevision = useRef(0);
  const closeInFlight = useRef(false);
  const saveDraftBeforeClose = useRef<(() => Promise<boolean>) | null>(null);
  const notes = useNotes(setError);
  const categories = useCategories(setError);
  const refresh = useCallback(async () => {
    await Promise.all([notes.refresh(), categories.refresh()]);
  }, [notes.refresh, categories.refresh]);
  useEffect(() => startBackgroundTaskService(refresh, setError), [refresh]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let current = 0;
    let disposed = false;
    const updateWindowShape = async () => {
      const revision = ++current;
      const maximized = await appWindow.isMaximized();
      if (!disposed && revision === current) {
        document.documentElement.classList.toggle("ci-window-maximized", maximized);
      }
    };
    const refreshWindowShape = () => { void updateWindowShape().catch(() => undefined); };
    const unlisten = appWindow.onResized(refreshWindowShape);
    refreshWindowShape();
    return () => {
      disposed = true;
      void unlisten.then((remove) => remove(), () => undefined);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const readAppearance = async () => {
      const revision = settingsRevision.current;
      const settings = await loadSettings();
      if (disposed || revision !== settingsRevision.current) return;
      closeAction.current = settings.closeAction;
      setAppearance(settings);
    };
    void readAppearance();
    window.addEventListener("focus", readAppearance);
    return () => {
      disposed = true;
      window.removeEventListener("focus", readAppearance);
    };
  }, []);

  const updateCloseAction = useCallback(async (action: CloseAction) => {
    await saveCloseAction(action);
    settingsRevision.current++;
    closeAction.current = action;
    setAppearance((current) => current && { ...current, closeAction: action });
  }, []);

  const executeClose = useCallback(async (action: Exclude<CloseAction, "ask">, remember = false, fromTray = false) => {
    if (closeInFlight.current) return;
    closeInFlight.current = true;
    setCloseBusy(true);
    setCloseError("");
    try {
      if (await saveDraftBeforeClose.current?.() === false) {
        throw new Error("有事项尚未保存，请返回看板检查后重试。");
      }
      if (remember) await updateCloseAction(action);
      const appWindow = getCurrentWindow();
      if (action === "minimize") {
        await appWindow.hide();
        closeDialog.current?.close();
      } else {
        await appWindow.destroy();
      }
    } catch (error) {
      (closeDialog.current?.open ? setCloseError : setError)(String(error instanceof Error ? error.message : error));
      if (fromTray) {
        const appWindow = getCurrentWindow();
        await appWindow.show().then(() => appWindow.unminimize()).then(() => appWindow.setFocus()).catch(() => undefined);
      }
    } finally {
      closeInFlight.current = false;
      setCloseBusy(false);
    }
  }, [updateCloseAction]);

  const requestClose = useCallback(() => {
    if (closeInFlight.current || closeDialog.current?.open) return;
    if (closeAction.current === "ask") {
      setCloseError("");
      if (rememberChoice.current) rememberChoice.current.checked = false;
      closeDialog.current?.showModal();
    } else {
      void executeClose(closeAction.current);
    }
  }, [executeClose]);

  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      requestClose();
    });
    const unlistenTray = listen("tray-quit-requested", () => void executeClose("quit", false, true));
    const listeners = [unlisten, unlistenTray];
    for (const listener of listeners) void listener.catch((error) => setError(String(error)));
    return () => {
      for (const listener of listeners) void listener.then((remove) => remove(), () => undefined);
    };
  }, [executeClose, requestClose]);

  useEffect(() => {
    let disposed = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        await invoke("refresh_chat_board_dispatches").catch(() => undefined);
        if (!disposed) await refresh();
      } finally {
        busy = false;
      }
    };
    void refresh();
    void poll();
    const resume = () => void poll();
    const timer = window.setInterval(resume, 4000);
    window.addEventListener("focus", resume);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
    };
  }, [refresh]);

  if (!appearance) return null;

  const appWindow = getCurrentWindow();
  const openSettings = () => {
    setThemeError("");
    setQuotaError("");
    setThemeColorDraft(undefined);
    setCloseSettingsError("");
    setSettingsSession((session) => session + 1);
    settings.current?.showModal();
  };
  const sidebarAction = sidebarCollapsed ? "展开侧边栏" : "收起侧边栏";
  const { darkMode, themeColor: savedColor, savedThemeColors } = appearance;
  const themeColor = themeColorDraft === undefined ? savedColor : themeColorDraft;
  function runWindowAction(action: Promise<void>) {
    void action.catch((error) => setError(String(error)));
  }

  async function updateAppearance(next: AppearanceSettings) {
    setThemeBusy(true);
    setThemeError("");
    try {
      await saveAppearance(next);
      settingsRevision.current++;
      setAppearance((current) => current && { ...current, ...next });
      return true;
    } catch (error) {
      setThemeError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setThemeBusy(false);
    }
  }

  async function applyThemeColor(color: string | null) {
    const colors = color && !savedThemeColors.includes(color) ? [color, ...savedThemeColors] : savedThemeColors;
    if ((color === savedColor && colors === savedThemeColors)
      || await updateAppearance({ darkMode, themeColor: color, savedThemeColors: colors })) {
      setThemeColorDraft(undefined);
    }
  }

  async function toggleCodexQuota() {
    if (!appearance || quotaBusy) return;
    const showCodexQuota = !appearance.showCodexQuota;
    setQuotaBusy(true);
    setQuotaError("");
    try {
      await saveCodexQuotaVisibility(showCodexQuota);
      settingsRevision.current++;
      setAppearance((current) => current && { ...current, showCodexQuota });
    } catch {
      setQuotaError("保存 Codex 额度显示设置失败，请重试");
    } finally {
      setQuotaBusy(false);
    }
  }

  async function updateSavedTheme(original: string, replacement: string | null) {
    if (!savedThemeColors.includes(original)) return false;
    const colors = replacement === null
      ? savedThemeColors.filter((color) => color !== original)
      : [...new Set(savedThemeColors.map((color) => color === original ? replacement : color))];
    const saved = await updateAppearance({
      darkMode, themeColor: savedColor === original ? replacement : savedColor, savedThemeColors: colors
    });
    if (saved && (replacement !== null || savedColor === original)) setThemeColorDraft(undefined);
    return saved;
  }

  async function changeCloseAction(action: CloseAction) {
    if (closeInFlight.current) return;
    closeInFlight.current = true;
    setCloseBusy(true);
    setCloseSettingsError("");
    try {
      await updateCloseAction(action);
    } catch (error) {
      setCloseSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      closeInFlight.current = false;
      setCloseBusy(false);
    }
  }

  return <main className={`app-shell view-insights ${darkMode ? "theme-dark" : "theme-light"} font-size-${appearance.fontSize} ${appearance.minimalMode ? "minimal-mode" : ""}`}
    style={{ display: "flex", flexDirection: "column", padding: 0, ...themeColorStyle(themeColor, darkMode) }}>
    <header className="ci-window-bar" data-tauri-drag-region>
      <button type="button" className="ci-sidebar-toggle" aria-label={sidebarAction} title={sidebarAction}
        aria-expanded={!sidebarCollapsed} aria-controls="ci-project-sidebar"
        onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>
        {sidebarCollapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
      </button>
      <button type="button" className="ci-window-settings" aria-label="设置" title="设置"
        aria-haspopup="dialog" aria-controls="ci-settings-dialog" onClick={openSettings}>
        <Settings size={15} aria-hidden="true" />
      </button>
      <button type="button" aria-label="最小化到托盘" title="最小化到托盘" onClick={() => runWindowAction(appWindow.hide())}><Minus size={16} /></button>
      <button type="button" aria-label="最大化或还原" title="最大化或还原" onClick={() => runWindowAction(appWindow.toggleMaximize())}><Square size={13} /></button>
      <button type="button" className="ci-window-close" aria-label="关闭窗口" title="关闭窗口"
        data-window-close-control onClick={requestClose}><X size={17} /></button>
    </header>
    <div className="content-viewport" style={{ flex: 1 }}>
      <ConversationDashboard notes={notes.notes} categories={categories.categories}
        sidebarCollapsed={sidebarCollapsed} showCodexQuota={appearance.showCodexQuota} onNotesChanged={refresh}
        appAlert={error && <div className="ci-error" role="alert">
          {error} <button type="button" onClick={() => setError("")}>关闭提示</button>
        </div>}
        onEdit={notes.editContent} saveDraftBeforeClose={saveDraftBeforeClose} />
    </div>
    <dialog id="ci-settings-dialog" ref={settings} aria-label="设置" onClose={() => setThemeColorDraft(undefined)}>
      <div className="ci-setting-field">
        <div className="ci-settings-heading">
          <span>外观</span>
          <form method="dialog">
            <button type="submit" className="ci-settings-close" aria-label="关闭设置" title="关闭设置">
              <X size={16} aria-hidden="true" />
            </button>
          </form>
        </div>
        <div className="ci-theme-mode">
          <Moon size={15} aria-hidden="true" />
          <span id="ci-dark-mode-label">深色模式</span>
          <button type="button" role="switch" className="chat-sync-switch" aria-labelledby="ci-dark-mode-label"
            aria-checked={darkMode} disabled={themeBusy}
            onClick={() => void updateAppearance({ darkMode: !darkMode, themeColor: savedColor, savedThemeColors })}><span /></button>
        </div>
        <div className="ci-theme-mode">
          <Gauge size={15} aria-hidden="true" />
          <span id="ci-codex-quota-label">显示 Codex 额度</span>
          <button type="button" role="switch" className="chat-sync-switch" aria-labelledby="ci-codex-quota-label"
            aria-checked={appearance.showCodexQuota} disabled={quotaBusy}
            onClick={() => void toggleCodexQuota()}><span /></button>
        </div>
        {quotaError && <p className="chat-sync-error" role="alert">{quotaError}</p>}
        <ThemeColorPicker key={settingsSession} color={themeColor} savedColor={savedColor}
          savedThemeColors={savedThemeColors} busy={themeBusy} onPreview={setThemeColorDraft}
          onCancelPreview={() => setThemeColorDraft(undefined)}
          onSave={() => void applyThemeColor(themeColor)} onUseSaved={(color) => void applyThemeColor(color)}
          onUpdateSaved={updateSavedTheme} />
        {themeError && <p className="chat-sync-error" role="alert">{themeError}</p>}
      </div>
      <ChatSyncSettings />
      <SyncAnalysisSettings />
      <div className="ci-setting-field">
        <label htmlFor="ci-close-action">关闭窗口时</label>
        <SelectField id="ci-close-action" label="关闭窗口时" variant="form" inline value={appearance.closeAction}
          options={closeActionOptions} disabled={closeBusy} onChange={(action) => void changeCloseAction(action)} />
        {closeSettingsError && <p className="chat-sync-error" role="alert">{closeSettingsError}</p>}
      </div>
    </dialog>
    <dialog ref={closeDialog} className="confirm-dialog window-close-dialog ci-close-dialog"
      data-window-close-control aria-labelledby="ci-close-title" aria-describedby="ci-close-message"
      onCancel={(event) => { if (closeInFlight.current) event.preventDefault(); }}>
      <h3 id="ci-close-title">关闭对话看板</h3>
      <p id="ci-close-message">要最小化到托盘，还是退出对话看板？</p>
      <label className="ci-remember-close"><input type="checkbox" ref={rememberChoice} disabled={closeBusy} />记住我的选择</label>
      {closeError && <p className="chat-sync-error" role="alert">{closeError}</p>}
      <form method="dialog" className="dialog-actions">
        <button type="submit" disabled={closeBusy}>取消</button>
        <button type="button" disabled={closeBusy} onClick={() => void executeClose("minimize", rememberChoice.current?.checked)}>最小化到托盘</button>
        <button type="button" className="danger" disabled={closeBusy} onClick={() => void executeClose("quit", rememberChoice.current?.checked)}>直接关闭</button>
      </form>
    </dialog>
  </main>;
}

document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

ReactDOM.createRoot(document.getElementById("root")!).render(<ConversationBoardApp />);

import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, PanelLeftClose, PanelLeftOpen, Settings, Square, X } from "lucide-react";
import { ChatSyncSettings } from "./components/ChatSyncSettings";
import { SyncAnalysisSettings } from "./components/SyncAnalysisSettings";
import { ConversationDashboard } from "./components/ConversationDashboard";
import { SelectField, type SelectOption } from "./components/SelectField";
import { useCategories } from "./hooks/useCategories";
import { useNotes } from "./hooks/useNotes";
import { startBackgroundTaskService } from "./services/backgroundTaskService";
import { loadSettings, saveCloseAction, saveTheme } from "./services/settingsService";
import type { AppSettings, CloseAction, ThemeName } from "./types/settings";
import "./styles.css";
import "./window.css";

const themeOptions: readonly SelectOption<ThemeName>[] = [
  { value: "warm", label: "暖色", swatch: "#eeebe4" },
  { value: "light", label: "浅色", swatch: "#e8eef6" },
  { value: "dark", label: "深色", swatch: "#292e37" },
  { value: "green", label: "墨绿色", swatch: "#3b5143" }
];

const closeActionOptions: readonly SelectOption<CloseAction>[] = [
  { value: "ask", label: "每次询问" },
  { value: "minimize", label: "最小化到任务栏" },
  { value: "quit", label: "直接关闭" }
];

function ConversationBoardApp() {
  const [error, setError] = useState("");
  const [appearance, setAppearance] = useState<AppSettings | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const [themeError, setThemeError] = useState("");
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

  const executeClose = useCallback(async (action: Exclude<CloseAction, "ask">, remember = false) => {
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
        await appWindow.minimize();
        closeDialog.current?.close();
      } else {
        await appWindow.destroy();
      }
    } catch (error) {
      (closeDialog.current?.open ? setCloseError : setError)(String(error instanceof Error ? error.message : error));
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
    void unlisten.catch((error) => setError(String(error)));
    return () => { void unlisten.then((remove) => remove(), () => undefined); };
  }, [requestClose]);

  useEffect(() => {
    let disposed = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        await Promise.allSettled([invoke("process_chat_sync"), invoke("refresh_chat_board_dispatches")]);
        if (!disposed) await refresh();
      } finally {
        busy = false;
      }
    };
    void refresh();
    void poll();
    const timer = window.setInterval(() => void poll(), 4000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (!appearance) return null;

  const appWindow = getCurrentWindow();
  const openSettings = () => {
    setThemeError("");
    setCloseSettingsError("");
    settings.current?.showModal();
  };
  const sidebarAction = sidebarCollapsed ? "展开侧边栏" : "收起侧边栏";
  function runWindowAction(action: Promise<void>) {
    void action.catch((error) => setError(String(error)));
  }

  async function changeTheme(theme: ThemeName) {
    setThemeBusy(true);
    setThemeError("");
    try {
      await saveTheme(theme);
      settingsRevision.current++;
      setAppearance((current) => current && { ...current, theme });
    } catch (error) {
      setThemeError(error instanceof Error ? error.message : String(error));
    } finally {
      setThemeBusy(false);
    }
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

  return <main className={`app-shell view-insights theme-${appearance.theme} font-size-${appearance.fontSize} ${appearance.minimalMode ? "minimal-mode" : ""}`}
    style={{ display: "flex", flexDirection: "column", padding: 0, background: "rgb(var(--panel-rgb))" }}>
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
      <button type="button" aria-label="最小化" title="最小化" onClick={() => runWindowAction(appWindow.minimize())}><Minus size={16} /></button>
      <button type="button" aria-label="最大化或还原" title="最大化或还原" onClick={() => runWindowAction(appWindow.toggleMaximize())}><Square size={13} /></button>
      <button type="button" className="ci-window-close" aria-label="关闭窗口" title="关闭窗口"
        data-window-close-control onClick={requestClose}><X size={17} /></button>
    </header>
    <div className="content-viewport" style={{ flex: 1 }}>
      <ConversationDashboard notes={notes.notes} categories={categories.categories}
        sidebarCollapsed={sidebarCollapsed} onNotesChanged={refresh}
        appAlert={error && <div className="ci-error" role="alert">
          {error} <button type="button" onClick={() => setError("")}>关闭提示</button>
        </div>}
        onEdit={notes.editContent} saveDraftBeforeClose={saveDraftBeforeClose} />
    </div>
    <dialog id="ci-settings-dialog" ref={settings} aria-label="设置"
      style={{ width: "min(420px, calc(100% - 32px))", border: "1px solid var(--border)", borderRadius: 12,
        padding: 20, background: "rgb(var(--card-rgb))", color: "var(--text)" }}>
      <div className="ci-setting-field">
        <label htmlFor="ci-theme">主题</label>
        <SelectField id="ci-theme" label="主题" variant="form" value={appearance.theme}
          options={themeOptions} disabled={themeBusy} onChange={(theme) => void changeTheme(theme)} />
        {themeError && <p className="chat-sync-error" role="alert">{themeError}</p>}
      </div>
      <ChatSyncSettings onChanged={refresh} />
      <SyncAnalysisSettings />
      <div className="ci-setting-field">
        <label htmlFor="ci-close-action">关闭窗口时</label>
        <SelectField id="ci-close-action" label="关闭窗口时" variant="form" value={appearance.closeAction}
          options={closeActionOptions} disabled={closeBusy} onChange={(action) => void changeCloseAction(action)} />
        {closeSettingsError && <p className="chat-sync-error" role="alert">{closeSettingsError}</p>}
      </div>
      <form method="dialog"><button type="submit">关闭</button></form>
    </dialog>
    <dialog ref={closeDialog} className="confirm-dialog window-close-dialog ci-close-dialog"
      data-window-close-control aria-labelledby="ci-close-title" aria-describedby="ci-close-message"
      onCancel={(event) => { if (closeInFlight.current) event.preventDefault(); }}>
      <h3 id="ci-close-title">关闭对话看板</h3>
      <p id="ci-close-message">要最小化到任务栏，还是退出对话看板？</p>
      <label className="ci-remember-close"><input type="checkbox" ref={rememberChoice} disabled={closeBusy} />记住我的选择</label>
      {closeError && <p className="chat-sync-error" role="alert">{closeError}</p>}
      <form method="dialog" className="dialog-actions">
        <button type="submit" disabled={closeBusy}>取消</button>
        <button type="button" disabled={closeBusy} onClick={() => void executeClose("minimize", rememberChoice.current?.checked)}>最小化</button>
        <button type="button" className="danger" disabled={closeBusy} onClick={() => void executeClose("quit", rememberChoice.current?.checked)}>直接关闭</button>
      </form>
    </dialog>
  </main>;
}

document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

ReactDOM.createRoot(document.getElementById("root")!).render(<ConversationBoardApp />);

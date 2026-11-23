import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, RefreshCw, RotateCcw } from "lucide-react";

interface Status {
  enabled: boolean; pending: number; failed: number; lastError: string | null;
  recent: string[]; canUndo: boolean;
  lastAnalysis: { processedAt: string; project: string | null; changed: number } | null;
}
const analysisTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium", hour12: false });

export function ChatSyncSettings({ onChanged }: { onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const refresh = async () => {
    const result = await invoke<Status>("get_chat_sync_status");
    setStatus(result);
  };
  useEffect(() => {
    let disposed = false;
    const read = () => { void invoke<Status>("get_chat_sync_status").then((value) => {
      if (!disposed) setStatus(value);
    }).catch((error) => { if (!disposed) setError(String(error)); }); };
    read();
    const timer = window.setInterval(read, 4000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); await refresh(); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  const lastAnalysis = status?.lastAnalysis;
  return <section className="setting-block chat-sync-settings" aria-labelledby="chat-sync-title">
    <div className="chat-sync-heading">
      <div className="chat-sync-label"><span id="chat-sync-title">对话同步</span>
        <span className="chat-sync-state" role="status">{busy ? "处理中…" : !status ? "加载中…" : status.enabled ? "已开启" : "未开启"}</span>
      </div>
      <button className="chat-sync-switch" type="button" role="switch" aria-checked={status?.enabled ?? false}
        aria-labelledby="chat-sync-title" title="代码改动在本机记录。明确要求记待办或提醒时才使用 AI 服务"
        disabled={busy || !status} onClick={() => void run(async () => {
          const enabled = !status?.enabled;
          await invoke("configure_chat_sync", { enabled });
          setNeedsRestart(enabled);
        })}>
        <span />
      </button>
    </div>
    {needsRestart && <p className="chat-sync-hint" role="status">请重启聊天客户端以完成连接</p>}
    {lastAnalysis ? <p className="chat-sync-hint">
      最近分析 · <time dateTime={lastAnalysis.processedAt}>{analysisTime.format(new Date(lastAnalysis.processedAt))}</time>
      {lastAnalysis.project && <> · {lastAnalysis.project}</>}
      {" · "}{lastAnalysis.changed ? `本轮更新 ${lastAnalysis.changed} 项` : "本轮无事项变更"}
    </p> : status?.enabled && <p className="chat-sync-hint">下一轮对话分析后显示时间和结果</p>}
    {status && (status.canUndo || status.failed > 0) && <div className="chat-sync-actions">
      {status?.canUndo && <button type="button" disabled={busy} onClick={() => void run(async () => {
        await invoke("undo_chat_sync"); await onChanged();
      })}><RotateCcw size={14} aria-hidden="true" />撤销上次同步</button>}
      {!!status?.failed && <button type="button" disabled={busy} onClick={() => void run(() => invoke("retry_chat_sync"))}><RefreshCw size={14} aria-hidden="true" />重试失败对话<span className="chat-sync-count">{status.failed}</span></button>}
    </div>}
    {!!status?.pending && <p className="chat-sync-hint" role="status">{status.pending} 轮待同步</p>}
    {(error || status?.lastError) && <p className="chat-sync-error" role="alert">{error || status?.lastError}</p>}
    {!!status?.recent.length && <details className="chat-sync-history"><summary><ChevronRight size={14} aria-hidden="true" /><span>最近事项依据</span><span className="chat-sync-count">{status.recent.length}</span></summary><ul>{status.recent.map((text, index) => <li key={index}>{text}</li>)}</ul></details>}
  </section>;
}

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, Check, ChevronDown, CircleAlert, Clock3, Folder, MessagesSquare, Plus, Search, X } from "lucide-react";
import type { ChatTaskSource } from "../services/chatInsightsService";

interface Thread { id: string; name: string | null; preview: string; cwd: string; }
interface ThreadPage { data: Thread[]; nextCursor: string | null; }
interface Dispatch { threadId: string; saved: boolean; draftOpened?: boolean; }

export function sendConversationTask(noteId: number, threadId: string | null, projectId: string | null) {
  return invoke<Dispatch>("send_chat_board_task", { noteId, threadId, projectId });
}

export function conversationDispatchMessage(result: Dispatch) {
  if (result.draftOpened) return "已准备草稿，请在 Codex 中发送。";
  return result.saved ? "" : "已发送给 Codex，事项状态未能保存。";
}

interface Props {
  noteId: number;
  title: string;
  projectId: string | null;
  projectLabel?: string;
  preferredThreadId: string;
  disabled: boolean;
  canSend: boolean;
  dispatchState: ChatTaskSource["dispatchState"];
  onSent: () => Promise<void>;
}

export function ConversationTaskDispatch({ noteId, title, projectId, projectLabel, preferredThreadId, disabled, canSend, dispatchState, onSent }: Props) {
  const [choosing, setChoosing] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [openError, setOpenError] = useState("");
  const [lastThreadId, setLastThreadId] = useState("");
  const linkedThreadId = lastThreadId || preferredThreadId;
  const trigger = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!choosing && !sending && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [choosing, sending]);

  const openThread = async (threadId: string) => {
    setOpenError("");
    try {
      await invoke("open_chat_board_thread", { threadId });
    } catch (error) {
      setOpenError(String(error));
    }
  };

  const send = async (threadId: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true); setMessage(""); setError(""); setOpenError("");
    try {
      const result = await sendConversationTask(noteId, threadId, projectId);
      setLastThreadId(result.threadId);
      setMessage(conversationDispatchMessage(result));
      if (threadId) close();
      if (result.saved) void onSent();
    } catch (error) { setError(String(error)); }
    finally { inFlight.current = false; setSending(false); }
  };

  const close = () => {
    restoreFocus.current = true;
    setChoosing(false); setError("");
  };

  return <div className="ci-task-dispatch" ref={actions}>
    {dispatchState === "running" && <span className="ci-dispatch-state is-running" role="status"><Clock3 size={13} aria-hidden="true" />Codex 处理中</span>}
    {dispatchState === "failed" && <span className="ci-dispatch-state is-failed" role="status"><CircleAlert size={13} aria-hidden="true" />Codex 未完成</span>}
    {message && <small role="status">{message}</small>}
    <div className="ci-send-buttons" role="group" aria-label="Codex 对话">
      {canSend && <>
        <button type="button" className="ci-send-new" disabled={disabled || sending} title="发送给 Codex"
          aria-label={`开启新对话 ${title}`} onClick={() => void send(null)}><Plus size={13} aria-hidden="true" />{sending && !choosing ? "发送中…" : "开启新对话"}</button>
        <button type="button" ref={trigger} disabled={disabled || sending} title="发送给 Codex"
          aria-label={`沿用之前对话 ${title}`} onClick={() => { setError(""); setChoosing(true); }}>沿用之前对话</button>
      </>}
      {linkedThreadId && <button type="button" className="ci-view-thread" disabled={disabled || sending}
        aria-label={`在 Codex 中查看 ${title}`} onClick={() => void openThread(linkedThreadId)}>在 Codex 中查看<ArrowUpRight size={13} aria-hidden="true" /></button>}
    </div>
    {!choosing && error && <small className="ci-warning" role="alert">{error}</small>}
    {openError && <small className="ci-warning" role="alert">{openError}</small>}
    {choosing && createPortal(
      <CodexThreadPicker key={projectId} projectId={projectId} projectLabel={projectLabel}
        preferredId={linkedThreadId} sending={sending} sendError={error}
        onClose={close} onSend={(id) => void send(id)} />,
      actions.current?.closest(".app-shell") ?? document.body,
    )}
  </div>;
}

export function CodexThreadPicker({ projectId, projectLabel, preferredId, sending, sendError, onClose, onSend }: {
  projectId: string | null; projectLabel?: string;
  preferredId: string; sending: boolean; sendError: string;
  onClose: () => void; onSend: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const radioGroup = useId();
  const appliedSearch = useRef("");
  const readVersion = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  const read = async (value: string, nextCursor: string | null) => {
    const version = ++readVersion.current;
    setLoading(true); setError("");
    try {
      const page = await invoke<ThreadPage>("list_chat_board_threads", { search: value, cursor: nextCursor, projectId });
      if (version !== readVersion.current) return;
      appliedSearch.current = value;
      setThreads((current) => nextCursor ? [...current, ...page.data.filter((thread) => !current.some(({ id }) => id === thread.id))] : page.data);
      setCursor(page.nextCursor);
      if (!nextCursor) {
        setSelected(page.data.some(({ id }) => id === preferredId) ? preferredId : "");
        if (results.current) results.current.scrollTop = 0;
      }
    } catch (error) { if (version === readVersion.current) setError(String(error)); }
    finally { if (version === readVersion.current) setLoading(false); }
  };

  useEffect(() => {
    searchInput.current?.focus();
    void read("", null);
    return () => { readVersion.current++; };
  }, []);

  return <div className="dialog-backdrop board-detail-backdrop">
    <div className="board-detail-dialog ci-thread-dialog" role="dialog" aria-modal="true" aria-label="选择 Codex 对话"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); if (!sending) onClose(); }
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")]
          .filter((control) => control.tabIndex >= 0);
        const last = controls[controls.length - 1];
        const edge = event.shiftKey ? controls[0] : last;
        if (document.activeElement === edge) {
          event.preventDefault(); (event.shiftKey ? last : controls[0])?.focus();
        }
      }}>
      <header className="ci-thread-heading">
        <span className="ci-thread-heading-icon"><MessagesSquare size={19} aria-hidden="true" /></span>
        <div>
          <h2>沿用之前对话</h2>
          {projectLabel && <p className="ci-thread-scope" title={projectLabel}>项目 · {projectLabel}</p>}
        </div>
        <button type="button" className="ci-thread-close" disabled={sending} aria-label="关闭对话选择" onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <form className="ci-thread-search" onSubmit={(event) => { event.preventDefault(); void read(search.trim(), null); }}>
        <label className="ci-thread-search-field">
          <Search size={16} aria-hidden="true" />
          <input ref={searchInput} aria-label="搜索 Codex 对话" placeholder="搜索对话标题" value={search} disabled={sending}
            onChange={(event) => setSearch(event.target.value)} />
        </label>
        <button type="submit" disabled={loading || sending}>搜索</button>
      </form>
      <div className="ci-thread-results" ref={results}>
        {threads.length > 0 && <div className="ci-thread-list" role="radiogroup" aria-label="Codex 对话" aria-busy={loading}>
          {threads.map(({ id, name, preview, cwd }, index) => {
            const title = name || preview || "未命名对话";
            return <label className="ci-thread-choice" key={id}>
              <input type="radio" name={radioGroup} value={id} checked={selected === id} disabled={loading || sending}
                tabIndex={selected === id || (!selected && index === 0) ? 0 : -1}
                onChange={() => setSelected(id)} />
              <span className="ci-thread-choice-text">
                <span className="ci-thread-name" title={title}>{title}</span>
                {cwd && <span className="ci-thread-path" title={cwd}><Folder size={12} aria-hidden="true" /><span>{cwd}</span></span>}
              </span>
              <span className="ci-thread-indicator" aria-hidden="true"><Check size={12} strokeWidth={2.5} /></span>
            </label>;
          })}
        </div>}
        {loading && <p className="ci-thread-feedback" role="status">正在读取 Codex 对话…</p>}
        {error && <p className="ci-thread-feedback" role="alert">{error}</p>}
        {!threads.length && !loading && !error && <p className="ci-thread-feedback" role="status">
          {cursor ? "已读取的记录中暂无匹配对话，可继续加载。" :
            projectId ? "该项目没有匹配的对话。" : "没有找到可续接的对话。"}
        </p>}
        {cursor && <button className="ci-thread-more" type="button" disabled={loading || sending}
          onClick={() => void read(appliedSearch.current, cursor)}>加载更多<ChevronDown size={14} aria-hidden="true" /></button>}
      </div>
      <footer className="ci-thread-footer">
        {sendError && <p className="ci-thread-feedback" role="alert">{sendError}</p>}
        <div className="ci-thread-actions">
          <button type="button" disabled={sending} onClick={onClose}>取消</button>
          <button type="button" className="ci-thread-send" disabled={!selected || loading || sending}
            onClick={() => onSend(selected)}>{sending ? "发送中…" : "发送给 Codex"}<ArrowUpRight size={14} aria-hidden="true" /></button>
        </div>
      </footer>
    </div>
  </div>;
}

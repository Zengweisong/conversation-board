import { useEffect, useRef, useState } from "react";
import { ChevronDown, FolderClosed, Layers3, Pencil, RotateCcw, Star, X } from "lucide-react";
import type { CodexProject, ProjectSettings } from "../services/chatInsightsService";

interface Props {
  projects: CodexProject[];
  counts: ReadonlyMap<string, number>;
  descriptions: ReadonlyMap<string, string>;
  selected: string;
  trackedOnly: boolean;
  onSelect: (id: string) => void;
  onTrackedOnly: (enabled: boolean) => void;
  onSave: (id: string, settings: ProjectSettings) => Promise<void>;
  onSetHidden: (id: string, hidden: boolean) => Promise<void>;
}

export function ConversationProjects({ projects, counts, descriptions, selected, trackedOnly, onSelect, onTrackedOnly, onSave, onSetHidden }: Props) {
  const [editing, setEditing] = useState<{ id: string; displayName: string; tracked: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lastRemoved, setLastRemoved] = useState<string | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (lastRemoved) undoButton.current?.focus({ preventScroll: true }); }, [lastRemoved]);
  const active = projects.filter(({ hidden }) => !hidden);
  const removed = projects.filter(({ hidden }) => hidden);
  const undoTarget = removed.find(({ id }) => id === lastRemoved);
  const target = active.find(({ id }) => id === editing?.id);
  const visible = active.filter(({ settings }) => !trackedOnly || settings.tracked);
  async function changeVisibility(id: string, hidden: boolean) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSetHidden(id, hidden);
      if (editing?.id === id) setEditing(null);
      if (hidden || lastRemoved === id) setLastRemoved(hidden ? id : null);
    } catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  }
  return <section className="ci-projects" aria-label="Codex 项目">
    <header className="ci-projects-heading">
      <h2>Codex 项目 <span>{active.length}</span></h2>
      <button type="button" className="ci-project-filter" aria-pressed={trackedOnly}
        onClick={() => onTrackedOnly(!trackedOnly)}><Star size={14} />仅追踪</button>
    </header>
    {undoTarget && <div className="ci-project-undo">
      <span role="status">已移出「{undoTarget.settings.displayName ?? undoTarget.name}」</span>
      <button type="button" ref={undoButton} disabled={saving}
        onClick={() => void changeVisibility(undoTarget.id, false)}>撤销</button>
    </div>}
    <button type="button" className="ci-project-all" aria-pressed={selected === "all"}
      onClick={() => onSelect("all")}><Layers3 size={14} aria-hidden="true" />{trackedOnly ? "追踪的项目" : "所有项目"}</button>
    <ul className="ci-project-list">
      {visible.map(({ id, name, rootPaths, settings }) => {
        const label = settings.displayName ?? name;
        const description = descriptions.get(id);
        return <li key={id} className={selected === id ? "selected" : ""}>
          <button type="button" className="ci-project-select" aria-pressed={selected === id}
            aria-keyshortcuts="Delete" title={description ?? (rootPaths.join("\n") || name)}
            onClick={() => onSelect(selected === id ? "all" : id)}
            onKeyDown={(event) => {
              if (event.key !== "Delete" || event.repeat) return;
              event.preventDefault();
              void changeVisibility(id, true);
            }}>
            <span className="ci-project-icon">{settings.tracked
              ? <Star size={14} className="ci-tracked-star" aria-label="已追踪" />
              : <FolderClosed size={14} aria-hidden="true" />}</span>
            <span className="ci-project-label">{label}</span>
            <small>{counts.get(id) ?? 0} 项</small>
          </button>
          <div className="ci-project-row-actions">
            <button type="button" className="ci-project-edit" title="编辑项目"
              aria-label={`编辑项目 ${label}${description ? ` · ${description}` : ""}`} disabled={saving}
              onClick={() => {
                setError("");
                setEditing({ id, displayName: settings.displayName ?? "", tracked: settings.tracked });
              }}><Pencil size={13} /></button>
            <button type="button" className="ci-project-remove" title="移出看板"
              aria-label={`移出看板 ${label}${description ? ` · ${description}` : ""}`} disabled={saving}
              onClick={() => void changeVisibility(id, true)}><X size={15} /></button>
          </div>
        </li>;
      })}
    </ul>
    {!visible.length && <p className="ci-project-empty">{trackedOnly ? "暂无追踪项目" : "看板暂无项目"}</p>}
    {removed.length > 0 && <details className="ci-removed-projects">
      <summary><ChevronDown size={14} aria-hidden="true" />已移除 <span>{removed.length}</span></summary>
      <ul>{removed.map(({ id, name, rootPaths, settings }) => {
        const label = settings.displayName ?? name;
        const description = descriptions.get(id);
        return <li key={id}>
          <span className="ci-project-label" title={description ?? (rootPaths.join("\n") || undefined)}>{label}</span>
          <button type="button" aria-label={`恢复项目 ${label}${description ? ` · ${description}` : ""}`}
            disabled={saving} onClick={() => void changeVisibility(id, false)}><RotateCcw size={12} />恢复</button>
        </li>;
      })}</ul>
    </details>}
    {error && <p role="alert" className="ci-error">{error}</p>}
    {editing && target && <form className="ci-project-form" key={editing.id} aria-label={`编辑项目 ${target.name}`} onSubmit={async (event) => {
      event.preventDefault();
      if (saving) return;
      setSaving(true);
      setError("");
      try {
        await onSave(editing.id, { displayName: editing.displayName.trim() || null, tracked: editing.tracked });
        setEditing(null);
      } catch (error) { setError(String(error)); }
      finally { setSaving(false); }
    }}>
      <strong title={descriptions.get(target.id) ?? (target.rootPaths.join("\n") || undefined)}>编辑 {target.name}</strong>
      <label className="ci-project-name-field">显示名
        <input autoFocus placeholder={target.name} maxLength={100} value={editing.displayName} disabled={saving}
          onChange={(event) => setEditing({ ...editing, displayName: event.target.value })} />
      </label>
      <label className="ci-project-track-field"><input type="checkbox" checked={editing.tracked} disabled={saving}
        onChange={(event) => setEditing({ ...editing, tracked: event.target.checked })} />值得追踪</label>
      <div className="ci-project-form-actions">
        <button type="button" disabled={saving} onClick={() => setEditing(null)}>取消</button>
        <button type="submit" disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </form>}
  </section>;
}

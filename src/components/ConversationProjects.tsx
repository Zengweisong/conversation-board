import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Layers3, Pencil, Plus, RotateCcw, Star, X } from "lucide-react";
import type { CodexProject, ProjectSettings } from "../services/chatInsightsService";
import { SelectField } from "./SelectField";

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
  const [showUndo, setShowUndo] = useState(false);
  const undoButton = useRef<HTMLButtonElement>(null);
  const allProjectsButton = useRef<HTMLButtonElement>(null);
  const active = projects.filter(({ hidden }) => !hidden);
  const removed = projects.filter(({ hidden }) => hidden);
  const undoTarget = removed.find(({ id }) => id === lastRemoved);
  const undoTargetId = undoTarget?.id;
  const target = active.find(({ id }) => id === editing?.id);
  const visible = active.filter(({ settings }) => !trackedOnly || settings.tracked);
  const untracked = active.filter(({ settings }) => !settings.tracked);

  useEffect(() => {
    if (!showUndo || !undoTargetId) return;
    undoButton.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => {
      if (document.activeElement === undoButton.current) allProjectsButton.current?.focus({ preventScroll: true });
      setShowUndo(false);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [showUndo, undoTargetId]);
  async function saveSettings(id: string, settings: ProjectSettings) {
    if (saving) return false;
    setSaving(true);
    setError("");
    try {
      await onSave(id, settings);
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    } finally { setSaving(false); }
  }
  async function toggleTracking(id: string) {
    const project = active.find((item) => item.id === id);
    if (!project) return;
    const tracked = !project.settings.tracked;
    const trigger = document.activeElement;
    if (!await saveSettings(id, { ...project.settings, tracked })) return;
    setEditing((current) => current?.id === id ? { ...current, tracked } : current);
    if (trackedOnly && (!tracked || untracked.length === 1) && trigger instanceof HTMLButtonElement
      && (document.activeElement === trigger || document.activeElement === document.body)) {
      allProjectsButton.current?.focus({ preventScroll: true });
    }
  }
  const changeVisibility = useCallback(async (id: string, hidden: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSetHidden(id, hidden);
      setEditing((current) => current?.id === id ? null : current);
      if (hidden) {
        setLastRemoved(id);
        setShowUndo(true);
      } else {
        if (document.activeElement === undoButton.current) allProjectsButton.current?.focus({ preventScroll: true });
        setLastRemoved((current) => current === id ? null : current);
      }
    } catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  }, [onSetHidden, saving]);

  useEffect(() => {
    if (!undoTargetId || saving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.ctrlKey || event.shiftKey
        || event.altKey || event.metaKey || event.key.toLowerCase() !== "z") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role='textbox']"))) return;
      if (document.querySelector("dialog[open], [role='dialog'][aria-modal='true']")) return;
      event.preventDefault();
      void changeVisibility(undoTargetId, false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoTargetId, saving, changeVisibility]);

  return <section className="ci-projects" aria-label="Codex 项目">
    <header className="ci-projects-heading">
      <h2>Codex 项目 <span>{active.length}</span></h2>
      <button type="button" className="ci-project-filter" aria-pressed={trackedOnly}
        onClick={() => onTrackedOnly(!trackedOnly)}><Star size={14} />仅追踪</button>
    </header>
    {showUndo && undoTarget && <div className="ci-project-undo">
      <span role="status">已移出「{undoTarget.settings.displayName ?? undoTarget.name}」</span>
      <button type="button" ref={undoButton} disabled={saving} aria-keyshortcuts="Control+Z" title="撤销移出（Ctrl+Z）"
        onClick={() => void changeVisibility(undoTarget.id, false)}>撤销</button>
    </div>}
    <button type="button" className="ci-project-all" ref={allProjectsButton} aria-pressed={selected === "all"}
      onClick={() => onSelect("all")}><Layers3 size={14} aria-hidden="true" />{trackedOnly ? "追踪的项目" : "所有项目"}</button>
    <ul className="ci-project-list">
      {visible.map(({ id, name, rootPaths, settings }) => {
        const label = settings.displayName ?? name;
        const description = descriptions.get(id);
        const accessibleLabel = description ? `${label} · ${description}` : label;
        return <li key={id} className={selected === id ? "selected" : ""}>
          <button type="button" className="ci-project-track" title={settings.tracked ? "取消追踪" : "添加追踪"}
            aria-label={`追踪项目 ${accessibleLabel}`} aria-pressed={settings.tracked} aria-disabled={saving || undefined}
            onClick={() => void toggleTracking(id)}><Star size={14} aria-hidden="true" /></button>
          <button type="button" className="ci-project-select" aria-pressed={selected === id}
            aria-keyshortcuts="Delete" title={description ?? (rootPaths.join("\n") || name)}
            onClick={() => onSelect(selected === id ? "all" : id)}
            onKeyDown={(event) => {
              if (event.key !== "Delete" || event.repeat) return;
              event.preventDefault();
              void changeVisibility(id, true);
            }}>
            <span className="ci-project-label">{label}</span>
            <small>{counts.get(id) ?? 0} 项</small>
          </button>
          <div className="ci-project-row-actions">
            <button type="button" className="ci-project-edit" title="编辑项目"
              aria-label={`编辑项目 ${accessibleLabel}`} disabled={saving}
              onClick={() => {
                setError("");
                setEditing({ id, displayName: settings.displayName ?? "", tracked: settings.tracked });
              }}><Pencil size={13} /></button>
            <button type="button" className="ci-project-remove" title="移出看板"
              aria-label={`移出看板 ${accessibleLabel}`} disabled={saving}
              onClick={() => void changeVisibility(id, true)}><X size={15} /></button>
          </div>
        </li>;
      })}
    </ul>
    {!visible.length && <p className="ci-project-empty">{trackedOnly ? "暂无追踪项目" : "看板暂无项目"}</p>}
    {trackedOnly && untracked.length > 0 && <div className="ci-project-track-picker">
      <SelectField label="添加追踪项目" placeholder="添加追踪项目" variant="toolbar" value={null} disabled={saving}
        leadingIcon={<Plus size={14} />}
        options={untracked.map(({ id, name, settings }) => ({
          value: id, label: `${settings.displayName ?? name}${descriptions.has(id) ? ` · ${descriptions.get(id)}` : ""}`
        }))}
        onChange={(id) => void toggleTracking(id)} />
    </div>}
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
      if (await saveSettings(editing.id, { displayName: editing.displayName.trim() || null, tracked: editing.tracked })) setEditing(null);
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

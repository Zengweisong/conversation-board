import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AnalysisConfig { endpoint: string; model: string; namingEnabled: boolean }

export function SyncAnalysisSettings() {
  const [config, setConfig] = useState<AnalysisConfig | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void invoke<AnalysisConfig | null>("get_sync_analysis_config")
      .then(setConfig).catch((error) => setError(String(error)))
      .finally(() => setBusy(false));
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      setConfig(await invoke<AnalysisConfig>("save_sync_analysis_config", {
        endpoint: fields.get("endpoint"),
        model: fields.get("model"),
        apiKey: fields.get("apiKey")
      }));
      form.reset();
      setSaved(true);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await invoke("clear_sync_analysis_config");
      setConfig(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleNaming() {
    if (!config || busy) return;
    setBusy(true);
    setError("");
    try {
      setConfig(await invoke<AnalysisConfig>("set_ai_card_naming", { enabled: !config.namingEnabled }));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="chat-sync-settings ci-ai-naming-settings" aria-labelledby="ci-ai-naming-title">
    <div className="chat-sync-heading">
      <div className="chat-sync-label">
        <span id="ci-ai-naming-title">AI 智能命名</span>
        <span className="chat-sync-state" role="status">{config?.namingEnabled ? "已开启" : config ? "未开启" : "需配置 API"}</span>
      </div>
      <button className="chat-sync-switch" type="button" role="switch" aria-labelledby="ci-ai-naming-title"
        aria-describedby={config ? undefined : "ci-ai-naming-hint"} aria-checked={config?.namingEnabled ?? false}
        disabled={busy || !config} onClick={() => void toggleNaming()}><span /></button>
    </div>
    {!config && <p className="chat-sync-hint" id="ci-ai-naming-hint">保存 API 地址、模型和密钥后可开启。</p>}
    <details className="ci-analysis-settings">
      <summary>API 配置</summary>
      <p className="chat-sync-hint">对话中的待办和提醒提取也使用这项 API 配置。</p>
      <form key={JSON.stringify([config?.endpoint, config?.model])} onSubmit={save}>
        <label>API 地址<input name="endpoint" defaultValue={config?.endpoint} type="url" required /></label>
        <label>模型<input name="model" defaultValue={config?.model} required /></label>
        <label>API 密钥<input name="apiKey" type="password" autoComplete="off" required={!config}
          placeholder={config ? "留空沿用已保存的密钥" : undefined} /></label>
        <div className="chat-sync-actions">
          <button type="submit" disabled={busy}>保存配置</button>
          {config && <button type="button" disabled={busy} onClick={() => void clear()}>清除配置</button>}
        </div>
      </form>
      {saved && <p role="status">API 配置已保存</p>}
    </details>
    {error && <p className="chat-sync-error" role="alert">{error}</p>}
  </section>;
}

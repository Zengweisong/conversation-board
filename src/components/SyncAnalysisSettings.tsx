import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AnalysisConfig { endpoint: string; model: string }

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

  return <details className="ci-analysis-settings">
    <summary>AI 分析服务</summary>
    <p className="chat-sync-hint">明确要求从对话记录待办或提醒时，相关对话内容会发送到这里配置的服务。</p>
    <form key={JSON.stringify(config)} onSubmit={save}>
      <label>API 地址<input name="endpoint" defaultValue={config?.endpoint} type="url" required /></label>
      <label>模型<input name="model" defaultValue={config?.model} required /></label>
      <label>API 密钥<input name="apiKey" type="password" autoComplete="off" required={!config}
        placeholder={config ? "留空沿用已保存的密钥" : undefined} /></label>
      <div className="chat-sync-actions">
        <button type="submit" disabled={busy}>保存配置</button>
        {config && <button type="button" disabled={busy} onClick={() => void clear()}>清除配置</button>}
      </div>
    </form>
    {saved && <p role="status">AI 分析配置已保存</p>}
    {error && <p className="chat-sync-error" role="alert">{error}</p>}
  </details>;
}

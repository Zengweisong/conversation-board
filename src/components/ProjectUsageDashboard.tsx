import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowUpRight, CalendarDays, FolderClosed, Sparkles } from "lucide-react";
import { CalendarDatePicker } from "./CalendarDatePicker";
import { SelectField } from "./SelectField";
import { codeChangeEvidencePrefix, dateInRange, datePeriodOptions, dateRangeForPeriod, emptyDateRange,
  type ChatTask, type CodexProject, type CodexSessionUsage, type DatePeriod } from "../services/chatInsightsService";
import { localDateKey } from "../services/noteDateService";

const exact = new Intl.NumberFormat("zh-CN");
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const shareColor = (index: number) => {
  const mutedHue = `hsl(${(145 + index * 137.508) % 360} 14% ${index % 2 ? 58 : 46}%)`;
  return `color-mix(in oklab, var(--accent) 28%, ${mutedHue})`;
};

interface Props {
  projects: readonly CodexProject[];
  tasks: readonly ChatTask[];
  projectIds: ReadonlyMap<number, string>;
  initialProject: string;
  onBack: () => void;
  onSelect: (id: string) => void;
}

interface RequirementAnalysis {
  reviewedRequests: number;
  groups: { title: string; count: number; examples: string[] }[];
}

interface RequirementAnalysisState {
  projectId: string;
  result: RequirementAnalysis | null;
  busy: boolean;
  error: string;
}

function RequirementResults({ result, error }: Pick<RequirementAnalysisState, "result" | "error">) {
  return <section id="ci-repeated-analysis" className="ci-usage ci-analysis-result" aria-labelledby="ci-repeated-result-title">
    <h2 id="ci-repeated-result-title">重复需求分析结果</h2>
    {error && <p className="ci-usage-caption ci-warning" role="alert">{error}</p>}
    {result && <>
      <p className="ci-usage-caption" role="status">
        {result.reviewedRequests < 2 ? "可供分析的请求不足两条"
          : `已分析 ${exact.format(result.reviewedRequests)} 条近期请求${result.groups.length ? "" : "，未发现明显重复的需求"}`}
      </p>
      {result.groups.length > 0 && <ul className="ci-repeated-results">
        {result.groups.map(({ title, count, examples }) => <li key={title}>
          <details>
            <summary><span>{title}</span><strong>{exact.format(count)} 次</strong></summary>
            {examples.map((example) => <blockquote key={example}>{example}</blockquote>)}
          </details>
        </li>)}
      </ul>}
    </>}
  </section>;
}

export function ProjectUsageDashboard({ projects, tasks, projectIds, initialProject, onBack, onSelect }: Props) {
  const [day, setDay] = useState(() => localDateKey(new Date()));
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  const [radarProject, setRadarProject] = useState(initialProject);
  const [period, setPeriod] = useState<DatePeriod>("all");
  const [customDates, setCustomDates] = useState(emptyDateRange);
  const [usage, setUsage] = useState<CodexSessionUsage[] | null>(null);
  const [usageError, setUsageError] = useState("");
  const [analysis, setAnalysis] = useState<RequirementAnalysisState | null>(null);
  useEffect(() => {
    let active = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await invoke<CodexSessionUsage[]>("get_chat_sync_project_usage");
        if (active) { setUsage(result); setUsageError(""); }
      } catch (error) {
        if (active) setUsageError(String(error));
      } finally { pending = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const dateRange = dateRangeForPeriod(period, customDates);
  const invalidDates = Boolean(dateRange.start && dateRange.end && dateRange.start > dateRange.end);
  const selectedProject = projects.find(({ id }) => id === radarProject)?.id ?? projects[0]?.id ?? "";
  const activeAnalysis = analysis?.projectId === selectedProject ? analysis : null;
  async function analyzeRequirements() {
    if (!selectedProject || activeAnalysis?.busy) return;
    const pending = { projectId: selectedProject, result: activeAnalysis?.result ?? null, busy: true, error: "" };
    setAnalysis(pending);
    try {
      const result = await invoke<RequirementAnalysis>("analyze_chat_project_requirements", { projectId: selectedProject });
      setAnalysis((current) => current === pending ? { ...pending, result, busy: false } : current);
    } catch (error) {
      setAnalysis((current) => current === pending ? { ...pending, error: String(error), busy: false } : current);
    }
  }
  const totals = new Map(projects.map(({ id, name, settings }, index) => [id, {
    id, name: settings.displayName ?? name, color: shareColor(index), tokens: 0, hasTokens: false, turns: 0, sessions: 0
  }]));
  const linkedProjects = new Map<string, string>();
  const fileCounts = new Map<string, number>();
  const progress = new Map<string, {
    name: string;
    items: { id: number; time: Date; title: string; status: "todo" | "doing" | "completed" }[];
  }>();

  for (const { note, sources } of tasks) {
    const projectId = projectIds.get(note.id);
    if (!projectId) continue;
    for (const { sessionId, dispatchThreadId } of sources) {
      if (sessionId && !linkedProjects.has(sessionId)) linkedProjects.set(sessionId, projectId);
      if (dispatchThreadId && !linkedProjects.has(dispatchThreadId)) linkedProjects.set(dispatchThreadId, projectId);
    }
    const row = totals.get(projectId);
    if (!row) continue;
    const title = note.title.trim();
    let latest: Date | undefined;
    for (const timestamp of [note.completedAt, ...sources.map(({ syncedAt }) => syncedAt)]) {
      if (!timestamp) continue;
      const time = new Date(timestamp);
      if (!Number.isNaN(time.getTime()) && localDateKey(time) === day && (!latest || time > latest)) latest = time;
    }
    if (latest) {
      const group = progress.get(row.id) ?? { name: row.name, items: [] };
      group.items.push({ id: note.id, time: latest, title, status: note.completed ? "completed" : note.status });
      progress.set(row.id, group);
    }

    for (const { evidence } of sources) {
      if (row.id === selectedProject && evidence.startsWith(codeChangeEvidencePrefix)) {
        const files = new Set(evidence.slice(codeChangeEvidencePrefix.length).split("、")
          .map((path) => path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "")).filter(Boolean));
        for (const file of files) fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
      }
    }
  }

  for (const { sessionId, projectId, days } of usage ?? []) {
    const row = totals.get(projectId ?? linkedProjects.get(sessionId) ?? "");
    if (!row) continue;
    const matchingDays = days.filter(({ date }) => dateInRange(date, dateRange));
    if (!matchingDays.length) continue;
    row.sessions += 1;
    for (const { totalTokens, turns } of matchingDays) {
      row.turns += turns;
      if (totalTokens != null) {
        row.tokens += totalTokens;
        row.hasTokens = true;
      }
    }
  }

  const rows = [...totals.values()].sort((a, b) => b.tokens - a.tokens || b.turns - a.turns);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const sessionCount = rows.reduce((sum, row) => sum + row.sessions, 0);
  const hovered = rows.find(({ id, hasTokens }) => id === hoveredProject && hasTokens);
  let offset = 0;
  const slices = rows.flatMap(({ id, color, tokens }) => {
    if (!tokens) return [];
    const start = offset;
    offset += tokens;
    return [{ id, end: offset / total, gradient: `${color} ${start / total * 100}% ${offset / total * 100}%` }];
  });
  const projectProgress = [...progress].sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const progressCount = projectProgress.reduce((count, [, { items }]) => count + items.length, 0);
  const recurring = [...fileCounts].map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, 6);
  const peak = recurring[0]?.count ?? 1;

  return <main className="ci-analysis" aria-label="项目用量分析">
    <button type="button" className="ci-analysis-back" autoFocus onClick={onBack}><ArrowLeft size={16} />返回看板</button>

    <div className="ci-analysis-grid">
      <section className="ci-usage ci-analysis-share" aria-label="项目用量占比" aria-busy={usage === null && !usageError}>
        <div className="ci-analysis-card-header">
          <div><h2>项目用量占比</h2>
            <p className="ci-usage-caption">Token{usage && !invalidDates && ` · ${exact.format(sessionCount)} 个对话`}</p>
          </div>
          <SelectField variant="toolbar" label="用量日期范围" value={period} options={datePeriodOptions}
            leadingIcon={<CalendarDays size={14} />} onChange={setPeriod} />
        </div>
        {period === "custom" && <div className="ci-date-range ci-usage-date-range" role="group" aria-label="自定义用量日期">
          <div className="ci-usage-date-field"><span aria-hidden="true">开始日期</span>
            <CalendarDatePicker variant="field" label="用量开始日期" placeholder="不限"
              value={customDates.start} onChange={(start) => setCustomDates((current) => ({ ...current, start }))} />
          </div>
          <div className="ci-usage-date-field"><span aria-hidden="true">结束日期</span>
            <CalendarDatePicker variant="field" label="用量结束日期" placeholder="不限"
              value={customDates.end} onChange={(end) => setCustomDates((current) => ({ ...current, end }))} />
          </div>
          {invalidDates && <span className="ci-warning" role="alert">开始日期不能晚于结束日期</span>}
        </div>}
        {usageError && <p className="ci-usage-empty" role="status">项目用量读取失败：{usageError}</p>}
        {!usage && !usageError && <p className="ci-usage-empty">正在读取本地对话…</p>}
        {usage && !invalidDates && (sessionCount > 0 ? <div className="ci-analysis-share-body">
          <div className="ci-usage-pie"
            style={slices.length ? { background: `conic-gradient(${slices.map(({ gradient }) => gradient).join(", ")})` } : undefined}
            onPointerMove={(event) => {
              const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
              const x = (event.clientX - left) / width * 2 - 1;
              const y = (event.clientY - top) / height * 2 - 1;
              const radius = Math.hypot(x, y);
              const angle = (Math.atan2(x, -y) / (2 * Math.PI) + 1) % 1;
              setHoveredProject(radius >= .72 && radius <= 1 ? slices.find(({ end }) => angle < end)?.id ?? null : null);
            }} onPointerLeave={() => setHoveredProject(null)}>
            <div className={`ci-usage-total${hovered ? " is-highlighted" : ""}`}
              title={hovered ? `${hovered.name} · ${exact.format(hovered.tokens)} Token` : `${exact.format(total)} Token`}>
              {hovered ? <><span>{hovered.name}</span><strong>{exact.format(hovered.tokens)}</strong><span>Token</span></>
                : <><strong>{rows.some(({ hasTokens }) => hasTokens) ? compact.format(total) : "—"}</strong><span>总 Token</span></>}
            </div>
          </div>
          <ul className="ci-usage-ranking">
            {rows.map(({ id, name, color, tokens, hasTokens, turns, sessions }) => {
              const value = sessions
                ? `${hasTokens ? `${exact.format(tokens)} Token` : "Token 暂无记录"} · ${exact.format(turns)} 轮 · ${exact.format(sessions)} 个对话`
                : "暂无记录";
              return <li key={id}><button type="button" aria-label={`${name}，${value}`} title={value}
                onFocus={() => setHoveredProject(hasTokens ? id : null)} onBlur={() => setHoveredProject(null)}
                onClick={() => onSelect(id)}>
                <i style={{ background: tokens ? color : "var(--border)" }} aria-hidden="true" />
                <span>{name}{sessions > 0 && <small>{exact.format(sessions)} 个对话</small>}</span>
                <strong>{hasTokens ? `${total ? (tokens / total * 100).toFixed(1) : "0"}%` : "暂无"}</strong>
                <ArrowUpRight size={13} aria-hidden="true" />
              </button></li>;
            })}
          </ul>
        </div> : <p className="ci-usage-empty" role="status">{rows.length ? "所选日期内暂无项目用量" : "暂无可统计项目"}</p>)}
      </section>

      <section className="ci-usage ci-progress-card" aria-label="项目日进度">
        <div className="ci-analysis-card-header"><h2>项目日进度</h2>
          <CalendarDatePicker variant="field" label="工作日期" value={day} onChange={setDay} />
        </div>
        <p className="ci-usage-caption">当天同步或完成{progressCount ? ` · ${exact.format(progressCount)} 项` : ""}</p>
        {projectProgress.length ? <ul key={day} className="ci-analysis-timeline" tabIndex={0} aria-label="当天事项时间线">
          {projectProgress.map(([projectId, { name, items }]) => {
            return <li key={projectId} className="ci-day-project">
              <h3>{name}</h3>
              <ol>{[...items].sort((a, b) => a.time.getTime() - b.time.getTime()).map(({ id, time, title, status }) => <li key={id}>
                <time dateTime={time.toISOString()}>{clock.format(time)}</time><span>{title}</span>
                {status !== "completed" && <small data-status={status}>{status === "doing" ? "进行中" : "待处理"}</small>}
              </li>)}</ol>
            </li>;
          })}
        </ul> : <p className="ci-usage-empty">这一天暂无项目事项记录</p>}
      </section>

      <section className="ci-usage ci-repeat-card" aria-label="重复问题雷达">
        <div className="ci-analysis-card-header">
          <h2>重复问题雷达</h2>
          <SelectField variant="toolbar" label="雷达项目" value={selectedProject || null} placeholder="暂无项目"
            leadingIcon={<FolderClosed size={14} />}
            options={projects.map(({ id, name, settings }) => ({ value: id, label: settings.displayName ?? name }))}
            onChange={(projectId) => { setRadarProject(projectId); setAnalysis(null); }} />
        </div>
        <p className="ci-usage-caption">全部日期 · 按同步改动记录统计，显示前 6 个文件</p>
        {recurring.length ? <div className="ci-analysis-radar">
          <svg viewBox="0 0 168 168" aria-hidden="true">
            {[18, 36, 54, 72].map((radius) => <circle key={radius} cx="84" cy="84" r={radius} className="ci-radar-ring" />)}
            {recurring.map(({ title, count }, index) => {
              const angle = index * 2 * Math.PI / recurring.length - Math.PI / 2;
              const x = Math.cos(angle);
              const y = Math.sin(angle);
              const radius = count / peak * 72;
              return <g key={title} fill={shareColor(index)}>
                <line x1="84" y1="84" x2={84 + x * 72} y2={84 + y * 72} className="ci-radar-ring" />
                <circle cx={84 + x * radius} cy={84 + y * radius} r="5" />
              </g>;
            })}
          </svg>
          <ul>{recurring.map(({ title, count }, index) => <li key={title}>
            <i style={{ background: shareColor(index) }} aria-hidden="true" /><span>{title}</span><strong>{count} 次</strong>
          </li>)}</ul>
        </div> : <p className="ci-usage-empty">{selectedProject ? "该项目暂无文件改动记录" : "暂无可统计项目"}</p>}
        {selectedProject && <div className="ci-repeated-actions">
          <button type="button" aria-describedby="ci-repeated-source" aria-busy={activeAnalysis?.busy ?? false}
            aria-controls={activeAnalysis?.result || activeAnalysis?.error ? "ci-repeated-analysis" : undefined}
            disabled={activeAnalysis?.busy} onClick={() => void analyzeRequirements()}>
            <Sparkles size={14} aria-hidden="true" />{activeAnalysis?.result ? "重新分析需求" : "分析重复需求"}
          </button>
          <span id="ci-repeated-source">{activeAnalysis?.busy ? "正在分析对话…" : "发送近期用户请求至已配置的 API"}</span>
        </div>}
      </section>
      {(activeAnalysis?.result || activeAnalysis?.error) && <RequirementResults result={activeAnalysis.result} error={activeAnalysis.error} />}
    </div>
  </main>;
}

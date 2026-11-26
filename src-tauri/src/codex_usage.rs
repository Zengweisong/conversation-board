use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime},
};

static CACHE: LazyLock<Mutex<UsageCache>> = LazyLock::new(|| Mutex::new(UsageCache::default()));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnUsage {
    total_tokens: Option<u64>,
    quota_changes: Vec<QuotaChange>,
    #[serde(skip)]
    ended_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuotaChange {
    window_minutes: u64,
    percentage_points: f64,
}

#[derive(Default)]
struct UsageCache {
    home: PathBuf,
    scanned_at: Option<Instant>,
    paths: BTreeMap<String, PathBuf>,
    sessions: BTreeMap<String, SessionUsage>,
}

struct SessionUsage {
    revision: (u64, Option<SystemTime>),
    metadata: Option<SessionMetaPayload>,
    turns: BTreeMap<String, TurnUsage>,
}

impl UsageCache {
    fn refresh_paths(&mut self, home: &Path) {
        if self.home != home {
            *self = Self { home: home.to_owned(), ..Self::default() };
        }
        if self.scanned_at.is_some_and(|time| time.elapsed() < Duration::from_secs(15)) {
            return;
        }
        let paths = transcript_paths(home);
        self.sessions.retain(|id, _| paths.get(id) == self.paths.get(id));
        self.paths = paths;
        self.scanned_at = Some(Instant::now());
    }

    fn read_session(&mut self, session: &str) -> Option<&SessionUsage> {
        let path = self.paths.get(session)?;
        let metadata = path.metadata().ok()?;
        let revision = (metadata.len(), metadata.modified().ok());
        if !self.sessions.get(session).is_some_and(|entry| entry.revision == revision) {
            let (metadata, turns) = read_transcript(BufReader::new(File::open(path).ok()?));
            self.sessions.insert(session.to_owned(), SessionUsage { revision, metadata, turns });
        }
        self.sessions.get(session)
    }
}

pub(crate) fn for_turn(home: &Path, session: &str, turn: &str) -> Option<TurnUsage> {
    let mut cache = CACHE.lock().ok()?;
    if cache.home != home || !cache.paths.contains_key(session) {
        cache.refresh_paths(home);
    }
    let usage = match cache.sessions.get(session).and_then(|entry| entry.turns.get(turn)) {
        Some(usage) => usage,
        None => {
            if !cache.paths.get(session).is_some_and(|path| path.is_file()) {
                cache.refresh_paths(home);
            }
            cache.read_session(session)?.turns.get(turn)?
        }
    };
    (usage.total_tokens.is_some() || !usage.quota_changes.is_empty()).then(|| usage.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageSummary {
    session_id: String,
    project_id: Option<String>,
    days: Vec<DailyUsage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DailyUsage {
    date: Option<String>,
    total_tokens: Option<u64>,
    turns: usize,
}

pub(crate) fn summarize_sessions(
    home: &Path,
    project_for: impl Fn(&str, Option<&str>) -> Option<String>,
) -> Result<Vec<SessionUsageSummary>, String> {
    let cache_error = |_| "无法读取 Codex 用量缓存".to_owned();
    let session_ids: Vec<_> = {
        let mut cache = CACHE.lock().map_err(cache_error)?;
        cache.refresh_paths(home);
        cache.paths.keys().cloned().collect()
    };
    let mut summaries = Vec::new();
    for session_id in session_ids {
        let mut cache = CACHE.lock().map_err(cache_error)?;
        if cache.home != home {
            cache.refresh_paths(home);
        }
        let Some(session) = cache.read_session(&session_id) else { continue };
        let metadata = session.metadata.as_ref();
        if session.turns.is_empty() || metadata.is_some_and(SessionMetaPayload::is_subagent) {
            continue;
        }
        let mut days = BTreeMap::new();
        for turn in session.turns.values() {
            let date = turn.ended_at.map(|timestamp| timestamp.with_timezone(&Local).date_naive());
            let day = days.entry(date).or_insert_with(|| DailyUsage {
                date: date.map(|date| date.to_string()),
                total_tokens: None,
                turns: 0,
            });
            day.turns += 1;
            if let Some(tokens) = turn.total_tokens {
                day.total_tokens = Some(day.total_tokens.unwrap_or(0).saturating_add(tokens));
            }
        }
        summaries.push(SessionUsageSummary {
            project_id: project_for(&session_id, metadata.and_then(|meta| meta.cwd.as_deref())),
            session_id,
            days: days.into_values().collect(),
        });
    }
    Ok(summaries)
}

fn transcript_paths(home: &Path) -> BTreeMap<String, PathBuf> {
    let mut paths = BTreeMap::new();
    let mut pending = vec![home.join("archived_sessions"), home.join("sessions")];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                let name = entry.file_name();
                let Some(stem) = name.to_str().and_then(|name| name.strip_prefix("rollout-"))
                    .and_then(|name| name.strip_suffix(".jsonl")) else { continue };
                if let Some(session) = stem.len().checked_sub(36).and_then(|start| stem.get(start..)) {
                    paths.entry(session.to_owned()).or_insert_with(|| entry.path());
                }
            }
        }
    }
    paths
}

pub(crate) fn recent_project_requests(
    home: &Path,
    belongs_to_project: impl Fn(&str, Option<&str>) -> bool,
) -> Vec<String> {
    const MAX_REQUESTS: usize = 80;
    const MAX_BYTES: usize = 24 * 1024;
    let mut recent = BTreeSet::new();
    let mut undated = 0;
    for (session, path) in transcript_paths(home) {
        let Ok(file) = File::open(path) else { continue };
        let mut reader = BufReader::new(file);
        let mut first = String::new();
        if reader.read_line(&mut first).is_err() { continue; }
        let metadata = session_metadata(&first);
        if metadata.as_ref().is_some_and(SessionMetaPayload::is_subagent)
            || !belongs_to_project(&session, metadata.as_ref().and_then(|meta| meta.cwd.as_deref())) {
            continue;
        }
        for line in first.as_bytes().chain(reader).lines().map_while(Result::ok) {
            let Some((timestamp, text)) = user_request(&line) else { continue };
            // Forked transcripts can replay the same timestamped user message.
            let ordinal = if timestamp.is_none() { undated += 1; undated } else { 0 };
            recent.insert((timestamp, ordinal, text));
            if recent.len() > MAX_REQUESTS {
                recent.pop_first();
            }
        }
    }
    let mut bytes = 0;
    recent.into_iter().rev().map(|(_, _, text)| text).take_while(|text| {
        bytes += text.len();
        bytes <= MAX_BYTES
    }).collect()
}

fn user_request(line: &str) -> Option<(Option<DateTime<Utc>>, String)> {
    if !line.contains("\"response_item\"") || !line.contains("\"user\"") {
        return None;
    }
    let record: serde_json::Value = serde_json::from_str(line).ok()?;
    let payload = &record["payload"];
    if record["type"] != "response_item" || payload["type"] != "message" || payload["role"] != "user" {
        return None;
    }
    let text = payload["content"].as_array()?.iter()
        .filter(|part| part["type"] == "input_text")
        .filter_map(|part| part["text"].as_str().map(str::trim))
        .filter(|text| !text.starts_with("<environment_context>") && !text.starts_with("<permissions instructions>"))
        .collect::<Vec<_>>().join("\n");
    let request = text.split_once("## My request:").map_or(text.as_str(), |(_, request)| request).trim();
    let timestamp = record["timestamp"].as_str().and_then(|value| value.parse().ok());
    (!request.is_empty()).then(|| (timestamp, request.chars().take(320).collect()))
}

#[derive(Deserialize)]
struct Record {
    #[serde(rename = "type")]
    kind: String,
    timestamp: Option<serde_json::Value>,
    payload: Event,
}

#[derive(Deserialize)]
struct SessionMeta {
    #[serde(rename = "type")]
    kind: String,
    payload: SessionMetaPayload,
}

#[derive(Deserialize)]
struct SessionMetaPayload {
    cwd: Option<String>,
    source: Option<serde_json::Value>,
}

impl SessionMetaPayload {
    fn is_subagent(&self) -> bool {
        self.source.as_ref().is_some_and(|source| source == "subagent" || source.get("subagent").is_some())
    }
}

fn read_transcript(mut input: impl BufRead) -> (Option<SessionMetaPayload>, BTreeMap<String, TurnUsage>) {
    let mut first = String::new();
    if input.read_line(&mut first).is_ok() {
        if let Some(metadata) = session_metadata(&first) {
            return (Some(metadata), read_turns(input));
        }
    }
    (None, read_turns(first.as_bytes().chain(input)))
}

fn session_metadata(line: &str) -> Option<SessionMetaPayload> {
    let meta: SessionMeta = serde_json::from_str(line.trim_start_matches('\u{feff}')).ok()?;
    (meta.kind == "session_meta").then_some(meta.payload)
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event {
    TaskStarted { turn_id: String },
    TurnStarted { turn_id: String },
    TaskComplete { turn_id: Option<String> },
    TurnCompleted { turn_id: Option<String> },
    TurnAborted { turn_id: Option<String> },
    TokenCount { info: Option<TokenInfo>, rate_limits: Option<RateLimits> },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct TokenInfo {
    total_token_usage: TokenCount,
    last_token_usage: Option<TokenCount>,
}

#[derive(Deserialize)]
struct TokenCount {
    total_tokens: u64,
}

#[derive(Deserialize)]
struct RateLimits {
    limit_id: Option<String>,
    primary: Option<QuotaWindow>,
    secondary: Option<QuotaWindow>,
}

#[derive(Clone, Copy, Deserialize)]
struct QuotaWindow {
    window_minutes: Option<u64>,
    resets_at: Option<i64>,
    used_percent: f64,
}

#[derive(Default)]
struct QuotaSeries {
    bounds: Option<(QuotaWindow, QuotaWindow)>,
    reset: bool,
}

impl QuotaSeries {
    fn record(&mut self, latest: QuotaWindow) {
        self.bounds = Some(match self.bounds {
            Some((first, previous)) => {
                // The server can report the same reset time a few seconds apart.
                self.reset |= first.window_minutes != latest.window_minutes
                    || !matches!((first.resets_at, latest.resets_at), (Some(a), Some(b)) if a.abs_diff(b) <= 5)
                    || previous.used_percent > latest.used_percent;
                (first, latest)
            }
            None => (latest, latest),
        });
    }

    fn change(&self) -> Option<QuotaChange> {
        let (first, last) = self.bounds?;
        let window_minutes = first.window_minutes?;
        let percentage_points = last.used_percent - first.used_percent;
        (!self.reset && window_minutes > 0 && first.used_percent >= 0.0 && last.used_percent <= 100.0
            && percentage_points > 0.0).then_some(QuotaChange { window_minutes, percentage_points })
    }
}

#[derive(Default)]
struct CurrentTurn {
    id: String,
    started_at: Option<DateTime<Utc>>,
    tokens: u64,
    primary: QuotaSeries,
    secondary: QuotaSeries,
}

fn read_turns(input: impl BufRead) -> BTreeMap<String, TurnUsage> {
    let mut turns = BTreeMap::new();
    let mut current: Option<CurrentTurn> = None;
    let mut previous_tokens = None;
    for line in input.lines().map_while(Result::ok) {
        if !line.contains("\"event_msg\"")
            || !["token_count", "task_started", "task_complete", "turn_started", "turn_completed", "turn_aborted"]
                .iter().any(|kind| line.contains(kind)) { continue; }
        let Ok(Record { kind, timestamp, payload }) = serde_json::from_str(&line) else { continue };
        if kind != "event_msg" { continue; }
        let event_time = || timestamp.as_ref()?.as_str()?.parse::<DateTime<Utc>>().ok();
        match payload {
            Event::TaskStarted { turn_id } | Event::TurnStarted { turn_id } => {
                if !current.as_ref().is_some_and(|turn| turn.id == turn_id) {
                    current = Some(CurrentTurn { id: turn_id, started_at: event_time(), ..CurrentTurn::default() });
                }
            }
            Event::TaskComplete { turn_id } | Event::TurnCompleted { turn_id } | Event::TurnAborted { turn_id } => {
                if !current.as_ref().is_some_and(|turn| turn_id.as_ref().is_none_or(|id| *id == turn.id)) { continue; }
                let Some(turn) = current.take() else { continue };
                let total_tokens = (turn.tokens > 0).then_some(turn.tokens);
                let quota_changes: Vec<_> = [turn.primary.change(), turn.secondary.change()].into_iter().flatten().collect();
                let ended_at = event_time().or(turn.started_at);
                turns.insert(turn.id, TurnUsage { total_tokens, quota_changes, ended_at });
            }
            Event::TokenCount { info, rate_limits } => {
                if let Some(info) = info {
                    let total = info.total_token_usage.total_tokens;
                    let added = previous_tokens.and_then(|previous| total.checked_sub(previous))
                        .or_else(|| info.last_token_usage.map(|usage| usage.total_tokens));
                    previous_tokens = Some(total);
                    if let (Some(turn), Some(added)) = (&mut current, added) {
                        turn.tokens = turn.tokens.saturating_add(added);
                    }
                }
                if let (Some(turn), Some(limits)) = (&mut current, rate_limits) {
                    if limits.limit_id.as_deref().is_none_or(|id| id == "codex") {
                        if let Some(window) = limits.primary { turn.primary.record(window); }
                        if let Some(window) = limits.secondary { turn.secondary.record(window); }
                    }
                }
            }
            Event::Other => {}
        }
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_relevant_user_requests_from_local_and_archived_transcripts() {
        let home = std::env::temp_dir().join(format!(
            "conversation-board-requests-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let active = home.join("sessions");
        let archived = home.join("archived_sessions");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&archived).unwrap();
        let earlier = r#"{"timestamp":"2026-11-20T12:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"改进日期筛选"}]}}"#;
        let latest = r##"{"timestamp":"2026-11-21T12:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# Files mentioned by the user\nlocal/path\n## My request:\n增加日期范围"},{"type":"input_image","image_url":"attachment-data"}]}}"##;
        fs::write(active.join("rollout-11111111-1111-1111-1111-111111111111.jsonl"), format!(
            "{}\n{earlier}\n{}",
            r#"{"type":"session_meta","payload":{"cwd":"C:/dev/app"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"input_text","text":"助手回复"}]}}"#
        )).unwrap();
        fs::write(archived.join("rollout-22222222-2222-2222-2222-222222222222.jsonl"), format!(
            "{}\n{earlier}\n{latest}\n{}",
            r#"{"type":"session_meta","payload":{"cwd":"C:/dev/app"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>环境信息</environment_context>"}]}}"#
        )).unwrap();
        fs::write(active.join("rollout-33333333-3333-3333-3333-333333333333.jsonl"), format!(
            "{}\n{}",
            r#"{"type":"session_meta","payload":{"cwd":"C:/dev/other"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"其他项目的需求"}]}}"#
        )).unwrap();
        fs::write(active.join("rollout-44444444-4444-4444-4444-444444444444.jsonl"), format!(
            "{}\n{}",
            r#"{"type":"session_meta","payload":{"cwd":"C:/dev/app","source":{"subagent":{}}}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"子代理任务"}]}}"#
        )).unwrap();
        let requests = recent_project_requests(&home, |_, cwd| cwd == Some("C:/dev/app"));
        fs::remove_dir_all(&home).unwrap();
        assert_eq!(requests, ["增加日期范围", "改进日期筛选"]);
    }

    #[test]
    fn summarizes_local_and_archived_conversations_without_board_items() {
        let home = std::env::temp_dir().join(format!(
            "conversation-board-usage-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let active = home.join("sessions").join("2026");
        let archived = home.join("archived_sessions");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&archived).unwrap();
        let active_id = "11111111-1111-1111-1111-111111111111";
        let archived_id = "22222222-2222-2222-2222-222222222222";
        let active_name = format!("rollout-{active_id}.jsonl");
        let active_transcript = r#"{"type":"session_meta","payload":{"cwd":"C:/dev/app/subdir"}}
{"timestamp":"2026-11-24T12:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"question"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":120},"last_token_usage":{"total_tokens":120}}}}
{"timestamp":"2026-11-25T12:00:00Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"question"}}
"#;
        fs::write(active.join(&active_name), active_transcript).unwrap();
        fs::write(archived.join(&active_name), active_transcript).unwrap();
        fs::write(archived.join(format!("rollout-{archived_id}.jsonl")), r#"{"type":"session_meta","payload":{"cwd":"C:/dev/app"}}
{"type":"event_msg","payload":{"type":"turn_started","turn_id":"discussion"}}
{"type":"event_msg","payload":{"type":"turn_completed","turn_id":"discussion"}}
"#).unwrap();
        fs::write(active.join("rollout-33333333-3333-3333-3333-333333333333.jsonl"), r#"{"type":"session_meta","payload":{"cwd":"C:/dev/app","source":{"subagent":{"thread_spawn":{}}}}}
{"type":"event_msg","payload":{"type":"turn_started","turn_id":"delegated"}}
{"type":"event_msg","payload":{"type":"turn_completed","turn_id":"delegated"}}
"#).unwrap();

        let read = || summarize_sessions(&home, |_, cwd| cwd.map(str::to_owned)).unwrap();
        let initial = read();
        let next_turn = r#"{"timestamp":"2026-11-26T12:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"follow-up"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":150},"last_token_usage":{"total_tokens":30}}}}
{"timestamp":"2026-11-26T12:01:00Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"follow-up"}}
"#;
        fs::write(active.join(&active_name), format!("{active_transcript}{next_turn}")).unwrap();
        let updated = read();
        fs::remove_dir_all(&home).unwrap();

        assert_eq!(initial.len(), 2);
        assert_eq!(initial[0].session_id, active_id);
        assert_eq!(initial[0].project_id.as_deref(), Some("C:/dev/app/subdir"));
        let local_date = |value: &str| value.parse::<DateTime<Utc>>().unwrap().with_timezone(&Local).date_naive().to_string();
        let question = &initial[0].days[0];
        assert_eq!(question.date, Some(local_date("2026-11-25T12:00:00Z")));
        assert_eq!((question.total_tokens, question.turns), (Some(120), 1));
        assert_eq!(initial[1].session_id, archived_id);
        assert_eq!(initial[1].project_id.as_deref(), Some("C:/dev/app"));
        let archive = &initial[1].days[0];
        assert_eq!((archive.date.as_deref(), archive.total_tokens, archive.turns), (None, None, 1));
        assert_eq!(updated[0].days.len(), 2);
        let follow_up = &updated[0].days[1];
        assert_eq!(follow_up.date, Some(local_date("2026-11-26T12:01:00Z")));
        assert_eq!((follow_up.total_tokens, follow_up.turns), (Some(30), 1));
    }

    #[test]
    fn measures_only_the_matching_turn_and_deduplicates_cumulative_usage() {
        let transcript = r#"
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":2000},"last_token_usage":{"total_tokens":1000}}}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"first"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":2110},"last_token_usage":{"total_tokens":110}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":10,"window_minutes":300,"resets_at":6000},"secondary":{"used_percent":5,"window_minutes":10080,"resets_at":8000}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":2160},"last_token_usage":{"total_tokens":50}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":13,"window_minutes":300,"resets_at":6002},"secondary":{"used_percent":6,"window_minutes":10080,"resets_at":8000}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":2160},"last_token_usage":{"total_tokens":50}}}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"first"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"second"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":25},"last_token_usage":{"total_tokens":25}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":98,"window_minutes":300,"resets_at":6000}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":60},"last_token_usage":{"total_tokens":35}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":3,"window_minutes":300,"resets_at":22000}}}}
{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"second"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"active"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":120},"last_token_usage":{"total_tokens":60}}}}
"#;
        let turns = read_turns(transcript.as_bytes());
        assert_eq!(turns.len(), 2);
        assert_eq!(turns["first"].total_tokens, Some(160));
        assert_eq!(turns["first"].quota_changes.len(), 2);
        assert_eq!(turns["first"].quota_changes[0].percentage_points, 3.0);
        assert_eq!(turns["first"].quota_changes[1].percentage_points, 1.0);
        assert_eq!(turns["second"].total_tokens, Some(60));
        assert!(turns["second"].quota_changes.is_empty());
    }
}

use crate::codex_projects::ProjectCatalog;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThread {
    id: String,
    name: Option<String>,
    preview: String,
    cwd: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPage {
    data: Vec<CodexThread>,
    next_cursor: Option<String>,
}

pub fn list_threads(
    search: &str,
    cursor: Option<String>,
    project: Option<(&ProjectCatalog, &str)>,
) -> Result<ThreadPage, String> {
    let mut server = Server::start()?;
    read_thread_pages(cursor, project, |cursor| {
        let result = server.request(
            "thread/list",
            json!({
                "limit": 25, "archived": false, "cursor": cursor,
                "searchTerm": (!search.is_empty()).then_some(search),
                "sourceKinds": ["cli", "vscode", "exec", "appServer", "unknown"]
            }),
        )?;
        serde_json::from_value(result).map_err(|_| "无法读取 Codex 对话列表".into())
    })
}

fn read_thread_pages(
    mut cursor: Option<String>,
    project: Option<(&ProjectCatalog, &str)>,
    mut read: impl FnMut(Option<&str>) -> Result<ThreadPage, String>,
) -> Result<ThreadPage, String> {
    let mut remaining_pages = 8;
    loop {
        let mut page = read(cursor.as_deref())?;
        let Some((catalog, id)) = project else {
            return Ok(page);
        };
        page.data.retain(|thread| catalog.project_for(&thread.id, Some(&thread.cwd)) == Some(id));
        if page.next_cursor == cursor {
            page.next_cursor = None;
        }
        remaining_pages -= 1;
        // Skip pages owned by other projects while keeping large histories pageable.
        if !page.data.is_empty() || page.next_cursor.is_none() || remaining_pages == 0 {
            return Ok(page);
        }
        cursor = page.next_cursor;
    }
}

#[cfg(test)]
mod thread_list_tests {
    use super::*;

    #[test]
    fn continues_past_unrelated_pages_and_uses_codex_project_ownership() {
        let catalog: ProjectCatalog = serde_json::from_value(json!({
            "local-projects": {
                "app": { "name": "App", "rootPaths": ["C:/dev/app", "C:/extra/app"] },
                "nested": { "name": "Nested", "rootPaths": ["C:/dev/app/nested"] }
            },
            "thread-project-assignments": {
                "assigned": { "projectKind": "local", "projectId": "app" },
                "moved": { "projectKind": "local", "projectId": "nested" }
            }
        })).unwrap();
        let thread = |id: &str, cwd: &str| CodexThread {
            id: id.into(), name: None, preview: String::new(), cwd: cwd.into(),
        };
        let mut calls = Vec::new();
        let page = read_thread_pages(None, Some((&catalog, "app")), |cursor| {
            calls.push(cursor.map(str::to_owned));
            Ok(if cursor.is_none() {
                ThreadPage {
                    data: vec![thread("prefix-only", "C:/dev/application"), thread("nested", "C:/dev/app/nested/src")],
                    next_cursor: Some("second".into()),
                }
            } else {
                ThreadPage {
                    data: vec![thread("assigned", "C:/elsewhere"), thread("root", "C:/extra/app/src"), thread("moved", "C:/dev/app")],
                    next_cursor: Some("third".into()),
                }
            })
        }).unwrap();

        assert_eq!(calls, [None, Some("second".to_owned())]);
        assert_eq!(page.data.iter().map(|thread| thread.id.as_str()).collect::<Vec<_>>(), ["assigned", "root"]);
        assert_eq!(page.next_cursor.as_deref(), Some("third"));
    }
}

pub fn text_input(prompt: &str) -> Value {
    // The desktop also renders the input directly, before it is normalized by app-server.
    json!([{ "type": "text", "text": prompt, "text_elements": [] }])
}

// Persist a receipt in the dispatch row until Codex starts its turn.
pub const QUEUE_RECEIPT_PREFIX: &str = "queued:";

pub struct Dispatch {
    pub thread_id: String,
    pub turn_id: String,
    #[cfg(not(windows))]
    background: ActiveTurn,
}

pub enum Delivery {
    Sent(Dispatch),
    #[cfg(windows)]
    DraftOpened { thread_id: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    Completed,
    Unsuccessful,
}

impl Dispatch {
    pub fn start(
        prompt: String,
        thread_id: Option<String>,
        cwd: Option<&Path>,
    ) -> Result<Delivery, String> {
        #[cfg(windows)]
        {
            let thread_id = match thread_id {
                Some(id) => id,
                None => prepare_desktop_thread(&prompt, cwd)?,
            };
            if let Some(turn_id) = crate::codex_desktop::try_send(&thread_id, &prompt)? {
                return Ok(Delivery::Sent(Self { thread_id, turn_id }));
            }
            let submitted_at = chrono::Utc::now().timestamp();
            let message_id = uuid::Uuid::new_v4().to_string();
            let mut server = Server::start_with_experimental_api(true)?;
            if enqueue_prompt(&thread_id, &message_id, &prompt, |params| {
                server.request("thread/queue/add", params)
            })? {
                let turn_id = format!("{QUEUE_RECEIPT_PREFIX}{submitted_at}:{message_id}");
                return Ok(Delivery::Sent(Self { thread_id, turn_id }));
            }
            crate::codex_desktop::open_draft(&thread_id, &prompt)?;
            Ok(Delivery::DraftOpened { thread_id })
        }
        #[cfg(not(windows))]
        {
            let background = ActiveTurn::start(&prompt, thread_id.as_deref(), cwd)?;
            Ok(Delivery::Sent(Self {
                thread_id: background.thread_id.clone(),
                turn_id: background.turn_id.clone(),
                background,
            }))
        }
    }

    pub fn wait(self) -> Option<TurnOutcome> {
        #[cfg(windows)]
        return None;
        #[cfg(not(windows))]
        self.background.wait()
    }
}

#[cfg(any(windows, test))]
fn enqueue_prompt(
    thread_id: &str,
    message_id: &str,
    prompt: &str,
    request: impl FnOnce(Value) -> Result<Value, String>,
) -> Result<bool, String> {
    match request(json!({
        "threadId": thread_id,
        "clientUserMessageId": message_id,
        "input": text_input(prompt)
    })) {
        Ok(response) if response["queuedSubmission"]["clientUserMessageId"] == message_id => Ok(true),
        Err(error) if error.starts_with("Invalid request: unknown variant `thread/queue/add`")
            || error == "Method not found" => Ok(false),
        _ => Err("未收到 Codex 的排队确认，请先在目标对话中核对后再重试。".into()),
    }
}

#[cfg(test)]
mod queue_tests {
    use super::*;

    #[test]
    fn queues_the_complete_prompt_for_the_selected_thread() {
        let prompt = "处理事项\n\n附带说明";
        let receipt = enqueue_prompt("selected-thread", "message-id", prompt, |params| {
            assert_eq!(params["threadId"], "selected-thread");
            assert_eq!(params["clientUserMessageId"], "message-id");
            assert_eq!(params["input"], text_input(prompt));
            Ok(json!({ "queuedSubmission": { "clientUserMessageId": "message-id" } }))
        });
        assert_eq!(receipt, Ok(true));
    }

    #[test]
    fn only_falls_back_to_a_draft_when_queueing_is_unsupported() {
        assert_eq!(enqueue_prompt("thread", "message-id", "task", |_| {
            Err("Invalid request: unknown variant `thread/queue/add`, expected one of".into())
        }), Ok(false));
        assert!(enqueue_prompt("thread", "message-id", "task", |_| Err("Codex 响应超时".into())).is_err());
        assert!(enqueue_prompt("thread", "message-id", "task", |_| Ok(json!({
            "queuedSubmission": { "clientUserMessageId": "another-id" }
        }))).is_err());
    }

    #[test]
    fn matches_the_turn_by_client_message_id_even_when_prompt_text_is_repeated() {
        let turn = json!({ "items": [
            { "type": "userMessage", "clientId": "actual-id", "content": text_input("重复的事项") },
            { "type": "agentMessage", "clientId": "another-id", "text": "重复的事项" }
        ] });
        assert!(has_queued_message(&turn, "actual-id"));
        assert!(!has_queued_message(&turn, "another-id"));
        assert!(!has_queued_message(&turn, "重复的事项"));
    }
}

#[cfg(windows)]
fn prepare_desktop_thread(prompt: &str, cwd: Option<&Path>) -> Result<String, String> {
    let mut server = Server::start()?;
    let result = server.request(
        "thread/start",
        json!({ "cwd": cwd, "ephemeral": false, "approvalPolicy": "never", "sandbox": "workspace-write" }),
    )?;
    let thread_id = result["thread"]["id"]
        .as_str()
        .ok_or("Codex 未返回对话编号")?;
    let name = prompt.lines().next().unwrap_or_default().trim();
    // Naming the empty thread materializes its history. Dropping the server
    // releases the writer before the desktop resumes the thread and sends input.
    server.request(
        "thread/name/set",
        json!({ "threadId": thread_id, "name": name }),
    )?;
    Ok(thread_id.to_owned())
}

#[cfg(not(windows))]
struct ActiveTurn {
    server: Server,
    thread_id: String,
    turn_id: String,
}

#[cfg(not(windows))]
impl ActiveTurn {
    fn start(prompt: &str, thread_id: Option<&str>, cwd: Option<&Path>) -> Result<Self, String> {
        let mut server = Server::start()?;
        let mut options = json!({ "approvalPolicy": "never", "sandbox": "workspace-write" });
        let method = if let Some(id) = thread_id {
            options["threadId"] = json!(id);
            "thread/resume"
        } else {
            options["cwd"] = json!(cwd);
            options["ephemeral"] = json!(false);
            "thread/start"
        };
        let result = server.request(method, options)?;
        let thread_id = result["thread"]["id"]
            .as_str()
            .ok_or("Codex 未返回对话编号")?
            .to_owned();
        let result = server.request(
            "turn/start",
            json!({
                "threadId": thread_id, "input": text_input(prompt)
            }),
        )?;
        if matches!(
            result["turn"]["status"].as_str(),
            Some("failed" | "interrupted")
        ) {
            return Err("Codex 未能启动这次任务，请查看 Codex 登录状态后重试".into());
        }
        let turn_id = result["turn"]["id"]
            .as_str()
            .ok_or("Codex 未返回任务编号")?
            .to_owned();
        Ok(Self {
            server,
            thread_id,
            turn_id,
        })
    }

    fn wait(mut self) -> Option<TurnOutcome> {
        loop {
            if let Some((id, outcome)) = self.server.completed_turn.take() {
                if id == self.turn_id {
                    return outcome;
                }
            }
            self.server.read(Duration::from_secs(30 * 60)).ok()?;
        }
    }
}

pub struct Server {
    child: Child,
    input: Option<ChildStdin>,
    messages: Receiver<Value>,
    next_id: u64,
    #[cfg(not(windows))]
    completed_turn: Option<(String, Option<TurnOutcome>)>,
}

impl Server {
    pub fn start() -> Result<Self, String> {
        Self::start_with_experimental_api(false)
    }

    fn start_with_experimental_api(experimental_api: bool) -> Result<Self, String> {
        let mut child = spawn_server()?;
        let input = child.stdin.take().expect("piped Codex stdin");
        let output = child.stdout.take().expect("piped Codex stdout");
        let (sender, messages) = mpsc::sync_channel(64);
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str(&line) {
                    if sender.send(message).is_err() {
                        break;
                    }
                }
            }
        });
        let mut server = Self {
            child,
            input: Some(input),
            messages,
            next_id: 0,
            #[cfg(not(windows))]
            completed_turn: None,
        };
        server.request(
            "initialize",
            json!({
                "clientInfo": { "name": "todolist", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": experimental_api }
            }),
        )?;
        server.write(&json!({ "method": "initialized" }))?;
        Ok(server)
    }

    pub fn queued_turn(&mut self, thread_id: &str, receipt: &str) -> Result<Option<(String, Option<TurnOutcome>)>, String> {
        let (submitted_at, message_id) = receipt.strip_prefix(QUEUE_RECEIPT_PREFIX)
            .and_then(|value| value.split_once(':'))
            .and_then(|(time, id)| time.parse::<i64>().ok().map(|time| (time, id)))
            .ok_or("排队记录格式无效")?;
        let mut cursor = Value::Null;
        loop {
            let page = self.request("thread/turns/list", json!({
                "threadId": thread_id, "cursor": cursor, "limit": 25, "itemsView": "full", "sortDirection": "desc"
            }))?;
            if let Some(turn) = page["data"].as_array().and_then(|turns| {
                turns.iter().find(|turn| has_queued_message(turn, message_id))
            }) {
                return Ok(turn["id"].as_str().map(|id| (id.to_owned(), recorded_outcome(turn))));
            }
            let next = &page["nextCursor"];
            let oldest = page["data"].as_array().and_then(|turns| turns.last());
            if !next.is_string() || next == &cursor
                || oldest.and_then(|turn| turn["startedAt"].as_i64()).is_some_and(|time| time < submitted_at)
            {
                return Ok(None);
            }
            cursor = next.clone();
        }
    }

    pub fn turn_outcome(
        &mut self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Option<TurnOutcome>, String> {
        let mut cursor = Value::Null;
        loop {
            let page = match self.request(
                "thread/turns/list",
                json!({
                    "threadId": thread_id, "cursor": cursor, "limit": 25, "itemsView": "summary"
                }),
            ) {
                Ok(page) => page,
                Err(error)
                    if error.contains("unknown variant") || error.contains("Method not found") =>
                {
                    let history = self.request(
                        "thread/read",
                        json!({ "threadId": thread_id, "includeTurns": true }),
                    )?;
                    return Ok(history["thread"]["turns"].as_array().and_then(|turns| {
                        turns
                            .iter()
                            .find(|turn| turn["id"] == turn_id)
                            .and_then(recorded_outcome)
                    }));
                }
                Err(error) => return Err(error),
            };
            if let Some(turn) = page["data"]
                .as_array()
                .and_then(|turns| turns.iter().find(|turn| turn["id"] == turn_id))
            {
                return Ok(recorded_outcome(turn));
            }
            let next = &page["nextCursor"];
            if !next.is_string() || next == &cursor {
                return Ok(None);
            }
            cursor = next.clone();
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(&json!({ "id": id, "method": method, "params": params }))?;
        loop {
            let message = self.read(Duration::from_secs(30))?;
            if message.get("method").is_some() || message["id"].as_u64() != Some(id) {
                continue;
            }
            return message.get("result").cloned().ok_or_else(|| {
                message["error"]["message"]
                    .as_str()
                    .unwrap_or("Codex 请求失败")
                    .chars()
                    .take(300)
                    .collect()
            });
        }
    }

    fn write(&mut self, message: &Value) -> Result<(), String> {
        let input = self.input.as_mut().ok_or("Codex 连接已关闭")?;
        writeln!(input, "{message}").map_err(|_| "无法向 Codex 发送请求".into())
    }

    fn read(&mut self, timeout: Duration) -> Result<Value, String> {
        let message = self
            .messages
            .recv_timeout(timeout)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => "Codex 响应超时",
                mpsc::RecvTimeoutError::Disconnected => {
                    "Codex 已断开连接，请检查本机 Codex 是否可用"
                }
            })?;
        if message["method"].is_string() {
            if let Some(id) = message.get("id") {
                self.write(&json!({ "id": id, "error": { "code": -32601, "message": "Unsupported by todolist" } }))?;
            }
            #[cfg(not(windows))]
            if message.get("id").is_none() && message["method"] == "turn/completed" {
                let turn = &message["params"]["turn"];
                self.completed_turn = turn["id"].as_str().map(|id| {
                    let outcome = if turn["status"] == "interrupted" {
                        Some(TurnOutcome::Unsuccessful)
                    } else {
                        recorded_outcome(turn)
                    };
                    (id.to_owned(), outcome)
                });
            }
        }
        Ok(message)
    }
}

fn has_queued_message(turn: &Value, message_id: &str) -> bool {
    turn["items"].as_array().is_some_and(|items| items.iter().any(|item| {
        item["type"] == "userMessage" && item["clientId"] == message_id
    }))
}

fn recorded_outcome(turn: &Value) -> Option<TurnOutcome> {
    match turn["status"].as_str()? {
        "completed" => Some(TurnOutcome::Completed),
        "failed" => Some(TurnOutcome::Unsuccessful),
        // A read from a separate server can describe a still-running turn as interrupted.
        _ => None,
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        drop(self.input.take());
        for _ in 0..25 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_server() -> Result<Child, String> {
    #[cfg(windows)]
    if let Some(path) = registered_desktop_cli() {
        if let Ok(child) = spawn(&mut Command::new(path)) {
            return Ok(child);
        }
    }
    #[cfg(windows)]
    let mut command = Command::new("codex.exe");
    #[cfg(not(windows))]
    let mut command = Command::new("codex");
    match spawn(&mut command) {
        Ok(child) => return Ok(child),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err("无法启动本机 Codex".into()),
    }
    #[cfg(windows)]
    if let Some(npm) = std::env::var_os("APPDATA") {
        let script =
            std::path::PathBuf::from(npm).join("npm/node_modules/@openai/codex/bin/codex.js");
        if script.is_file() {
            return spawn(Command::new("node.exe").arg(script))
                .map_err(|_| "无法启动本机 Codex CLI".into());
        }
    }
    Err("找不到本机 Codex，请安装 Codex CLI 并确保它可从 PATH 启动".into())
}

#[cfg(windows)]
fn registered_desktop_cli() -> Option<std::path::PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, ptr::null_mut};
    use windows_sys::{
        core::w,
        Win32::{
            Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS},
            Storage::Packaging::Appx::{GetPackagePathByFullName, GetPackagesByPackageFamily},
        },
    };

    // A running app can still have the previous package's versioned directory on PATH.
    let family = w!("OpenAI.Codex_2p2nqsd0c76g0");
    let mut count = 0;
    let mut length = 0;
    let status = unsafe {
        GetPackagesByPackageFamily(family, &mut count, null_mut(), &mut length, null_mut())
    };
    if status != ERROR_INSUFFICIENT_BUFFER {
        return None;
    }
    let mut names = vec![null_mut(); count as usize];
    let mut buffer = vec![0; length as usize];
    let status = unsafe {
        GetPackagesByPackageFamily(
            family,
            &mut count,
            names.as_mut_ptr(),
            &mut length,
            buffer.as_mut_ptr(),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }

    // The returned names point into `buffer`, which stays alive during the lookups.
    names.into_iter().take(count as usize).find_map(|name| {
        let mut length = 0;
        if unsafe { GetPackagePathByFullName(name, &mut length, null_mut()) }
            != ERROR_INSUFFICIENT_BUFFER
        {
            return None;
        }
        let mut path = vec![0; length as usize];
        if unsafe { GetPackagePathByFullName(name, &mut length, path.as_mut_ptr()) }
            != ERROR_SUCCESS
        {
            return None;
        }
        let directory = OsString::from_wide(&path[..length as usize - 1]);
        let cli = Path::new(&directory).join("app/resources/codex.exe");
        cli.is_file().then_some(cli)
    })
}

fn spawn(command: &mut Command) -> std::io::Result<Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

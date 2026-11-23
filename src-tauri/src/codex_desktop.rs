use serde_json::{json, Value};
use std::{
    io::{self, Read, Write},
    time::{Duration, Instant},
};

const MAX_FRAME: usize = 16 * 1024 * 1024;
const NO_CONFIRMATION: &str = "未收到 Codex 的发送确认，请先在目标对话中核对。";

#[cfg(windows)]
pub fn open_thread(thread_id: &str) -> Result<(), String> {
    open_link(&thread_link(thread_id, None)?)
}

#[cfg(any(windows, test))]
fn thread_link(thread_id: &str, prompt: Option<&str>) -> Result<reqwest::Url, String> {
    if thread_id.len() != 36
        || !thread_id
            .bytes()
            .enumerate()
            .all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => byte == b'-',
                _ => byte.is_ascii_hexdigit(),
            })
    {
        return Err("无法识别此 Codex 对话编号".into());
    }
    let mut link = reqwest::Url::parse(&format!("codex://threads/{thread_id}"))
        .map_err(|_| "无法识别此 Codex 对话编号".to_owned())?;
    if let Some(prompt) = prompt {
        link.query_pairs_mut().append_pair("prompt", prompt);
    }
    Ok(link)
}

#[cfg(windows)]
fn open_link(link: &reqwest::Url) -> Result<(), String> {
    use std::ptr::null;
    use windows_sys::{
        core::w,
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };

    let url: Vec<u16> = link.as_str()
        .encode_utf16()
        .chain([0])
        .collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            w!("open"),
            url.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err("无法打开 Codex 桌面端，请确认已安装后重试".into());
    }
    Ok(())
}

#[cfg(windows)]
pub fn open_draft(thread_id: &str, prompt: &str) -> Result<(), String> {
    open_link(&thread_link(thread_id, Some(prompt))?)
}

#[cfg(windows)]
pub fn try_send(thread_id: &str, prompt: &str) -> Result<Option<String>, String> {
    use std::{
        fs::OpenOptions,
        os::windows::fs::OpenOptionsExt,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(0);
    open_thread(thread_id)?;
    let started = Instant::now();
    let connect_deadline = started + Duration::from_secs(2);
    let pipe = loop {
        let result = OpenOptions::new()
            .read(true)
            .write(true)
            .security_qos_flags(0x0010_0000 | 0x0001_0000) // SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION
            .open(r"\\.\pipe\codex-ipc");
        if let Ok(pipe) = result {
            break pipe;
        }
        if Instant::now() >= connect_deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(150));
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let sequence = NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed);
    let prefix = format!(
        "todolist-{}-{}-{sequence}",
        std::process::id(),
        now.as_nanos()
    );
    let owner_deadline = started + Duration::from_secs(12);
    let transport = DesktopPipe {
        file: pipe,
        deadline: owner_deadline + Duration::from_secs(34),
    };
    send_to_owner(transport, &prefix, thread_id, prompt, owner_deadline)
}

fn send_to_owner(
    transport: impl Read + Write,
    request_prefix: &str,
    thread_id: &str,
    prompt: &str,
    owner_deadline: Instant,
) -> Result<Option<String>, String> {
    let mut client = Client {
        transport,
        source_id: String::new(),
        request_prefix,
        next_id: 0,
    };
    let Ok(initialized) = client.request(
        "initialize",
        1,
        json!({ "clientType": "todolist" }),
        None,
        3_000,
    ) else {
        return Ok(None);
    };
    let Some(client_id) = initialized["result"]["clientId"].as_str() else {
        return Ok(None);
    };
    client.source_id = client_id.to_owned();
    let owner = loop {
        let Ok(discovery) = client.request(
            "thread-owner-discovery",
            1,
            json!({ "hostId": "local", "conversationId": thread_id }),
            None,
            3_000,
        ) else {
            return Ok(None);
        };
        if discovery["resultType"] == "success" {
            if let Some(owner) = discovery["handledByClientId"].as_str() {
                break owner.to_owned();
            }
        }
        if Instant::now() >= owner_deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(150));
    };

    // Local app servers can reject the desktop-only turn/addUserMessage extension.
    let response = client.request("thread-follower-start-turn", 2, json!({
        "conversationId": thread_id,
        "turnStart": {
            "request": { "threadId": thread_id, "input": crate::codex_dispatch::text_input(prompt) },
            "context": { "inheritThreadSettings": true, "useUserMessageAdmission": false }
        }
    }), Some(&owner), 30_000).map_err(|_| NO_CONFIRMATION.to_owned())?;
    if response["resultType"] == "success" {
        let turn = &response["result"]["result"]["turn"];
        if matches!(turn["status"].as_str(), Some("failed" | "interrupted")) {
            return Err("Codex 未能启动这次任务".into());
        }
        if let Some(id) = turn["id"].as_str() {
            return Ok(Some(id.to_owned()));
        }
    }
    let error = response["error"].as_str().unwrap_or_default();
    if error == "no-client-found" && response.get("handledByClientId").is_none() {
        // The router found no recipient and did not forward the turn request.
        return Ok(None);
    }
    if !error.is_empty()
        && !matches!(error, "timeout" | "connection-closed")
        && !error.ends_with("-timeout")
    {
        let details = error.chars().take(240).collect::<String>();
        return Err(format!("Codex 未接受发送。{details}"));
    }
    Err(NO_CONFIRMATION.into())
}

struct Client<'a, T> {
    transport: T,
    source_id: String,
    request_prefix: &'a str,
    next_id: u64,
}

impl<T: Read + Write> Client<'_, T> {
    fn request(
        &mut self,
        method: &str,
        version: u8,
        params: Value,
        target: Option<&str>,
        timeout_ms: u32,
    ) -> io::Result<Value> {
        self.next_id += 1;
        let id = format!("{}-{}", self.request_prefix, self.next_id);
        let mut message = json!({
            "type": "request", "requestId": id, "sourceClientId": self.source_id,
            "version": version, "method": method, "params": params, "timeoutMs": timeout_ms
        });
        if let Some(target) = target {
            message["targetClientId"] = json!(target);
        }
        let body = serde_json::to_vec(&message)?;
        if body.len() > MAX_FRAME {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut frame = (body.len() as u32).to_le_bytes().to_vec();
        frame.extend(body);
        self.transport.write_all(&frame)?;
        self.transport.flush()?;
        loop {
            let reply = read_frame(&mut self.transport)?;
            if reply["type"] == "response" && reply["requestId"] == id {
                return Ok(reply);
            }
        }
    }
}

fn read_frame(reader: &mut impl Read) -> io::Result<Value> {
    let mut length = [0; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_FRAME {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

#[cfg(windows)]
struct DesktopPipe {
    file: std::fs::File,
    deadline: std::time::Instant,
}

#[cfg(windows)]
impl Read for DesktopPipe {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        use std::{
            os::windows::io::AsRawHandle,
            ptr::null_mut,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::System::Pipes::PeekNamedPipe;
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            if Instant::now() >= self.deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            let mut available = 0;
            let ready = unsafe {
                PeekNamedPipe(
                    self.file.as_raw_handle(),
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            };
            if ready == 0 {
                return Err(io::Error::last_os_error());
            }
            if available > 0 {
                let length = buffer.len().min(available as usize);
                return self.file.read(&mut buffer[..length]);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[cfg(windows)]
impl Write for DesktopPipe {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.file.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct Fixture<'a> {
        incoming: Cursor<Vec<u8>>,
        outgoing: &'a mut Vec<u8>,
    }

    impl Read for Fixture<'_> {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.incoming.read(bytes)
        }
    }

    impl Write for Fixture<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.outgoing.write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn relay(
        replies: &[Value],
        owner_wait: Duration,
    ) -> (Result<Option<String>, String>, Vec<Value>) {
        let mut incoming = Vec::new();
        for (index, response) in replies.iter().enumerate() {
            let mut response = response.clone();
            response["type"] = json!("response");
            response["requestId"] = json!(format!("fixture-{}", index + 1));
            let body = serde_json::to_vec(&response).unwrap();
            incoming.extend((body.len() as u32).to_le_bytes());
            incoming.extend(body);
        }
        let mut raw_requests = Vec::new();
        let transport = Fixture {
            incoming: Cursor::new(incoming),
            outgoing: &mut raw_requests,
        };
        let result = send_to_owner(
            transport,
            "fixture",
            "existing-thread",
            "处理事项\n\n附带说明",
            Instant::now() + owner_wait,
        );
        let mut requests = Cursor::new(raw_requests);
        let requests = std::iter::from_fn(|| read_frame(&mut requests).ok()).collect();
        (result, requests)
    }

    fn initialized() -> Value {
        json!({ "resultType": "success", "result": { "clientId": "board-client" } })
    }
    fn discovered() -> Value {
        json!({ "resultType": "success", "handledByClientId": "desktop-owner" })
    }

    #[test]
    fn draft_link_preserves_the_target_and_full_prompt() {
        let thread = "018ffeef-11a2-705a-9a5b-0123456789ab";
        let prompt = "处理事项\n\n附带说明：a & b + 100%，保留 # 与 ?。";
        let draft = thread_link(thread, Some(prompt)).unwrap();
        assert_eq!(draft.scheme(), "codex");
        assert_eq!(draft.host_str(), Some("threads"));
        assert_eq!(draft.path(), format!("/{thread}"));
        assert_eq!(draft.query_pairs().into_owned().collect::<Vec<_>>(), [("prompt".to_owned(), prompt.to_owned())]);
        assert!(thread_link(thread, None).unwrap().query().is_none());
        assert!(thread_link("new", Some(prompt)).is_err());
    }

    #[test]
    fn forwards_a_loaded_conversation_to_its_current_writer() {
        let accepted = json!({ "resultType": "success", "result": { "result": { "turn": { "id": "accepted-turn" } } } });
        let (result, requests) = relay(&[initialized(), discovered(), accepted], Duration::ZERO);
        assert_eq!(result, Ok(Some("accepted-turn".into())));
        assert_eq!(requests[1]["method"], "thread-owner-discovery");
        assert_eq!(requests[1]["params"]["hostId"], "local");
        let send = &requests[2];
        assert_eq!(send["method"], "thread-follower-start-turn");
        assert_eq!(send["sourceClientId"], "board-client");
        assert_eq!(send["targetClientId"], "desktop-owner");
        assert_eq!(
            send["params"]["turnStart"]["context"]["useUserMessageAdmission"], false,
            "local conversations must use the standard turn/start method"
        );
        assert_eq!(
            send["params"]["turnStart"]["request"]["threadId"],
            "existing-thread"
        );
        assert_eq!(
            send["params"]["turnStart"]["request"]["input"],
            json!([{ "type": "text", "text": "处理事项\n\n附带说明", "text_elements": [] }]),
            "the desktop renders this input before the app server normalizes it"
        );
    }

    #[test]
    fn waits_for_desktop_to_load_a_closed_conversation_before_sending() {
        let (result, requests) = relay(
            &[
                initialized(),
                json!({ "resultType": "error", "error": "no-client-found" }),
                discovered(),
                json!({ "resultType": "success", "result": { "result": { "turn": { "id": "accepted-turn" } } } }),
            ],
            Duration::from_secs(2),
        );
        assert_eq!(result, Ok(Some("accepted-turn".into())));
        assert_eq!(requests[1]["method"], "thread-owner-discovery");
        assert_eq!(requests[2]["method"], "thread-owner-discovery");
        assert_eq!(requests[3]["method"], "thread-follower-start-turn");
    }

    #[test]
    fn distinguishes_missing_ownership_from_an_unconfirmed_send() {
        let not_found = json!({ "resultType": "error", "error": "no-client-found" });
        let (no_owner, requests) = relay(&[initialized(), not_found.clone()], Duration::ZERO);
        assert_eq!(no_owner, Ok(None));
        assert_eq!(requests.len(), 2);
        let (owner_gone, requests) =
            relay(&[initialized(), discovered(), not_found], Duration::ZERO);
        assert_eq!(owner_gone, Ok(None));
        assert_eq!(requests.len(), 3);
        let (timeout, _) = relay(
            &[
                initialized(),
                discovered(),
                json!({ "resultType": "error", "error": "thread-follower-start-turn-timeout" }),
            ],
            Duration::ZERO,
        );
        assert_eq!(timeout, Err(NO_CONFIRMATION.into()));
    }
}

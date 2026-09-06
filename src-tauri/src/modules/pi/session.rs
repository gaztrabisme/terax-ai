use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use shared_child::SharedChild;

use crate::modules::proc::hide_console;

/// Everything needed to spawn one pi session. The Tauri command layer fills
/// this from user input; tests build it directly with stub scripts.
#[derive(Debug)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
}

pub struct PiSession {
    pub pid: u32,
    child: Arc<SharedChild>,
    stdin: Mutex<Option<ChildStdin>>,
}

impl PiSession {
    /// Writes exactly one JSON line to pi's stdin. Newlines inside `line` are
    /// rejected upstream: a stray newline would split one command into two.
    pub fn send_line(&self, line: &str) -> Result<(), String> {
        if line.contains('\n') || line.contains('\r') {
            return Err("line must not contain newlines".to_string());
        }
        let mut guard = self.stdin.lock().map_err(|_| "stdin mutex poisoned")?;
        let stdin = guard.as_mut().ok_or_else(|| "stdin closed".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| {
                log::debug!("pi_send pid={} failed: {e}", self.pid);
                e.to_string()
            })
    }

    /// Kills the pi process by explicit pid. Never pattern-kills.
    pub fn kill(&self) -> Result<(), String> {
        self.child.kill().map_err(|e| {
            log::debug!("pi_kill pid={} returned {e}", self.pid);
            e.to_string()
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn try_wait(&self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|s| s.is_some())
            .map_err(|e| e.to_string())
    }

    fn close_stdin(&self) {
        if let Ok(mut guard) = self.stdin.lock() {
            *guard = None;
        }
    }
}

impl Drop for PiSession {
    fn drop(&mut self) {
        // A session Arc that outlives its map entry (webview reload, dev HMR)
        // must not orphan the pi child: kill so the reader threads hit EOF.
        self.close_stdin();
        let _ = self.child.kill();
    }
}

/// A stdout line is protocol output only when it starts a JSON object. The
/// efficient-pi launcher prints its `[n/8]` step banner to stdout before exec'ing
/// pi, so banner lines are dropped rather than parsed.
pub fn is_json_line(line: &str) -> bool {
    line.trim_start().starts_with('{')
}

/// Drains `reader`, forwarding each JSON line and dropping banner lines.
/// Pure over its inputs: tests feed a byte cursor and collect into a Vec.
pub fn pump_lines<R: BufRead>(reader: R, mut emit: impl FnMut(&str)) {
    for line in reader.lines() {
        match line {
            Ok(line) => {
                if is_json_line(&line) {
                    emit(&line);
                } else {
                    log::debug!("pi banner/stdout noise dropped: {line}");
                }
            }
            Err(e) => {
                log::debug!("pi stdout reader ended: {e}");
                break;
            }
        }
    }
}

/// Spawns the process described by `spec` and streams one event per stdout
/// JSON line. `on_event` also receives stderr lines wrapped as
/// `{"type":"stderr","line":...}` so install problems stay diagnosable
/// without polluting the protocol stream. `on_exit` fires once with the
/// wait status after the reader threads have drained.
pub fn spawn_session<E, X>(
    spec: SpawnSpec,
    on_event: E,
    on_exit: X,
) -> Result<Arc<PiSession>, String>
where
    // Fn + Clone so the stdout and stderr readers each get their own handle
    // (Channel<String> and mpsc::Sender are both Clone).
    E: Fn(String) + Clone + Send + 'static,
    X: FnOnce(i32) + Send + 'static,
{
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = spec.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.envs(&spec.env);
    hide_console(&mut cmd);

    let shared = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| {
        log::warn!("pi spawn {:?} failed: {e}", spec.program);
        e.to_string()
    })?);
    let pid = shared.id();

    // If any pipe is missing, kill rather than orphan a half-wired child.
    let kill_on_fail = || {
        let _ = shared.kill();
    };
    let stdin = shared.take_stdin().ok_or_else(|| {
        kill_on_fail();
        "no stdin pipe".to_string()
    })?;
    let stdout = shared.take_stdout().ok_or_else(|| {
        kill_on_fail();
        "no stdout pipe".to_string()
    })?;
    let stderr = shared.take_stderr().ok_or_else(|| {
        kill_on_fail();
        "no stderr pipe".to_string()
    })?;

    let session = Arc::new(PiSession {
        pid,
        child: shared,
        stdin: Mutex::new(Some(stdin)),
    });

    let stdout_events = on_event.clone();
    let stdout_thread = thread::Builder::new()
        .name(format!("terax-pi-stdout-{pid}"))
        .spawn(move || {
            pump_lines(BufReader::new(stdout), move |line| {
                stdout_events(line.to_string())
            })
        })
        .map_err(|e| e.to_string())?;

    let stderr_thread = thread::Builder::new()
        .name(format!("terax-pi-stderr-{pid}"))
        .spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let wrapped = serde_json::json!({ "type": "stderr", "line": line }).to_string();
                on_event(wrapped);
            }
        })
        .map_err(|e| e.to_string())?;

    let waiter_child = Arc::clone(&session.child);
    // Weak on purpose: a strong Arc here would keep PiSession alive until
    // wait() returns, so Drop could never kill a hung child.
    let waiter_session = Arc::downgrade(&session);
    thread::Builder::new()
        .name(format!("terax-pi-waiter-{pid}"))
        .spawn(move || {
            let code = match waiter_child.wait() {
                // Signal death reports None; map it to the pty convention.
                Ok(status) => status.code().unwrap_or(-1),
                Err(e) => {
                    log::warn!("pi child wait failed pid={pid}: {e}");
                    -1
                }
            };
            // The readers exit on pipe EOF, so once both are joined every
            // event has been sent: no line ever races the exit code.
            if let Err(e) = stdout_thread.join() {
                log::error!("pi stdout thread panicked pid={pid}: {e:?}");
            }
            if let Err(e) = stderr_thread.join() {
                log::error!("pi stderr thread panicked pid={pid}: {e:?}");
            }
            // Close stdin so a pi that ignores EOF-on-stdout can't stall. If
            // the session is already gone, Drop closed stdin before killing.
            if let Some(s) = waiter_session.upgrade() {
                s.close_stdin();
            }
            on_exit(code);
        })
        .map_err(|e| e.to_string())?;

    log::info!("pi session spawned pid={pid} program={:?}", spec.program);
    Ok(session)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc;
    use std::time::Duration;

    fn write_stub(dir: &tempfile::TempDir, name: &str, body: &str) -> String {
        let path = dir.path().join(name);
        std::fs::write(&path, body).expect("write stub");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod stub");
        path.to_string_lossy().into_owned()
    }

    struct Collected {
        events: mpsc::Receiver<String>,
        exit: mpsc::Receiver<i32>,
        session: Arc<PiSession>,
    }

    fn spawn_stub(script: &str) -> Collected {
        let dir = tempfile::tempdir().expect("tempdir");
        let program = write_stub(&dir, "stub.sh", script);
        // The tempdir must outlive the child; leak it for the test lifetime.
        std::mem::forget(dir);
        let (tx, events) = mpsc::channel();
        let (etx, exit) = mpsc::channel();
        let spec = SpawnSpec {
            program,
            args: vec![],
            cwd: None,
            env: HashMap::new(),
        };
        let session = spawn_session(
            spec,
            move |line| tx.send(line).expect("send"),
            move |code| etx.send(code).expect("send"),
        )
        .expect("spawn stub");
        Collected {
            events,
            exit,
            session,
        }
    }

    fn collect_n(rx: &mpsc::Receiver<String>, n: usize) -> Vec<String> {
        let mut out = Vec::new();
        for _ in 0..n {
            out.push(rx.recv_timeout(Duration::from_secs(5)).expect("event"));
        }
        out
    }

    #[test]
    fn json_lines_arrive_in_order_and_banners_are_dropped() {
        let stub = "#!/bin/sh\necho '[1/8] booting'\necho '{\"type\":\"agent_start\"}'\necho '[2/8] still going'\necho '{\"type\":\"agent_end\"}'\n";
        let run = spawn_stub(stub);
        let code = run
            .exit
            .recv_timeout(Duration::from_secs(5))
            .expect("exit code");
        assert_eq!(code, 0);
        // The waiter joins the readers before firing on_exit, so all events
        // are already buffered once the exit code arrives.
        assert_eq!(
            collect_n(&run.events, 2),
            vec![
                "{\"type\":\"agent_start\"}".to_string(),
                "{\"type\":\"agent_end\"}".to_string(),
            ]
        );
    }

    #[test]
    fn exit_code_is_delivered() {
        let run = spawn_stub("#!/bin/sh\nexit 7\n");
        let code = run
            .exit
            .recv_timeout(Duration::from_secs(5))
            .expect("exit code");
        assert_eq!(code, 7);
    }

    #[test]
    fn send_line_reaches_child_stdin() {
        let run = spawn_stub("#!/bin/sh\nwhile read -r line; do echo \"$line\"; done\n");
        run.session
            .send_line("{\"type\":\"prompt\"}")
            .expect("send");
        let line = run
            .events
            .recv_timeout(Duration::from_secs(5))
            .expect("echoed line");
        assert_eq!(line, "{\"type\":\"prompt\"}");
        run.session.kill().expect("kill");
        let _ = run.exit.recv_timeout(Duration::from_secs(5));
    }

    #[test]
    fn kill_terminates_by_pid() {
        let run = spawn_stub("#!/bin/sh\nwhile :; do sleep 1; done\n");
        assert!(
            !run.session.try_wait().expect("try_wait"),
            "stub must be running before kill"
        );
        run.session.kill().expect("kill");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if run.session.try_wait().expect("try_wait") {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("stub still running 5s after kill");
    }

    #[test]
    fn stderr_lines_arrive_tagged_and_parseable() {
        let run = spawn_stub("#!/bin/sh\necho 'boom' >&2\n");
        let code = run
            .exit
            .recv_timeout(Duration::from_secs(5))
            .expect("exit code");
        assert_eq!(code, 0);
        let events = collect_n(&run.events, 1);
        let parsed: serde_json::Value =
            serde_json::from_str(&events[0]).expect("tagged stderr json");
        assert_eq!(parsed["type"], "stderr");
        assert_eq!(parsed["line"], "boom");
    }

    #[test]
    fn send_line_rejects_embedded_newlines() {
        let run = spawn_stub("#!/bin/sh\nsleep 0.1\n");
        let err = run.session.send_line("a\nb").expect_err("must reject");
        assert!(err.contains("newlines"));
        run.session.kill().expect("kill");
        let _ = run.exit.recv_timeout(Duration::from_secs(5));
    }

    #[test]
    fn drop_kills_child() {
        let dir = tempfile::tempdir().expect("tempdir");
        let program = write_stub(&dir, "sleepy.sh", "#!/bin/sh\nwhile :; do sleep 1; done\n");
        let spec = SpawnSpec {
            program,
            args: vec![],
            cwd: None,
            env: HashMap::new(),
        };
        let session = spawn_session(spec, |_| {}, |_| {}).expect("spawn");
        let pid = session.pid as i32;
        drop(session);
        // Signal-0 probe: existence check only, on a pid this test spawned.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "stub pid={pid} alive 5s after session drop"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn pump_lines_filters_non_json_without_consuming_the_rest() {
        let input = b"[1/8] launcher banner\n{\"type\":\"a\"}\n   {\"type\":\"b\"}\nnot json\n{\"type\":\"c\"}\n";
        let mut seen = Vec::new();
        pump_lines(&input[..], |line| seen.push(line.to_string()));
        // Lines pass through untrimmed: pi's JSONL carries no leading space and
        // protocol bytes must not be mutated by the filter.
        assert_eq!(
            seen,
            vec![
                "{\"type\":\"a\"}".to_string(),
                "   {\"type\":\"b\"}".to_string(),
                "{\"type\":\"c\"}".to_string(),
            ]
        );
    }
}

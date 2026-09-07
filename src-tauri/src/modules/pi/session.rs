use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use shared_child::SharedChild;

use super::launcher;
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

/// Board env both spawn paths share, so the board extension behaves the same
/// under the checkout launcher and the direct spawn: HARNESS_DB pins the
/// per-project board DB the bin/board shim defaults to anyway, and
/// PI_BOARD_AGENT_BIN pins the resolved harness agent binary (the shim's
/// AGENT_BIN default only exists on the checkout machine). The agent entry is
/// omitted when nothing resolved, so a missing optional binary never blocks
/// a spawn.
pub fn add_board_env(env: &mut HashMap<String, String>, cwd: &Path, agent_bin: Option<&str>) {
    env.insert(
        "HARNESS_DB".to_string(),
        cwd.join(".pi")
            .join("board.db")
            .to_string_lossy()
            .into_owned(),
    );
    if let Some(bin) = agent_bin {
        env.insert("PI_BOARD_AGENT_BIN".to_string(), bin.to_string());
    }
}

/// The direct path's step record: one `[k/4] <name> ... OK` (or
/// `... FAIL <detail>`) line per prepare step, in the launcher's banner
/// shape, so `<cwd>/.pi/launcher.log` reads like the bash launcher's output.
pub fn format_launcher_log(report: &launcher::PrepareReport) -> String {
    let total = report.steps.len();
    report
        .steps
        .iter()
        .enumerate()
        .map(|(i, step)| {
            let head = format!("[{}/{}] {} ...", i + 1, total, step.name);
            if step.ok {
                format!("{head} OK\n")
            } else {
                format!("{head} FAIL {}\n", step.detail)
            }
        })
        .collect()
}

/// Prepares a direct spawn: runs the four launcher steps, truncates
/// `<cwd>/.pi/launcher.log` with their outcome, and on any failed step
/// refuses the spawn with the text the frontend shows as entry.error. The
/// report's env overlays `base_env`, replacing the frontend's
/// EFFICIENT_PI_* and PI_CODING_AGENT_DIR values with the prepared ones.
pub fn prepare_direct(
    input: launcher::PrepareInput,
    agent_bin: Option<&str>,
    base_env: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let cwd = input.cwd.clone();
    let report = launcher::prepare_session(input);
    let log_path = cwd.join(".pi").join("launcher.log");
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    fs::write(&log_path, format_launcher_log(&report))
        .map_err(|e| format!("cannot write {}: {e}", log_path.display()))?;
    if let Some(step) = report.steps.iter().find(|s| !s.ok) {
        return Err(format!("{} failed: {}", step.name, step.detail));
    }
    let mut env = base_env;
    env.extend(report.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    add_board_env(&mut env, &cwd, agent_bin);
    Ok(env)
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

    fn make_report() -> launcher::PrepareReport {
        launcher::PrepareReport {
            steps: vec![
                launcher::PrepareStep {
                    name: "seed".to_string(),
                    ok: true,
                    detail: "agent dir ready at /data/pi-home/agent".to_string(),
                },
                launcher::PrepareStep {
                    name: "render".to_string(),
                    ok: false,
                    detail: "OMLX_KEY not set; cannot render models.json".to_string(),
                },
                launcher::PrepareStep {
                    name: "root".to_string(),
                    ok: true,
                    detail: "project root: /p".to_string(),
                },
                launcher::PrepareStep {
                    name: "wiki".to_string(),
                    ok: true,
                    detail: "wiki files present".to_string(),
                },
            ],
            agent_dir: "/data/pi-home/agent".into(),
            env: Default::default(),
        }
    }

    #[test]
    fn launcher_log_lines_follow_the_banner_shape() {
        assert_eq!(
            format_launcher_log(&make_report()),
            "[1/4] seed ... OK\n\
             [2/4] render ... FAIL OMLX_KEY not set; cannot render models.json\n\
             [3/4] root ... OK\n\
             [4/4] wiki ... OK\n"
        );
    }

    #[test]
    fn board_env_pins_the_db_and_the_resolved_agent_only() {
        let mut env = HashMap::new();
        add_board_env(&mut env, Path::new("/p"), Some("/bin/agent"));
        assert_eq!(
            env.get("HARNESS_DB").map(String::as_str),
            Some("/p/.pi/board.db")
        );
        assert_eq!(
            env.get("PI_BOARD_AGENT_BIN").map(String::as_str),
            Some("/bin/agent")
        );
        // No resolved agent: the DB pin stays, the missing binary is omitted.
        let mut env = HashMap::new();
        add_board_env(&mut env, Path::new("/p"), None);
        assert!(env.contains_key("HARNESS_DB"));
        assert!(!env.contains_key("PI_BOARD_AGENT_BIN"));
    }

    /// Minimal template: seed only needs the dir to exist, render only the
    /// models.json.tmpl; every other managed entry is optional.
    fn write_min_template(dir: &Path) -> std::path::PathBuf {
        let tmpl = dir.join("tmpl");
        fs::create_dir_all(&tmpl).expect("mkdir");
        fs::write(
            tmpl.join("models.json.tmpl"),
            r#"{"baseUrl": "http://__BPPC_HOST__:8080/v1", "apiKey": "__OMLX_KEY__"}"#,
        )
        .expect("write tmpl");
        tmpl
    }

    #[test]
    fn direct_path_prepares_env_and_log_then_spawns_the_fake_pi() {
        let tmpl_dir = tempfile::tempdir().expect("tempdir");
        let tmpl = write_min_template(tmpl_dir.path());
        let app_data = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        fs::create_dir(project.path().join(".git")).expect("gitdir");
        // Fake pi and agent: the pi stub prints nothing and exits 0.
        let stubs = tempfile::tempdir().expect("tempdir");
        let fake_pi = write_stub(&stubs, "pi", "#!/bin/sh\nexit 0\n");
        let fake_agent = write_stub(&stubs, "agent", "#!/bin/sh\nexit 0\n");

        let env = prepare_direct(
            launcher::PrepareInput {
                app_version: "0.7.3".to_string(),
                template_dir: tmpl,
                app_data_dir: app_data.path().to_path_buf(),
                cwd: project.path().to_path_buf(),
                roles: launcher::PrepareRoles {
                    provider: "bppc".to_string(),
                    model: "qwen3.8-27b".to_string(),
                    thinking: "xhigh".to_string(),
                    smol: "omlx/Qwen3.6-35B-A3B-OptiQ-4bit".to_string(),
                },
                endpoints: launcher::PrepareEndpoints {
                    bppc_host: "10.0.0.9".to_string(),
                    omlx_key: "sk-omlx".to_string(),
                },
                allow_any_dir: false,
            },
            Some(fake_agent.as_str()),
            HashMap::new(),
        )
        .expect("direct prep");

        let log =
            fs::read_to_string(project.path().join(".pi").join("launcher.log")).expect("log");
        assert_eq!(
            log,
            "[1/4] seed ... OK\n\
             [2/4] render ... OK\n\
             [3/4] root ... OK\n\
             [4/4] wiki ... OK\n"
        );
        let agent_dir = app_data.path().join("pi-home").join("agent");
        assert_eq!(
            env.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some(agent_dir.to_str().expect("utf8"))
        );
        assert_eq!(
            env.get("EFFICIENT_PI_PROVIDER").map(String::as_str),
            Some("bppc")
        );
        assert_eq!(
            env.get("EFFICIENT_PI_MODEL").map(String::as_str),
            Some("qwen3.8-27b")
        );
        assert_eq!(
            env.get("EFFICIENT_PI_THINKING").map(String::as_str),
            Some("xhigh")
        );
        assert_eq!(
            env.get("EFFICIENT_PI_SMOL").map(String::as_str),
            Some("omlx/Qwen3.6-35B-A3B-OptiQ-4bit")
        );
        assert_eq!(
            env.get("HARNESS_DB").map(String::as_str),
            Some(
                project
                    .path()
                    .join(".pi")
                    .join("board.db")
                    .to_str()
                    .expect("utf8")
            )
        );
        assert_eq!(
            env.get("PI_BOARD_AGENT_BIN").map(String::as_str),
            Some(fake_agent.as_str())
        );
        assert_eq!(
            fs::read_to_string(agent_dir.join("models.json")).expect("models.json"),
            r#"{"baseUrl": "http://10.0.0.9:8080/v1", "apiKey": "sk-omlx"}"#
        );

        // The prepared env feeds the spawn the way pi_open assembles the
        // spec; rpc handshake skipped (the stub exits 0 on its own).
        let (etx, exit) = mpsc::channel();
        let spec = SpawnSpec {
            program: fake_pi,
            args: vec!["--mode".to_string(), "rpc".to_string()],
            cwd: Some(project.path().to_string_lossy().into_owned()),
            env,
        };
        let session = spawn_session(spec, |_| {}, move |code| {
            let _ = etx.send(code);
        })
        .expect("spawn fake pi");
        let code = exit
            .recv_timeout(Duration::from_secs(5))
            .expect("exit code");
        assert_eq!(code, 0);
        drop(session);
    }

    #[test]
    fn direct_path_refuses_the_spawn_and_logs_the_failing_step() {
        let tmpl_dir = tempfile::tempdir().expect("tempdir");
        let tmpl = write_min_template(tmpl_dir.path());
        let app_data = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        let err = prepare_direct(
            launcher::PrepareInput {
                app_version: "0.7.3".to_string(),
                template_dir: tmpl,
                app_data_dir: app_data.path().to_path_buf(),
                cwd: project.path().to_path_buf(),
                roles: launcher::PrepareRoles {
                    provider: "bppc".to_string(),
                    model: "m".to_string(),
                    thinking: "xhigh".to_string(),
                    smol: "omlx/s".to_string(),
                },
                endpoints: launcher::PrepareEndpoints {
                    bppc_host: String::new(),
                    omlx_key: "sk-omlx".to_string(),
                },
                allow_any_dir: false,
            },
            None,
            HashMap::new(),
        )
        .expect_err("empty project must fail the root guard");
        assert!(err.starts_with("root failed: "), "got: {err}");
        assert!(err.contains("no .git"));
        let log =
            fs::read_to_string(project.path().join(".pi").join("launcher.log")).expect("log");
        assert!(log.contains("[3/4] root ... FAIL "));
        assert!(log.contains("[4/4] wiki ... OK"), "later steps still logged");
    }
}

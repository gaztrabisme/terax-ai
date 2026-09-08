mod agent_detect;
mod da_filter;
mod journal;
#[cfg(windows)]
mod job;
mod session;
pub(crate) mod shell_init;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::thread;

use portable_pty::PtySize;
use tauri::ipc::{Channel, Response};

use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use session::Session;

pub struct PtyState {
    sessions: Arc<RwLock<HashMap<u32, Arc<Session>>>>,
    journal_gate: Arc<Mutex<()>>,
    journals: Arc<Mutex<Vec<Weak<session::JournalControl>>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            journal_gate: Arc::new(Mutex::new(())),
            journals: Arc::new(Mutex::new(Vec::new())),
            next_id: AtomicU32::new(1),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpened {
    id: u32,
    terminal_id: String,
    project: String,
}

fn journal_controls(journals: &Mutex<Vec<Weak<session::JournalControl>>>) -> Vec<Arc<session::JournalControl>> {
    let mut journals = journals.lock().unwrap();
    journals.retain(|j| j.strong_count() > 0);
    journals.iter().filter_map(Weak::upgrade).collect()
}

fn active_terminal_ids(journals: &Mutex<Vec<Weak<session::JournalControl>>>) -> Vec<String> {
    journal_controls(journals).iter().filter(|j| j.active.load(Ordering::Acquire)).map(|j| j.journal.lock().unwrap().terminal_id.clone()).collect()
}

#[tauri::command]
pub fn pty_terminal_list(state: tauri::State<PtyState>, registry: tauri::State<WorkspaceRegistry>, project: String, workspace: Option<WorkspaceEnv>) -> Result<Vec<journal::TerminalInfo>, journal::StorageError> {
    let _gate = state.journal_gate.lock().unwrap();
    let root = journal::ProjectRoot::authorized(&registry, &project, &WorkspaceEnv::from_option(workspace))?;
    journal::list(&root, &active_terminal_ids(&state.journals))
}

#[tauri::command]
pub fn pty_terminal_history(state: tauri::State<PtyState>, registry: tauri::State<WorkspaceRegistry>, project: String, terminal_id: String, workspace: Option<WorkspaceEnv>) -> Result<Vec<journal::Record>, journal::StorageError> {
    let _gate = state.journal_gate.lock().unwrap();
    let root = journal::ProjectRoot::authorized(&registry, &project, &WorkspaceEnv::from_option(workspace))?;
    for control in journal_controls(&state.journals) {
        let journal = control.journal.lock().unwrap();
        if journal.terminal_id == terminal_id && journal.root.path() == root.path() {
            return journal::history(&root, &terminal_id, control.active.load(Ordering::Acquire));
        }
    }
    journal::history(&root, &terminal_id, false)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_terminal_output(state: tauri::State<PtyState>, registry: tauri::State<WorkspaceRegistry>, project: String, terminal_id: String, block_id: Option<String>, offset: u64, length: usize, workspace: Option<WorkspaceEnv>) -> Result<Response, journal::StorageError> {
    let _gate = state.journal_gate.lock().unwrap();
    let root = journal::ProjectRoot::authorized(&registry, &project, &WorkspaceEnv::from_option(workspace))?;
    for control in journal_controls(&state.journals) {
        let journal = control.journal.lock().unwrap();
        if journal.terminal_id == terminal_id && journal.root.path() == root.path() {
            return journal::read_output(&root, &terminal_id, block_id.as_deref(), offset, length).map(Response::new);
        }
    }
    journal::read_output(&root, &terminal_id, block_id.as_deref(), offset, length).map(Response::new)
}

#[tauri::command]
pub fn pty_terminal_export(state: tauri::State<PtyState>, registry: tauri::State<WorkspaceRegistry>, project: String, terminal_id: String, block_id: String, workspace: Option<WorkspaceEnv>) -> Result<String, journal::StorageError> {
    let _gate = state.journal_gate.lock().unwrap();
    let root = journal::ProjectRoot::authorized(&registry, &project, &WorkspaceEnv::from_option(workspace))?;
    for control in journal_controls(&state.journals) {
        let journal = control.journal.lock().unwrap();
        if journal.terminal_id == terminal_id && journal.root.path() == root.path() {
            return journal::export_output(&root, &terminal_id, &block_id);
        }
    }
    journal::export_output(&root, &terminal_id, &block_id)
}

#[tauri::command]
pub fn pty_terminal_retry(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or("no session")?;
    session.journal.retry();
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
    on_journal: Channel<session::JournalEvent>,
    project: Option<String>,
) -> Result<PtyOpened, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_user_spawn_cwd(&registry, cwd.as_deref(), &workspace).map_err(|e| {
        log::warn!("pty_open: cwd rejected: {e}");
        e
    })?;
    let project = project.or_else(|| cwd.clone()).or_else(|| crate::modules::workspace::launch_cwd_snapshot().map(|p| p.to_string_lossy().into_owned())).or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().into_owned())).ok_or("no terminal project")?;
    let root = journal::ProjectRoot::authorized(&registry, &project, &workspace).map_err(|e| e.to_string())?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let terminal_id = journal::opaque_id();
    let result = PtyOpened { id, terminal_id: terminal_id.clone(), project: project.clone() };
    let gate = state.journal_gate.clone();
    let sessions = state.sessions.clone();
    let journals = state.journals.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = gate.lock().unwrap();
        let active = active_terminal_ids(&journals);
        if let Err(error) = journal::list(&root, &active) {
            let _ = on_journal.send(error.clone().into());
            return Err(error.to_string());
        }
        let journal = journal::Journal::new(root, terminal_id, cwd.clone().unwrap_or(project)).map_err(|e| e.to_string())?;
        let control = Arc::new(session::JournalControl::new(journal, on_journal));
        journals.lock().unwrap().push(Arc::downgrade(&control));
        let (session, _) = session::spawn(id, app, cols, rows, cwd, workspace, on_data, on_exit, control)?;
        sessions.write().unwrap().insert(id, session);
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(result)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // Bind to a local so the MutexGuard temporary drops before `session` —
    // see rustc note on tail-expression temporary drop order.
    let result = session
        .writer
        .lock()
        .unwrap()
        .write_all(data.as_bytes())
        .map_err(|e| {
            // EPIPE is expected if the child already exited.
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    let _gate = state.journal_gate.lock().unwrap();
    let session = state.sessions.write().unwrap().remove(&id);
    if let Some(s) = session {
        s.journal.cancel();
        if let Err(e) = s.killer.lock().unwrap().kill() {
            // Non-fatal: the child may already have exited on its own (e.g. the
            // user ran `exit`). Log so this isn't invisible during debugging.
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
        // Detached: on Windows `ClosePseudoConsole` can block until conhost
        // drains, which would freeze this Tauri worker thread and stall IPC.
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || {
                let t0 = std::time::Instant::now();
                session::drop_session(s);
                log::info!(
                    "pty session id={id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            })
            .expect("spawn pty drop thread");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}

#[tauri::command]
pub fn pty_has_foreground_process(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_process: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    Ok(shell_has_children(shell_pid))
}

// pgrep -P exits 0 when shell_pid has at least one child, 1 when none.
#[cfg(unix)]
fn shell_has_children(shell_pid: u32) -> bool {
    std::process::Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn shell_has_children(shell_pid: u32) -> bool {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32 = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32>() as u32;
        let mut found = false;
        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ParentProcessID == shell_pid {
                    found = true;
                    break;
                }
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns.
#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    let _gate = state.journal_gate.lock().unwrap();
    let drained: Vec<(u32, Arc<Session>)> = {
        let mut sessions = state.sessions.write().unwrap();
        sessions.drain().collect()
    };
    let count = drained.len();
    for (id, s) in drained {
        s.journal.cancel();
        if let Err(e) = s.killer.lock().unwrap().kill() {
            log::debug!("pty_close_all: kill id={id} returned {e}");
        }
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || session::drop_session(s))
            .expect("spawn pty drop thread");
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

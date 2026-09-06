mod launch;
mod session;
pub mod transcripts;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use tauri::ipc::Channel;

use crate::modules::workspace::{
    authorize_spawn_cwd, authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry,
};
use session::{PiSession, SpawnSpec};

pub struct PiTranscriptState {
    watchers: RwLock<HashMap<u32, Arc<transcripts::WatchHandle>>>,
    next_watch_id: AtomicU32,
}

impl Default for PiTranscriptState {
    fn default() -> Self {
        Self {
            watchers: RwLock::new(HashMap::new()),
            next_watch_id: AtomicU32::new(1),
        }
    }
}

pub struct PiState {
    sessions: RwLock<HashMap<u32, Arc<PiSession>>>,
    // Same convention as PtyState: ids start at 1 and are never reused, so 0
    // can keep meaning "unset" on the frontend.
    next_id: AtomicU32,
}

impl Default for PiState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pi_open(
    state: tauri::State<'_, PiState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cwd: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    workspace: Option<WorkspaceEnv>,
    on_event: Channel<String>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let canonical =
        authorize_user_spawn_cwd(&registry, cwd.as_deref(), &workspace).map_err(|e| {
            log::warn!("pi_open: cwd rejected: {e}");
            e
        })?;
    let env = env.unwrap_or_default();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let session = tauri::async_runtime::spawn_blocking(move || {
        let spec = match program.as_deref().map(str::trim) {
            Some(p) if !p.is_empty() => SpawnSpec {
                program: p.to_string(),
                args: args.unwrap_or_default(),
                cwd: canonical.as_ref().map(|p| p.to_string_lossy().into_owned()),
                env,
            },
            // Empty program: resolve bin/efficient-pi, then bin/pi, under cwd.
            _ => launch::resolve_spec(canonical.as_deref(), &args.unwrap_or_default(), env)?,
        };
        session::spawn_session(
            spec,
            move |line| {
                if let Err(e) = on_event.send(line) {
                    log::debug!("pi event send failed (channel closed): {e}");
                }
            },
            move |code| {
                if let Err(e) = on_exit.send(code) {
                    log::debug!("pi exit send failed (channel closed): {e}");
                }
            },
        )
    })
    .await
    .map_err(|e| {
        log::error!("pi_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pi_open failed: {e}");
        e
    })?;
    state.sessions.write().unwrap().insert(id, session);
    log::info!("pi opened id={id}");
    Ok(id)
}

#[tauri::command]
pub fn pi_send(state: tauri::State<'_, PiState>, id: u32, line: String) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pi_send: unknown id={id}");
            "no session".to_string()
        })?;
    session.send_line(&line)
}

#[tauri::command]
pub fn pi_kill(state: tauri::State<'_, PiState>, id: u32) -> Result<(), String> {
    let session = state.sessions.write().unwrap().remove(&id);
    if let Some(s) = session {
        // Non-fatal: the child may already have exited on its own.
        if let Err(e) = s.kill() {
            log::debug!("pi_kill: kill id={id} returned {e}");
        }
        log::info!("pi killed id={} pid={}", id, s.pid);
    } else {
        log::debug!("pi_kill: unknown id={id}");
    }
    Ok(())
}

#[tauri::command]
pub fn pi_watch_transcripts(
    state: tauri::State<'_, PiTranscriptState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    agent_dir: String,
    workspace: Option<WorkspaceEnv>,
    on_line: Channel<transcripts::TranscriptLine>,
) -> Result<u32, String> {
    let workspace_env = WorkspaceEnv::from_option(workspace);
    let canonical =
        authorize_spawn_cwd(&registry, Some(&agent_dir), &workspace_env)?;
    let id = state.next_watch_id.fetch_add(1, Ordering::Relaxed);
    let handle = Arc::new(transcripts::watch_with(
        canonical
            .as_deref()
            .ok_or_else(|| "agent dir required".to_string())?,
        move |line| {
            if let Err(e) = on_line.send(line) {
                log::debug!("pi transcript send failed (channel closed): {e}");
            }
        },
    )?);
    state.watchers.write().unwrap().insert(id, handle);
    log::info!("pi transcripts watched id={id}");
    Ok(id)
}

#[tauri::command]
pub fn pi_unwatch(
    state: tauri::State<'_, PiTranscriptState>,
    id: u32,
) -> Result<(), String> {
    if state.watchers.write().unwrap().remove(&id).is_some() {
        log::info!("pi transcripts unwatched id={id}");
    } else {
        log::debug!("pi_unwatch: unknown id={id}");
    }
    Ok(())
}

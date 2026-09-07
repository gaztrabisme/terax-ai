pub mod health;
mod launch;
mod launcher;
pub mod prompts;
pub mod secrets;
mod session;
pub mod sessions;
pub mod transcripts;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::Manager;

use crate::modules::workspace::{
    authorize_spawn_cwd, authorize_user_spawn_cwd, grant_asset_scope, WorkspaceEnv,
    WorkspaceRegistry,
};
use session::{PiSession, SpawnSpec};

/// Lets the webview render bitmaps pi writes under
/// <agent dir>/tool-output-artifacts/ via the asset protocol. Granting the
/// subdirectory keeps the rest of the agent dir (credentials, models.json)
/// out of the scope.
fn grant_agent_artifacts(app: &tauri::AppHandle, agent_dir: &Path) {
    let artifacts = agent_dir.join("tool-output-artifacts");
    if grant_asset_scope(app, &artifacts) {
        log::info!("pi asset scope granted: {}", artifacts.display());
    }
}

pub struct PiTranscriptState {
    watchers: RwLock<HashMap<u32, Arc<transcripts::WatchHandle>>>,
    next_watch_id: AtomicU32,
    /// Project cwd -> agent dir of the session pi_open spawns for it. pi
    /// 0.3.0 writes child transcripts under <agent dir>/agent-hub/<pid>
    /// (vendor pi_agent_rust src/agent_hub.rs dir(), src/config.rs
    /// global_dir_from_env), so the watcher must arm on the spawn's agent
    /// dir rather than the cwd the frontend passes.
    agent_dirs: RwLock<HashMap<String, PathBuf>>,
}

impl Default for PiTranscriptState {
    fn default() -> Self {
        Self {
            watchers: RwLock::new(HashMap::new()),
            next_watch_id: AtomicU32::new(1),
            agent_dirs: RwLock::new(HashMap::new()),
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
    app: tauri::AppHandle,
    state: tauri::State<'_, PiState>,
    hub: tauri::State<'_, PiTranscriptState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cwd: Option<String>,
    launcher_dir: Option<String>,
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
    let mut env = launch::expand_env_homes(&env.unwrap_or_default());
    // Cloud keys (Settings > Pi) ride into the spawn env on both spawn paths:
    // stored values fill any spawn env var the caller left unset, the oMLX
    // key among them, so the models.json render below sees the store too. The
    // caller's own env wins, and the values never reach launcher.log: it
    // records step outcomes only.
    let app_data_dir = app.path().app_data_dir().unwrap_or_default();
    secrets::inject_secret_env(&mut env, &app_data_dir);
    // Roles ride in the spawn env today (EFFICIENT_PI_* via piSpawnEnv); the
    // direct path renders them through prepare_session, whose report env
    // replaces these values at spawn. The EFFICIENT_PI_BPPC_HOST the frontend
    // passes carries the piBppcHost pref; a blank one keeps render_step's LAN
    // fallback. The oMLX key resolves caller env, then the secrets store
    // (injected above), then the bash launcher's own default
    // (~/.omlx/settings.json) so a checkout-less machine renders models.json.
    let env_var = |key: &str| env.get(key).cloned().unwrap_or_default();
    let mut omlx_key = env_var("EFFICIENT_PI_OMLX_KEY");
    if omlx_key.trim().is_empty() {
        omlx_key = launcher::omlx_key_default(launch::home_dir().as_deref()).unwrap_or_default();
    }
    let roles = launcher::PrepareRoles {
        provider: env_var("EFFICIENT_PI_PROVIDER"),
        model: env_var("EFFICIENT_PI_MODEL"),
        thinking: env_var("EFFICIENT_PI_THINKING"),
        smol: env_var("EFFICIENT_PI_SMOL"),
    };
    let endpoints = launcher::PrepareEndpoints {
        bppc_host: env_var("EFFICIENT_PI_BPPC_HOST"),
        omlx_key,
    };
    // Dirs the direct branch needs: the resource dir holds the agent-dir
    // template, the app data dir the writable copy, and the resolved agent
    // binary feeds PI_BOARD_AGENT_BIN on both paths.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let bundled = launch::BundledPaths {
        exe_dir,
        resource_dir: app.path().resource_dir().unwrap_or_default(),
    };
    let app_version = app.package_info().version.to_string();
    let home = launch::home_dir();
    let prefs = launch::PiPrefs {
        launcher_dir: launcher_dir.clone(),
        ..launch::PiPrefs::default()
    };
    let board_agent_bin =
        launch::resolve_paths(&prefs, &bundled, home.as_deref(), &app_data_dir)
            .agent
            .path;
    // Record the agent dir this cwd's session will spawn with before the
    // spawn runs, so a transcript watch armed in parallel resolves pi 0.3.0's
    // real hub root instead of watching the project. Per spawn shape: the
    // launcher pins PI_CODING_AGENT_DIR to <launcher root>/pi-home/agent, the
    // direct prepare pins it to the app's writable agent dir, and a program
    // override passes the caller env through (pi's own ~/.pi/agent default
    // when unset).
    if let Some(dir) = canonical.as_deref() {
        let agent_dir = match program.as_deref().map(str::trim) {
            Some(p) if !p.is_empty() => env
                .get("PI_CODING_AGENT_DIR")
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| launch::default_global_dir(home.as_deref())),
            _ => {
                let root = launch::launcher_root(&prefs, home.as_deref(), dir);
                if root.join("bin").join("efficient-pi").is_file() {
                    root.join("pi-home").join("agent")
                } else {
                    launcher::user_agent_dir(&app_data_dir)
                }
            }
        };
        grant_agent_artifacts(&app, &agent_dir);
        hub.agent_dirs
            .write()
            .expect("pi hub agent dirs poisoned")
            .insert(dir.to_string_lossy().into_owned(), agent_dir);
    }
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let session = tauri::async_runtime::spawn_blocking(move || {
        let extra_args = args.unwrap_or_default();
        let spec = match program.as_deref().map(str::trim) {
            Some(p) if !p.is_empty() => SpawnSpec {
                program: p.to_string(),
                args: extra_args,
                cwd: canonical.as_ref().map(|p| p.to_string_lossy().into_owned()),
                env,
            },
            // Empty program: the checkout launcher when it exists (its eight
            // steps run in the child), else a resolved pi binary spawns
            // directly after Rust-side session preparation.
            _ => {
                let dir = canonical.as_deref().ok_or_else(|| {
                    "pi needs a workspace cwd as its project root".to_string()
                })?;
                match launch::spawn_plan(&prefs, &bundled, home.as_deref(), dir, &roles)? {
                    launch::SpawnPlan::CheckoutLauncher { program, mut args } => {
                        log::info!("pi_open plan: checkout launcher {}", program);
                        args.extend_from_slice(&extra_args);
                        let mut spawn_env = env;
                        session::add_board_env(
                            &mut spawn_env,
                            dir,
                            board_agent_bin.as_deref(),
                        );
                        SpawnSpec {
                            program,
                            args,
                            cwd: Some(dir.to_string_lossy().into_owned()),
                            env: spawn_env,
                        }
                    }
                    launch::SpawnPlan::Direct {
                        program,
                        mut args,
                        source,
                    } => {
                        log::info!("pi_open plan: direct pi={program} (source {source:?})");
                        args.extend_from_slice(&extra_args);
                        let input = launcher::PrepareInput {
                            app_version,
                            template_dir: bundled.resource_dir.join("pi-home").join("agent"),
                            app_data_dir,
                            cwd: dir.to_path_buf(),
                            roles,
                            endpoints,
                            allow_any_dir: false,
                        };
                        let spawn_env =
                            session::prepare_direct(input, board_agent_bin.as_deref(), env)?;
                        SpawnSpec {
                            program,
                            args,
                            cwd: Some(dir.to_string_lossy().into_owned()),
                            env: spawn_env,
                        }
                    }
                }
            }
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

/// The user's home dir, so the frontend can expand `$HOME/...` paths (agent
/// dir auth.json, models.json.tmpl) before calling the fs invokes.
#[tauri::command]
pub fn pi_home_dir() -> Option<String> {
    launch::home_dir()
}

/// Where pi, the harness agent, and the agent dir actually live, each tagged
/// with its source (pref > bundled > checkout > missing), plus the runtime
/// agent dir a session would run from, so the Pi settings tab can show the
/// values a launch would use. Read-only diagnostics.
#[tauri::command]
pub fn pi_paths(app: tauri::AppHandle, prefs: launch::PiPrefs) -> launch::ResolvedPaths {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let bundled = launch::BundledPaths {
        exe_dir,
        resource_dir,
    };
    let app_data_dir = app.path().app_data_dir().unwrap_or_default();
    let resolved = launch::resolve_paths(
        &prefs,
        &bundled,
        launch::home_dir().as_deref(),
        &app_data_dir,
    );
    log::info!(
        "pi_paths: pi={:?} ({:?}) agent={:?} ({:?}) agent_dir={:?} ({:?}) runtime_agent_dir={:?} ({:?}, seeded={})",
        resolved.pi.path,
        resolved.pi.source,
        resolved.agent.path,
        resolved.agent.source,
        resolved.agent_dir.path,
        resolved.agent_dir.source,
        resolved.runtime_agent_dir.path,
        resolved.runtime_agent_dir.source,
        resolved.runtime_agent_dir.seeded,
    );
    resolved
}

/// Prepares a pi session without bash: seeds the user agent dir from the
/// bundled template, renders models.json, runs the project-root guard and
/// wiki-init, and returns the per-step report plus the spawn env. The dirs
/// come from the AppHandle; the cwd is workspace-authorized like every spawn.
#[tauri::command]
pub fn pi_prepare(
    app: tauri::AppHandle,
    registry: tauri::State<'_, WorkspaceRegistry>,
    input: launcher::PrepareOptions,
    cwd: String,
) -> Result<launcher::PrepareReport, String> {
    let workspace = WorkspaceEnv::default();
    let canonical = authorize_user_spawn_cwd(&registry, Some(&cwd), &workspace)?;
    let cwd = canonical.ok_or_else(|| "pi_prepare needs a cwd".to_string())?;
    let template_dir = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("pi-home").join("agent"))
        .unwrap_or_default();
    let app_data_dir = app.path().app_data_dir().unwrap_or_default();
    // The render resolves the oMLX key the way a spawn does: a caller-supplied
    // key wins, a blank one fills from the secrets store (the frontend never
    // sees stored keys, so it cannot pass one), then the bash launcher's own
    // ~/.omlx/settings.json default; render_step reports the gap when no
    // source has one.
    let mut endpoints = input.endpoints;
    if endpoints.omlx_key.trim().is_empty() {
        endpoints.omlx_key =
            secrets::stored_key(&app_data_dir, "omlx").unwrap_or_default();
        if endpoints.omlx_key.trim().is_empty() {
            endpoints.omlx_key = launcher::omlx_key_default(launch::home_dir().as_deref())
                .unwrap_or_default();
        }
    }
    let input = launcher::PrepareInput {
        app_version: app.package_info().version.to_string(),
        template_dir,
        app_data_dir,
        cwd,
        roles: input.roles,
        endpoints,
        allow_any_dir: input.allow_any_dir,
    };
    let report = launcher::prepare_session(input);
    grant_agent_artifacts(&app, &report.agent_dir);
    log::info!(
        "pi_prepare: {}",
        report
            .steps
            .iter()
            .map(|s| format!("{}={}", s.name, if s.ok { "ok" } else { "fail" }))
            .collect::<Vec<_>>()
            .join(" ")
    );
    Ok(report)
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
    let canonical = canonical.ok_or_else(|| "agent dir required".to_string())?;
    // Follow the spawn's agent dir: pi writes child transcripts under
    // <agent dir>/agent-hub/<pid>, never under the project cwd the frontend
    // passes here. pi_open records that dir at open time; a watch armed in
    // the same mount can race the record, so poll briefly before falling
    // back to the passed path (still right for an explicit agent dir).
    let mut root = None;
    for _ in 0..20 {
        let hit = state
            .agent_dirs
            .read()
            .expect("pi hub agent dirs poisoned")
            .get(&canonical.to_string_lossy().into_owned())
            .cloned();
        if hit.is_some() {
            root = hit;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let root = root.unwrap_or_else(|| canonical.clone());
    let id = state.next_watch_id.fetch_add(1, Ordering::Relaxed);
    let handle = Arc::new(transcripts::watch_with(
        &root,
        move |line| {
            if let Err(e) = on_line.send(line) {
                log::debug!("pi transcript send failed (channel closed): {e}");
            }
        },
    )?);
    state.watchers.write().unwrap().insert(id, handle);
    log::info!("pi transcripts watched id={id} root={}", root.display());
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

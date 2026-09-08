pub mod health;
pub mod auth;
pub mod attachments;
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
    secrets::inject_secret_env(&mut env, &app_data_dir)?;
    // Roles ride in the spawn env today (EFFICIENT_PI_* via piSpawnEnv); the
    // direct path renders them through prepare_session, whose report env
    // replaces these values at spawn. The EFFICIENT_PI_BPPC_HOST the frontend
    // passes carries the piBppcHost pref; a blank one keeps the agent's LAN
    // fallback. The oMLX key resolves caller env, then the secrets store
    // (injected above), then the bash launcher's own default
    // (~/.omlx/settings.json) so a checkout-less machine renders models.json.
    let home = launch::home_dir();
    let session_agent_dir = launch::resolve_agent_dir(
        env.get("PI_CODING_AGENT_DIR").map(String::as_str),
        home.as_deref(),
        &app_data_dir,
    );
    env.insert(
        "PI_CODING_AGENT_DIR".to_string(),
        session_agent_dir.to_string_lossy().into_owned(),
    );
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
        bppc_host: env_var("EFFICIENT_PI_BPPC_HOST").trim().to_string(),
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
    let prefs = launch::PiPrefs {
        launcher_dir: launcher_dir.clone(),
        agent_dir: Some(session_agent_dir.to_string_lossy().into_owned()),
        ..launch::PiPrefs::default()
    };
    let board_agent_bin =
        launch::resolve_paths(&prefs, &bundled, home.as_deref(), &app_data_dir)
            .agent
            .path;
    // Record the resolved agent dir before the spawn runs, so a transcript
    // watch armed in parallel resolves pi's real hub root instead of watching
    // the project.
    if let Some(dir) = canonical.as_deref() {
        grant_agent_artifacts(&app, &session_agent_dir);
        hub.agent_dirs
            .write()
            .expect("pi hub agent dirs poisoned")
            .insert(dir.to_string_lossy().into_owned(), session_agent_dir.clone());
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
                match launch::spawn_plan(
                    &prefs,
                    &bundled,
                    home.as_deref(),
                    dir,
                    &roles,
                    &endpoints.bppc_host,
                )? {
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
                            agent_dir: session_agent_dir,
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
/// values a launch would use. The default runtime dir is the app-data copy.
/// Read-only diagnostics.
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
    let mut resolved = launch::resolve_paths(
        &prefs,
        &bundled,
        launch::home_dir().as_deref(),
        &app_data_dir,
    );
    if prefs
        .agent_dir
        .as_deref()
        .map(str::trim)
        .map(|dir| dir.is_empty())
        .unwrap_or(true)
        && !app_data_dir.as_os_str().is_empty()
    {
        let path = launcher::user_agent_dir(&app_data_dir);
        resolved.runtime_agent_dir = launch::RuntimeAgentDir {
            path: Some(path.to_string_lossy().into_owned()),
            source: launch::PathSource::Bundled,
            seeded: path.join(launch::SEED_STAMP_FILE).is_file(),
        };
    }
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

/// Prepares a pi session without bash: the four launcher steps (seed the user
/// agent dir from the bundled template, render models.json, the project-root
/// guard, wiki init) run in the resolved harness agent (`agent pi prepare`),
/// and the per-step report plus the spawn env come back from its JSON. The
/// dirs come from the AppHandle; the cwd is workspace-authorized like every
/// spawn.
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
    let home = launch::home_dir();
    let agent_dir = launch::resolve_agent_dir(
        input.agent_dir.as_deref(),
        home.as_deref(),
        &app_data_dir,
    );
    // The render resolves the oMLX key the way a spawn does: a caller-supplied
    // key wins, a blank one fills from the secrets store (the frontend never
    // sees stored keys, so it cannot pass one), then the bash launcher's own
    // ~/.omlx/settings.json default; the agent's render step reports the gap
    // when no source has one.
    let mut endpoints = input.endpoints;
    if endpoints.omlx_key.trim().is_empty() {
        endpoints.omlx_key = secrets::stored_key(&app_data_dir, "omlx")?.unwrap_or_default();
        if endpoints.omlx_key.trim().is_empty() {
            endpoints.omlx_key = launcher::omlx_key_default(launch::home_dir().as_deref())
                .unwrap_or_default();
        }
    }
    let input = launcher::PrepareInput {
        app_version: app.package_info().version.to_string(),
        template_dir,
        app_data_dir: app_data_dir.clone(),
        agent_dir,
        cwd,
        roles: input.roles,
        endpoints,
        allow_any_dir: input.allow_any_dir,
    };
    // The four steps run in the harness agent, resolved like pi_paths does
    // (pref, then the bundled sidecar); a missing binary becomes a FAIL step
    // in the report, not an error.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let bundled = launch::BundledPaths {
        exe_dir,
        resource_dir: app.path().resource_dir().unwrap_or_default(),
    };
    let agent_bin = launch::resolve_paths(
        &launch::PiPrefs::default(),
        &bundled,
        launch::home_dir().as_deref(),
        &app_data_dir,
    )
    .agent
    .path;
    let report = launcher::prepare_session(input, agent_bin.as_deref().map(Path::new));
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

// ---------------------------------------------------------------------------
// `pi --list-models` probe (model picker, vision flag)
// ---------------------------------------------------------------------------

/// Credential families scrubbed from the listing probe env. Ambient cloud
/// keys silently reshape what pi lists (models.rs hides rows without a
/// resolvable credential), so the probe runs on the stored keys only: the
/// prefixes follow the standing verifier rule, the exact names cover the
/// oMLX vars whose prefix differs (Rust twins: PROVIDER_ENVS in secrets.rs,
/// PI_CLOUD_PROVIDERS in src/modules/pi/lib/providers.ts). PI_CODING_AGENT_DIR
/// is scrubbed too and re-inserted explicitly below.
const LIST_MODEL_SCRUB_PREFIXES: &[&str] =
    &["ANTHROPIC_", "OPENAI_", "GOOGLE_", "GEMINI_", "OPENROUTER_"];
const LIST_MODEL_SCRUB_EXACT: &[&str] = &[
    "OMLX_API_KEY",
    "EFFICIENT_PI_OMLX_KEY",
    "PI_CODING_AGENT_DIR",
];

/// The env a listing probe runs in: the app's ambient env minus every cloud
/// credential (process basics like PATH, HOME and the Windows SystemRoot
/// survive so the child can run at all), PI_CODING_AGENT_DIR pinned to the
/// session's agent dir when known, then the stored keys filled in. With no
/// keys stored the probe carries no cloud credential, which is exactly why
/// pi hides those rows and the UI answers "enter a key to see models".
/// Pure over `ambient` so tests never touch the process env.
fn list_models_env(
    ambient: impl Iterator<Item = (String, String)>,
    app_data_dir: &Path,
    agent_dir: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    let scrubbed = |key: &str| {
        LIST_MODEL_SCRUB_PREFIXES.iter().any(|p| key.starts_with(p))
            || LIST_MODEL_SCRUB_EXACT.contains(&key)
    };
    let mut env: HashMap<String, String> = ambient
        .filter(|(key, _)| !scrubbed(key))
        .collect();
    if let Some(dir) = agent_dir.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("PI_CODING_AGENT_DIR".to_string(), dir.to_string());
    }
    secrets::inject_secret_env(&mut env, app_data_dir)?;
    Ok(env)
}

fn probe_output(label: &str, mut cmd: std::process::Command) -> Result<String, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("{label} failed to run: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stderr = stderr.trim();
        if stderr.is_empty() {
            Err(format!("{label} exited {}", out.status))
        } else {
            Err(stderr.to_string())
        }
    }
}

fn provider_probe_args() -> Vec<String> {
    vec!["--list-providers".to_string()]
}

/// `pi --list-models <pattern>` for the Settings model picker and the pi
/// tab's vision flag. Runs the same resolved pi binary a session spawns
/// (pref > bundled > checkout), with the agent dir a session would run from
/// (an explicit `agent_dir` wins, else the runtime agent dir), so auth.json
/// keys and models.json endpoints resolve exactly as in a session. The env
/// carries the stored cloud keys only (see list_models_env); pi fingerprints
/// its own listing cache on credential env values, so a changed key set
/// refreshes the table by itself. `pattern` passes straight through to pi's
/// fuzzy filter; the frontend fetches the full table and filters per
/// provider client-side.
#[tauri::command]
pub fn pi_list_models(
    app: tauri::AppHandle,
    prefs: launch::PiPrefs,
    pattern: Option<String>,
    agent_dir: Option<String>,
) -> Result<String, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let bundled = launch::BundledPaths {
        exe_dir,
        resource_dir: app.path().resource_dir().unwrap_or_default(),
    };
    let app_data_dir = app.path().app_data_dir().unwrap_or_default();
    let home = launch::home_dir();
    let resolved = launch::resolve_paths(&prefs, &bundled, home.as_deref(), &app_data_dir);
    let program = resolved.pi.path.ok_or_else(|| {
        format!("no pi binary found: {}", resolved.pi.candidates.join(" or "))
    })?;
    let agent_dir = agent_dir
        .map(|dir| launch::expand_home(dir.trim(), home.as_deref()))
        .filter(|dir| !dir.is_empty())
        .unwrap_or_else(|| {
            launch::resolve_agent_dir(prefs.agent_dir.as_deref(), home.as_deref(), &app_data_dir)
                .to_string_lossy()
                .into_owned()
        });
    let mut cmd = std::process::Command::new(&program);
    cmd.arg("--list-models");
    let pattern = pattern
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    if let Some(pattern) = pattern.as_deref() {
        cmd.arg(pattern);
    }
    cmd.env_clear()
        .envs(list_models_env(
            std::env::vars(),
            &app_data_dir,
            Some(agent_dir.as_str()),
        )?);
    probe_output("pi --list-models", cmd)
}

/// pi --list-providers for the Settings provider picker. The frontend gives
/// this command the same resolved binary and runtime agent dir shown in
/// Settings, and the probe receives the same scrubbed environment as the
/// model listing probe.
#[tauri::command]
pub fn pi_list_providers(
    app: tauri::AppHandle,
    agent_dir: String,
    pi_bin: String,
) -> Result<String, String> {
    let home = launch::home_dir();
    let program = launch::expand_home(pi_bin.trim(), home.as_deref());
    if program.trim().is_empty() {
        return Err("pi binary is empty".to_string());
    }
    let agent_dir = launch::expand_home(agent_dir.trim(), home.as_deref());
    let app_data_dir = app.path().app_data_dir().unwrap_or_default();
    let mut cmd = std::process::Command::new(&program);
    cmd.args(provider_probe_args());
    cmd.env_clear()
        .envs(list_models_env(
            std::env::vars(),
            &app_data_dir,
            Some(agent_dir.as_str()),
        )?);
    probe_output("pi --list-providers", cmd)
}

#[cfg(test)]
mod list_models_tests {
    use super::*;

    fn ambient(pairs: &[(&str, &str)]) -> impl Iterator<Item = (String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn probe_env_scrubs_ambient_cloud_keys_and_keeps_process_basics() {
        let env = list_models_env(
            ambient(&[
                ("ANTHROPIC_API_KEY", "ambient-a"),
                ("OPENAI_API_KEY", "ambient-o"),
                ("OPENROUTER_API_KEY", "ambient-r"),
                ("GEMINI_API_KEY", "ambient-g"),
                ("GOOGLE_API_KEY", "ambient-g2"),
                ("OMLX_API_KEY", "ambient-x"),
                ("EFFICIENT_PI_OMLX_KEY", "ambient-x2"),
                ("PI_CODING_AGENT_DIR", "/stale/agent"),
                ("PATH", "/bin"),
                ("HOME", "/u/me"),
            ]),
            Path::new(""),
            None,
        )
        .expect("probe env");
        for key in [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "OMLX_API_KEY",
            "EFFICIENT_PI_OMLX_KEY",
            "PI_CODING_AGENT_DIR",
        ] {
            assert!(!env.contains_key(key), "{key} must be scrubbed");
        }
        // Process basics survive so the child can run.
        assert_eq!(env.get("PATH").map(String::as_str), Some("/bin"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/u/me"));
    }

    #[test]
    fn probe_env_carries_only_the_stored_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        secrets::set_secret(dir.path(), "anthropic", "sk-stored").expect("set");
        secrets::set_secret(dir.path(), "google", "sk-g").expect("set");
        let env = list_models_env(
            ambient(&[("ANTHROPIC_API_KEY", "ambient-a")]),
            dir.path(),
            None,
        )
        .expect("probe env");
        // The stored value replaces the scrubbed ambient one.
        assert_eq!(
            env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("sk-stored")
        );
        // google maps onto both env vars pi reads.
        assert_eq!(env.get("GEMINI_API_KEY").map(String::as_str), Some("sk-g"));
        assert_eq!(env.get("GOOGLE_API_KEY").map(String::as_str), Some("sk-g"));
        // Providers without a stored key stay absent.
        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert!(!env.contains_key("OMLX_API_KEY"));
    }

    #[test]
    fn probe_env_pins_the_agent_dir_only_when_known() {
        let env = list_models_env(
            ambient(&[("PI_CODING_AGENT_DIR", "/stale/agent")]),
            Path::new(""),
            Some("/session/agent"),
        )
        .expect("probe env");
        assert_eq!(
            env.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/session/agent")
        );
        // A blank agent dir is unknown: the stale ambient value stays gone.
        let env = list_models_env(
            ambient(&[("PI_CODING_AGENT_DIR", "/stale/agent")]),
            Path::new(""),
            Some("   "),
        )
        .expect("probe env");
        assert!(!env.contains_key("PI_CODING_AGENT_DIR"));
    }

    #[test]
    fn probe_env_with_no_store_is_plain_scrubbed_ambient() {
        let env = list_models_env(
            ambient(&[("OPENAI_API_KEY", "ambient")]),
            Path::new("/nonexistent/pi-list-models-test"),
            None,
        )
        .expect("probe env");
        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert_eq!(env.len(), 0);
    }

    #[test]
    fn provider_probe_uses_the_direct_list_providers_argument() {
        assert_eq!(provider_probe_args(), vec!["--list-providers"]);
    }
}

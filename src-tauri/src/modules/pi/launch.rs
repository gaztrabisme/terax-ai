use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::launcher::PrepareRoles;
use super::session::SpawnSpec;

/// HOME for `$HOME/` expansion in settings values: the env var first (the
/// documented contract), the `dirs` lookup as the Windows fallback where HOME
/// is usually unset. Never passed through a shell.
pub(crate) fn home_dir() -> Option<String> {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => Some(home),
        _ => dirs::home_dir().map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Expands a leading `$HOME/` (or bare `$HOME`) in `dir` against `home`.
/// Pure: everything else passes through untouched.
pub(crate) fn expand_home(dir: &str, home: Option<&str>) -> String {
    let Some(home) = home.filter(|h| !h.is_empty()) else {
        return dir.to_string();
    };
    let home = home.trim_end_matches('/');
    if dir == "$HOME" {
        return home.to_string();
    }
    match dir.strip_prefix("$HOME/") {
        Some(rest) if !rest.is_empty() => format!("{home}/{rest}"),
        _ => dir.to_string(),
    }
}

/// Expands a leading `$HOME` in every spawn env value Rust-side: pi and the
/// launcher receive these literally (no shell ever sees them), so a user-set
/// `PI_CODING_AGENT_DIR=$HOME/...` must be resolved before spawn.
pub(crate) fn expand_env_homes(env: &HashMap<String, String>) -> HashMap<String, String> {
    let home = home_dir();
    env.iter()
        .map(|(k, v)| (k.clone(), expand_home(v, home.as_deref())))
        .collect()
}

/// Extra args appended after the mode flags (prompt targets, provider
/// overrides, anything pi accepts; the launcher passes unknown args through).
/// `launcher_dir` picks the checkout whose bin/efficient-pi (then bin/pi) is
/// spawned; empty falls back to the workspace-local bin/ lookup. `cwd` stays
/// the workspace so pi's project root is the user's project.
///
/// Test-only convenience today: pi_open dispatches on spawn_plan directly so
/// the direct branch can prepare the session first.
#[cfg_attr(not(test), allow(dead_code))]
pub fn resolve_spec(
    cwd: Option<&Path>,
    launcher_dir: Option<&str>,
    extra_args: &[String],
    env: HashMap<String, String>,
) -> Result<SpawnSpec, String> {
    resolve_spec_with(
        cwd,
        launcher_dir,
        &bundled_paths_from_exe(),
        home_dir().as_deref(),
        extra_args,
        env,
    )
}

/// Sidecar dirs for the running process: the executable's dir holds the
/// bundled pi/agent copies (build.rs strips the target triple when it stages
/// them). The resource dir is only known to the pi_paths command, which owns
/// the AppHandle, so it stays empty here.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn bundled_paths_from_exe() -> BundledPaths {
    BundledPaths {
        exe_dir: std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .unwrap_or_default(),
        resource_dir: PathBuf::new(),
    }
}

/// How a pi tab gets its process: the efficient-pi checkout launcher runs its
/// eight steps and execs pi, or a resolved pi binary spawns directly after
/// Rust-side session preparation (launcher::prepare_session).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnPlan {
    CheckoutLauncher {
        program: String,
        args: Vec<String>,
    },
    Direct {
        program: String,
        args: Vec<String>,
        source: PathSource,
    },
}

/// Launcher root for a spawn: launcherDir when set, else the workspace cwd.
/// Shared by spawn_plan and pi_open's hub-dir recording so both branch on the
/// same root.
pub(crate) fn launcher_root(prefs: &PiPrefs, home: Option<&str>, cwd: &Path) -> PathBuf {
    match prefs.launcher_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => expand_home(dir, home).into(),
        None => cwd.to_path_buf(),
    }
}

/// Resolves the agent directory once for a session. A non-empty preference is
/// expanded as a path; otherwise the writable app-data copy is the fallback.
pub(crate) fn resolve_agent_dir(
    preferred: Option<&str>,
    home: Option<&str>,
    app_data_dir: &Path,
) -> PathBuf {
    pref_path(preferred, home).unwrap_or_else(|| super::launcher::user_agent_dir(app_data_dir))
}

/// Tool list the bash launcher passes in PI_BASE_ARGS (bin/efficient-pi); the
/// direct spawn must request the same toolset or pi falls back to its default.
const DIRECT_TOOLS: &str = "read,grep,find,ls,todo,subagent";

/// Args for a direct pi spawn: `--session-dir` under the project (K11a
/// routes sessions to `<project>/.pi/sessions`), then `--mode rpc` plus the
/// launcher's PI_BASE_ARGS role flags. The session-dir flag leads so it can
/// never be swallowed by a positional prompt; `--provider`/`--model` are
/// omitted when the provider is empty (then pi uses the agent dir's
/// settings.json default) and `--smol` when the smol role is empty;
/// `--thinking` and `--tools` always pass, matching the bash launcher.
pub fn direct_rpc_args(roles: &PrepareRoles, project_root: &Path) -> Vec<String> {
    let session_dir = project_root.join(".pi").join("sessions");
    let mut args = vec![
        "--session-dir".to_string(),
        session_dir.to_string_lossy().into_owned(),
        "--mode".to_string(),
        "rpc".to_string(),
    ];
    let provider = roles.provider.trim();
    if !provider.is_empty() {
        args.push("--provider".to_string());
        args.push(provider.to_string());
        let model = roles.model.trim();
        if !model.is_empty() {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
    }
    args.push("--thinking".to_string());
    args.push(roles.thinking.trim().to_string());
    let smol = roles.smol.trim();
    if !smol.is_empty() {
        args.push("--smol".to_string());
        args.push(smol.to_string());
    }
    args.push("--tools".to_string());
    args.push(DIRECT_TOOLS.to_string());
    args
}

fn checkout_rpc_args(bppc_host: &str) -> Vec<String> {
    let mut args = vec![
        "--no-prime".to_string(),
        "--mode".to_string(),
        "rpc".to_string(),
    ];
    let host = bppc_host.trim();
    if !host.is_empty() {
        args.push("--host".to_string());
        args.push(host.to_string());
    }
    args
}

/// Spawn decision, shared by pi_open and the resolve_spec wrapper: an
/// explicitly configured pi binary is honored first (design 3.6's order puts
/// the explicit configured path ahead of the checkout launcher, which would
/// exec the checkout's own bin/pi rather than the configured binary), then
/// the checkout launcher wins when its file exists and no explicit agent dir
/// is set (today's behavior for the shell-oriented wrapper), then a pi
/// binary resolved through the shared precedence chain spawns directly, else
/// the error names the exact failure: a configured-but-missing path fails
/// with "configured pi binary not found: <path>" and never falls through to
/// another binary, while an unset resolution names every candidate so a
/// missing-install tab still explains itself. The launcher root falls back
/// to the workspace cwd when launcherDir is unset or blank. `roles` carries
/// the resolved EFFICIENT_PI_* values the direct args are built from.
pub fn spawn_plan(
    prefs: &PiPrefs,
    bundled: &BundledPaths,
    home: Option<&str>,
    cwd: &Path,
    roles: &PrepareRoles,
    bppc_host: &str,
) -> Result<SpawnPlan, String> {
    let configured_pi = pref_path(prefs.pi_bin.as_deref(), home);
    let root = launcher_root(prefs, home, cwd);
    let launcher = root.join("bin").join("efficient-pi");
    let has_agent_dir = prefs
        .agent_dir
        .as_deref()
        .map(str::trim)
        .is_some_and(|dir| !dir.is_empty());
    if configured_pi.is_none() && !cfg!(windows) && !has_agent_dir && launcher.is_file() {
        return Ok(SpawnPlan::CheckoutLauncher {
            program: launcher.to_string_lossy().into_owned(),
            args: checkout_rpc_args(bppc_host),
        });
    }
    // No launcher applies: resolve the pi binary through the shared
    // precedence chain, with the checkout rooted at launcherDir (or the
    // workspace when unset). The runtime agent dir needs the app data dir,
    // which a spawn decision never reads; an empty dir degrades it instead
    // of guessing.
    let effective = PiPrefs {
        launcher_dir: (!cfg!(windows)).then(|| root.to_string_lossy().into_owned()),
        ..prefs.clone()
    };
    let resolved = resolve_paths_with(
        &effective,
        bundled,
        home,
        std::env::consts::EXE_SUFFIX,
        Path::new(""),
    );
    match (&resolved.pi.path, resolved.pi.source) {
        (Some(program), source @ (PathSource::Pref | PathSource::Bundled | PathSource::Checkout)) => {
            Ok(SpawnPlan::Direct {
                program: program.clone(),
                args: direct_rpc_args(roles, cwd),
                source,
            })
        }
        // A configured path that does not exist (or is not executable) is a
        // visible launch failure naming it: silently running the bundled
        // sidecar or the checkout instead would hide the user's own
        // configuration from them.
        _ if configured_pi.is_some() => Err(format!(
            "configured pi binary not found: {}",
            configured_pi
                .as_deref()
                .unwrap_or_else(|| Path::new(""))
                .display()
        )),
        _ => {
            let mut expected = vec![launcher.display().to_string()];
            expected.extend(resolved.pi.candidates.iter().cloned());
            Err(format!(
                "no pi binary found: expected {}",
                expected.join(" or ")
            ))
        }
    }
}

/// The EFFICIENT_PI_* role values a spawn env carries; blank means unset, the
/// same shape pi_open reads before the direct prepare.
fn roles_from_env(env: &HashMap<String, String>) -> PrepareRoles {
    let value = |key: &str| env.get(key).cloned().unwrap_or_default();
    PrepareRoles {
        provider: value("EFFICIENT_PI_PROVIDER"),
        model: value("EFFICIENT_PI_MODEL"),
        thinking: value("EFFICIENT_PI_THINKING"),
        smol: value("EFFICIENT_PI_SMOL"),
    }
}

/// Same as `resolve_spec` with the bundled dirs and home dir injected.
#[cfg_attr(not(test), allow(dead_code))]
fn resolve_spec_with(
    cwd: Option<&Path>,
    launcher_dir: Option<&str>,
    bundled: &BundledPaths,
    home: Option<&str>,
    extra_args: &[String],
    env: HashMap<String, String>,
) -> Result<SpawnSpec, String> {
    let dir = cwd
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "pi needs a workspace cwd as its project root".to_string())?;
    let prefs = PiPrefs {
        launcher_dir: launcher_dir.map(str::to_string),
        ..PiPrefs::default()
    };
    let roles = roles_from_env(&env);
    let bppc_host = env
        .get("EFFICIENT_PI_BPPC_HOST")
        .map(String::as_str)
        .unwrap_or("");
    let mut spec = match spawn_plan(&prefs, bundled, home, dir, &roles, bppc_host)? {
        SpawnPlan::CheckoutLauncher { program, args } | SpawnPlan::Direct { program, args, .. } => {
            SpawnSpec {
                program,
                args,
                cwd: Some(dir.to_string_lossy().into_owned()),
                env,
            }
        }
    };
    spec.args.extend_from_slice(extra_args);
    Ok(spec)
}

/// Optional path overrides from the Pi settings tab. Every value may carry a
/// leading `$HOME/`, expanded against the home dir at resolve time; an empty
/// or whitespace value counts as unset.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PiPrefs {
    pub pi_bin: Option<String>,
    pub agent_bin: Option<String>,
    pub agent_dir: Option<String>,
    pub launcher_dir: Option<String>,
}

/// Dirs the packaged (or dev) app resolves bundled artifacts from. An empty
/// dir means "unavailable" and skips the bundled candidates.
#[derive(Debug, Clone, Default)]
pub struct BundledPaths {
    /// Directory of the running executable: holds the pi/agent sidecars.
    pub exe_dir: PathBuf,
    /// Tauri resource dir: holds pi-home/agent.
    pub resource_dir: PathBuf,
}

/// Sidecar base names as declared in tauri.conf.json bundle.externalBin.
const PI_SIDECAR: &str = "pi";
const AGENT_SIDECAR: &str = "agent";

/// Seed stamp written by launcher::seed_agent_dir (SEED_STAMP_FILE there is
/// private; the name must stay in sync). Its presence marks the runtime
/// agent dir as seeded.
pub(crate) const SEED_STAMP_FILE: &str = ".terax-seed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathSource {
    Pref,
    Bundled,
    Checkout,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPath {
    /// The winner, or None when Missing.
    pub path: Option<String>,
    pub source: PathSource,
    /// Every candidate in precedence order; the useful bit when path is None.
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPaths {
    pub pi: ResolvedPath,
    pub agent: ResolvedPath,
    pub agent_dir: ResolvedPath,
    pub runtime_agent_dir: RuntimeAgentDir,
}

/// The agent dir a session actually runs from. When the resolved agent dir is
/// the bundled template (read-only inside the app bundle), pi runs from the
/// seeded per-user copy in the app data dir; for a pref or checkout source
/// the runtime dir is the resolved dir itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAgentDir {
    /// The runtime dir, or None when the source is Missing (or the app data
    /// dir is unknown, so no seeded copy can be named).
    pub path: Option<String>,
    pub source: PathSource,
    /// True when the `.terax-seed` stamp exists in the runtime dir.
    pub seeded: bool,
}

/// Derives the runtime agent dir from the resolved agent dir and the app
/// data dir, reusing the same helper pi_prepare seeds through.
fn runtime_agent_dir(agent_dir: &ResolvedPath, app_data_dir: &Path) -> RuntimeAgentDir {
    if agent_dir.source == PathSource::Bundled {
        if app_data_dir.as_os_str().is_empty() {
            return RuntimeAgentDir {
                path: None,
                source: PathSource::Bundled,
                seeded: false,
            };
        }
        let path = super::launcher::user_agent_dir(app_data_dir);
        let seeded = path.join(SEED_STAMP_FILE).is_file();
        return RuntimeAgentDir {
            path: Some(path.to_string_lossy().into_owned()),
            source: PathSource::Bundled,
            seeded,
        };
    }
    RuntimeAgentDir {
        path: agent_dir.path.clone(),
        source: agent_dir.source,
        seeded: false,
    }
}

/// Sidecar file name for a target: `pi` or `pi.exe`. The suffix is a parameter
/// so tests can exercise the Windows form on any host.
fn sidecar_name(base: &str, exe_suffix: &str) -> String {
    format!("{base}{exe_suffix}")
}

/// Resolution precedence: a pref that exists wins, then the bundled file, then
/// the efficient-pi checkout, else Missing with the candidate list. The
/// runtime agent dir is derived from the agent dir result and `app_data_dir`.
pub fn resolve_paths(
    prefs: &PiPrefs,
    bundled: &BundledPaths,
    home: Option<&str>,
    app_data_dir: &Path,
) -> ResolvedPaths {
    resolve_paths_with(prefs, bundled, home, std::env::consts::EXE_SUFFIX, app_data_dir)
}

fn resolve_paths_with(
    prefs: &PiPrefs,
    bundled: &BundledPaths,
    home: Option<&str>,
    exe_suffix: &str,
    app_data_dir: &Path,
) -> ResolvedPaths {
    let launcher_root = pref_path(prefs.launcher_dir.as_deref(), home);

    let mut pi = Vec::new();
    if let Some(p) = pref_path(prefs.pi_bin.as_deref(), home) {
        pi.push((p, PathSource::Pref));
    }
    if let Some(p) = sidecar_path(&bundled.exe_dir, PI_SIDECAR, exe_suffix) {
        pi.push((p, PathSource::Bundled));
    }
    if let Some(root) = &launcher_root {
        pi.push((root.join("bin").join(PI_SIDECAR), PathSource::Checkout));
    }

    // No checkout candidate for the agent binary: the harness binary is not
    // inside the efficient-pi checkout, and guessing a sibling path would
    // only work on one machine's layout. A pref or the bundled sidecar must
    // answer.
    let mut agent = Vec::new();
    if let Some(p) = pref_path(prefs.agent_bin.as_deref(), home) {
        agent.push((p, PathSource::Pref));
    }
    if let Some(p) = sidecar_path(&bundled.exe_dir, AGENT_SIDECAR, exe_suffix) {
        agent.push((p, PathSource::Bundled));
    }

    let mut agent_dir = Vec::new();
    if let Some(p) = pref_path(prefs.agent_dir.as_deref(), home) {
        agent_dir.push((p, PathSource::Pref));
    }
    if !bundled.resource_dir.as_os_str().is_empty() {
        agent_dir.push((
            bundled.resource_dir.join("pi-home").join("agent"),
            PathSource::Bundled,
        ));
    }
    if let Some(root) = &launcher_root {
        agent_dir.push((root.join("pi-home").join("agent"), PathSource::Checkout));
    }

    let agent_dir = pick(agent_dir, true);
    ResolvedPaths {
        pi: pick_binary(pi),
        agent: pick_binary(agent),
        runtime_agent_dir: runtime_agent_dir(&agent_dir, app_data_dir),
        agent_dir,
    }
}

/// A pref value as a path, or None when unset/blank. `$HOME/` expands here so
/// settings values never reach the filesystem unexpanded.
fn pref_path(value: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let trimmed = value.map(str::trim).filter(|s| !s.is_empty())?;
    Some(expand_home(trimmed, home).into())
}

fn sidecar_path(dir: &Path, base: &str, exe_suffix: &str) -> Option<PathBuf> {
    if dir.as_os_str().is_empty() {
        return None;
    }
    Some(dir.join(sidecar_name(base, exe_suffix)))
}

/// Whether `path` is a file the OS would execute: it must exist as a file and
/// carry an execute bit (unix); on Windows the file existing is the check,
/// the loader decides the rest. Only explicit binary configuration is held to
/// this standard; the bundled sidecars and the checkout keep the plain
/// existence check they always had.
pub(crate) fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.is_file()
            && path
                .metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Every candidate path as a string, in precedence order: the useful bit for
/// Missing diagnostics.
fn listed_candidates(candidates: &[(PathBuf, PathSource)]) -> Vec<String> {
    candidates
        .iter()
        .map(|(p, _)| p.to_string_lossy().into_owned())
        .collect()
}

/// Binary resolution with design 3.6's first rule enforced: an explicitly
/// configured path is authoritative. When it exists as an executable file it
/// wins; when it does not, the resolution reports Missing naming it first
/// among the candidates and never falls through to a lower-precedence
/// binary, so a launch fails visibly instead of silently running another
/// binary. The bundled sidecar applies only when nothing is configured.
fn pick_binary(candidates: Vec<(PathBuf, PathSource)>) -> ResolvedPath {
    if let Some((configured, PathSource::Pref)) = candidates.first() {
        if !is_executable_file(configured) {
            return ResolvedPath {
                path: None,
                source: PathSource::Missing,
                candidates: listed_candidates(&candidates),
            };
        }
    }
    pick(candidates, false)
}

/// First candidate whose file (or dir, for `is_dir`) exists wins; the listed
/// candidates are returned either way for Missing diagnostics.
fn pick(candidates: Vec<(PathBuf, PathSource)>, is_dir: bool) -> ResolvedPath {
    let listed = listed_candidates(&candidates);
    for (path, source) in candidates {
        let exists = if is_dir {
            path.is_dir()
        } else {
            path.is_file()
        };
        if exists {
            return ResolvedPath {
                path: Some(path.to_string_lossy().into_owned()),
                source,
                candidates: listed,
            };
        }
    }
    ResolvedPath {
        path: None,
        source: PathSource::Missing,
        candidates: listed,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir bin");
        }
        std::fs::write(path, "#!/bin/sh\n").expect("write");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    #[test]
    fn prefers_launcher_over_direct_binary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let launcher_home = tempfile::tempdir().expect("tempdir");
        touch(&launcher_home.path().join("bin").join("efficient-pi"));
        touch(&launcher_home.path().join("bin").join("pi"));
        let launcher_dir = launcher_home.path().to_str().expect("utf8");
        let spec = resolve_spec(
            Some(dir.path()),
            Some(launcher_dir),
            &["--model".to_string(), "m".to_string()],
            HashMap::new(),
        )
        .expect("spec");
        assert!(spec.program.starts_with(launcher_dir));
        assert!(spec.program.ends_with("bin/efficient-pi"));
        assert_eq!(
            spec.args,
            vec![
                "--no-prime".to_string(),
                "--mode".to_string(),
                "rpc".to_string(),
                "--model".to_string(),
                "m".to_string(),
            ]
        );
        // cwd stays the workspace so pi's project root is the user's project.
        assert_eq!(
            spec.cwd.as_deref(),
            Some(dir.path().to_str().expect("utf8"))
        );
    }

    #[test]
    fn falls_back_to_direct_pi_in_launcher_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let launcher_home = tempfile::tempdir().expect("tempdir");
        touch(&launcher_home.path().join("bin").join("pi"));
        let mut env = HashMap::new();
        env.insert("PI_CODING_AGENT_DIR".to_string(), "/tmp/agent".to_string());
        env.insert("EFFICIENT_PI_PROVIDER".to_string(), "bppc".to_string());
        env.insert("EFFICIENT_PI_MODEL".to_string(), "qwen3.8-27b".to_string());
        let spec = resolve_spec(
            Some(dir.path()),
            Some(launcher_home.path().to_str().expect("utf8")),
            &[],
            env,
        )
        .expect("spec");
        assert!(spec
            .program
            .starts_with(launcher_home.path().to_str().expect("utf8")));
        assert!(spec.program.ends_with("bin/pi"));
        // Direct spawns carry the project session dir (K11a), then the
        // launcher's PI_BASE_ARGS role flags.
        assert_eq!(
            spec.args,
            vec![
                "--session-dir".to_string(),
                dir.path()
                    .join(".pi")
                    .join("sessions")
                    .to_string_lossy()
                    .into_owned(),
                "--mode".to_string(),
                "rpc".to_string(),
                "--provider".to_string(),
                "bppc".to_string(),
                "--model".to_string(),
                "qwen3.8-27b".to_string(),
                "--thinking".to_string(),
                String::new(),
                "--tools".to_string(),
                "read,grep,find,ls,todo,subagent".to_string(),
            ]
        );
        assert_eq!(
            spec.env.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/tmp/agent")
        );
    }

    #[test]
    fn empty_launcher_dir_falls_back_to_workspace_bin() {
        let dir = tempfile::tempdir().expect("tempdir");
        touch(&dir.path().join("bin").join("efficient-pi"));
        let spec =
            resolve_spec(Some(dir.path()), Some("   "), &[], HashMap::new()).expect("spec");
        assert!(spec.program.starts_with(dir.path().to_str().expect("utf8")));
        assert!(spec.program.ends_with("bin/efficient-pi"));
    }

    #[test]
    fn dollar_home_launcher_dir_expands_against_injected_home() {
        let home = tempfile::tempdir().expect("tempdir");
        let checkout = home.path().join("checkout");
        touch(&checkout.join("bin").join("efficient-pi"));
        let dir = tempfile::tempdir().expect("tempdir");
        let spec = resolve_spec_with(
            Some(dir.path()),
            Some("$HOME/checkout"),
            &BundledPaths::default(),
            Some(home.path().to_str().expect("utf8")),
            &[],
            HashMap::new(),
        )
        .expect("spec");
        assert!(spec
            .program
            .starts_with(home.path().to_str().expect("utf8")));
        assert!(spec.program.ends_with("bin/efficient-pi"));
        // cwd stays the workspace even when the launcher lives elsewhere.
        assert_eq!(
            spec.cwd.as_deref(),
            Some(dir.path().to_str().expect("utf8"))
        );
    }

    #[test]
    fn expand_home_handles_leading_prefix_and_passthrough() {
        assert_eq!(expand_home("$HOME/work/pi", Some("/u/me")), "/u/me/work/pi");
        assert_eq!(expand_home("$HOME/work/pi", Some("/u/me/")), "/u/me/work/pi");
        assert_eq!(expand_home("$HOME", Some("/u/me")), "/u/me");
        assert_eq!(expand_home("home/$HOME/x", Some("/u/me")), "home/$HOME/x");
        assert_eq!(expand_home("/abs/bin", Some("/u/me")), "/abs/bin");
        assert_eq!(expand_home("$HOME/x", None), "$HOME/x");
        assert_eq!(expand_home("$HOME/x", Some("")), "$HOME/x");
    }

    #[test]
    fn expand_env_homes_maps_only_home_prefixed_values() {
        let mut env = HashMap::new();
        env.insert(
            "PI_CODING_AGENT_DIR".to_string(),
            "$HOME/agents/main".to_string(),
        );
        env.insert("EFFICIENT_PI_MODEL".to_string(), "qwen3.8-27b".to_string());
        let expanded = expand_env_homes(&env);
        // expand_env_homes reads the process HOME; mirror expand_home here.
        let expected = match home_dir().as_deref() {
            Some(h) => format!("{}/agents/main", h.trim_end_matches('/')),
            None => "$HOME/agents/main".to_string(),
        };
        assert_eq!(
            expanded.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some(expected.as_str())
        );
        assert_eq!(
            expanded.get("EFFICIENT_PI_MODEL").map(String::as_str),
            Some("qwen3.8-27b")
        );
        // Empty input: nothing to expand.
        assert_eq!(expand_env_homes(&HashMap::new()).len(), 0);
    }

    #[test]
    fn resolve_agent_dir_prefers_the_explicit_path_then_app_data() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let home_str = home.path().to_str().expect("utf8");
        let explicit = resolve_agent_dir(Some("$HOME/custom-agent"), Some(home_str), app_data.path());
        assert_eq!(explicit, home.path().join("custom-agent"));
        assert_eq!(
            resolve_agent_dir(Some("  "), Some(home_str), app_data.path()),
            app_data.path().join("pi-home").join("agent")
        );
    }

    #[test]
    fn errors_when_no_binary_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let launcher_home = tempfile::tempdir().expect("tempdir");
        let err = resolve_spec(
            Some(dir.path()),
            Some(launcher_home.path().to_str().expect("utf8")),
            &[],
            HashMap::new(),
        )
        .expect_err("must error");
        assert!(err.contains("no pi binary found"));
        let expected = launcher_home.path().join("bin").join("efficient-pi");
        assert!(err.contains(&expected.display().to_string()));
    }

    #[test]
    fn spawn_plan_picks_the_checkout_launcher_when_present() {
        let dir = tempfile::tempdir().expect("tempdir");
        let launcher_home = tempfile::tempdir().expect("tempdir");
        touch(&launcher_home.path().join("bin").join("efficient-pi"));
        let prefs = PiPrefs {
            launcher_dir: Some(launcher_home.path().to_str().expect("utf8").to_string()),
            ..PiPrefs::default()
        };
        let roles = PrepareRoles {
            provider: String::new(),
            model: String::new(),
            thinking: "xhigh".to_string(),
            smol: String::new(),
        };
        let plan = spawn_plan(&prefs, &BundledPaths::default(), None, dir.path(), &roles, "")
            .expect("plan");
        match plan {
            SpawnPlan::CheckoutLauncher { program, args } => {
                assert!(program.starts_with(launcher_home.path().to_str().expect("utf8")));
                assert!(program.ends_with("bin/efficient-pi"));
                assert_eq!(
                    args,
                    vec![
                        "--no-prime".to_string(),
                        "--mode".to_string(),
                        "rpc".to_string()
                    ]
                );
            }
            other => panic!("expected the checkout launcher, got {other:?}"),
        }
    }

    #[test]
    fn checkout_launcher_receives_the_configured_bppc_host() {
        let dir = tempfile::tempdir().expect("tempdir");
        let launcher_home = tempfile::tempdir().expect("tempdir");
        touch(&launcher_home.path().join("bin").join("efficient-pi"));
        let prefs = PiPrefs {
            launcher_dir: Some(launcher_home.path().to_string_lossy().into_owned()),
            ..PiPrefs::default()
        };
        let roles = PrepareRoles {
            provider: String::new(),
            model: String::new(),
            thinking: String::new(),
            smol: String::new(),
        };
        let plan = spawn_plan(
            &prefs,
            &BundledPaths::default(),
            None,
            dir.path(),
            &roles,
            "  192.0.2.44  ",
        )
        .expect("plan");
        let SpawnPlan::CheckoutLauncher { args, .. } = plan else {
            panic!("expected the checkout launcher");
        };
        assert_eq!(
            args,
            vec![
                "--no-prime",
                "--mode",
                "rpc",
                "--host",
                "192.0.2.44"
            ]
        );
    }

    #[test]
    fn explicit_agent_dir_uses_direct_pi_instead_of_checkout_launcher() {
        let dir = tempfile::tempdir().expect("workspace");
        let checkout = tempfile::tempdir().expect("checkout");
        let agent = tempfile::tempdir().expect("agent");
        touch(&checkout.path().join("bin").join("efficient-pi"));
        touch(&checkout.path().join("bin").join("pi"));
        let prefs = PiPrefs {
            launcher_dir: Some(checkout.path().to_string_lossy().into_owned()),
            agent_dir: Some(agent.path().to_string_lossy().into_owned()),
            ..PiPrefs::default()
        };
        let roles = PrepareRoles {
            provider: String::new(),
            model: String::new(),
            thinking: String::new(),
            smol: String::new(),
        };
        let plan = spawn_plan(
            &prefs,
            &BundledPaths::default(),
            None,
            dir.path(),
            &roles,
            "",
        )
        .expect("direct plan");
        match plan {
            SpawnPlan::Direct { program, source, .. } => {
                assert!(program.ends_with("bin/pi"));
                assert_eq!(source, PathSource::Checkout);
            }
            other => panic!("expected direct pi, got {other:?}"),
        }
    }

    #[test]
    fn spawn_plan_direct_resolves_pi_from_checkout_then_bundled() {
        let dir = tempfile::tempdir().expect("tempdir");
        let launcher_home = tempfile::tempdir().expect("tempdir");
        touch(&launcher_home.path().join("bin").join("pi"));
        let prefs = PiPrefs {
            launcher_dir: Some(launcher_home.path().to_str().expect("utf8").to_string()),
            ..PiPrefs::default()
        };
        let roles = PrepareRoles {
            provider: "bppc".to_string(),
            model: "qwen3.8-27b".to_string(),
            thinking: "xhigh".to_string(),
            smol: "omlx/Qwen3.6-35B-A3B-OptiQ-4bit".to_string(),
        };
        let plan = spawn_plan(&prefs, &BundledPaths::default(), None, dir.path(), &roles, "")
            .expect("plan");
        match plan {
            SpawnPlan::Direct {
                program,
                args,
                source,
            } => {
                assert!(program.starts_with(launcher_home.path().to_str().expect("utf8")));
                assert!(program.ends_with("bin/pi"));
                assert_eq!(args, direct_rpc_args(&roles, dir.path()));
                assert_eq!(source, PathSource::Checkout);
            }
            other => panic!("expected a direct spawn, got {other:?}"),
        }
        // A bundled sidecar wins over the checkout when no launcher file exists.
        let exe = tempfile::tempdir().expect("tempdir");
        touch(&exe.path().join("pi"));
        let bundled = BundledPaths {
            exe_dir: exe.path().to_path_buf(),
            resource_dir: PathBuf::new(),
        };
        let plan = spawn_plan(&PiPrefs::default(), &bundled, None, dir.path(), &roles, "")
            .expect("plan");
        match plan {
            SpawnPlan::Direct { program, source, .. } => {
                assert_eq!(
                    program,
                    exe.path().join("pi").to_str().expect("utf8")
                );
                assert_eq!(source, PathSource::Bundled);
            }
            other => panic!("expected a direct spawn, got {other:?}"),
        }
    }

    #[test]
    fn direct_rpc_args_match_the_launcher_pi_base_args() {
        let roles = PrepareRoles {
            provider: "bppc".to_string(),
            model: "qwen3.8-27b".to_string(),
            thinking: "xhigh".to_string(),
            smol: "omlx/Qwen3.6-35B-A3B-OptiQ-4bit".to_string(),
        };
        let project = tempfile::tempdir().expect("tempdir");
        let expected = vec![
            "--session-dir".to_string(),
            project
                .path()
                .join(".pi")
                .join("sessions")
                .to_string_lossy()
                .into_owned(),
            "--mode".to_string(),
            "rpc".to_string(),
            "--provider".to_string(),
            "bppc".to_string(),
            "--model".to_string(),
            "qwen3.8-27b".to_string(),
            "--thinking".to_string(),
            "xhigh".to_string(),
            "--smol".to_string(),
            "omlx/Qwen3.6-35B-A3B-OptiQ-4bit".to_string(),
            "--tools".to_string(),
            "read,grep,find,ls,todo,subagent".to_string(),
        ];
        assert_eq!(direct_rpc_args(&roles, project.path()), expected);
    }

    #[test]
    fn direct_rpc_args_pass_session_dir_once_before_mode_or_prompt() {
        let roles = PrepareRoles {
            provider: "bppc".to_string(),
            model: "qwen3.8-27b".to_string(),
            thinking: "xhigh".to_string(),
            smol: String::new(),
        };
        let project = tempfile::tempdir().expect("tempdir");
        let args = direct_rpc_args(&roles, project.path());
        let wanted = project
            .path()
            .join(".pi")
            .join("sessions")
            .to_string_lossy()
            .into_owned();
        let flag_positions: Vec<usize> = args
            .iter()
            .enumerate()
            .filter(|(_, a)| a.as_str() == "--session-dir")
            .map(|(i, _)| i)
            .collect();
        assert_eq!(flag_positions, vec![0], "flag appears exactly once, first");
        assert_eq!(args[1], wanted, "flag value is <project>/.pi/sessions");
        let mode = args
            .iter()
            .position(|a| a == "--mode" || a == "-p")
            .expect("mode or prompt flag present");
        assert!(flag_positions[0] < mode, "flag leads --mode/-p");
    }

    #[test]
    fn direct_rpc_args_drop_provider_model_and_smol_when_unset() {
        // No resolved roles: pi keeps settings.json's defaults, so only the
        // always-on flags pass.
        let roles = PrepareRoles {
            provider: String::new(),
            model: "qwen3.8-27b".to_string(),
            thinking: "xhigh".to_string(),
            smol: String::new(),
        };
        let project = tempfile::tempdir().expect("tempdir");
        let session_dir = vec![
            "--session-dir".to_string(),
            project
                .path()
                .join(".pi")
                .join("sessions")
                .to_string_lossy()
                .into_owned(),
        ];
        let mut expected = session_dir.clone();
        expected.extend([
            "--mode".to_string(),
            "rpc".to_string(),
            "--thinking".to_string(),
            "xhigh".to_string(),
            "--tools".to_string(),
            "read,grep,find,ls,todo,subagent".to_string(),
        ]);
        assert_eq!(direct_rpc_args(&roles, project.path()), expected);
        // Whitespace-only counts as unset, and --thinking still passes.
        let blank = PrepareRoles {
            provider: "  ".to_string(),
            model: String::new(),
            thinking: " ".to_string(),
            smol: " ".to_string(),
        };
        let mut expected_blank = session_dir;
        expected_blank.extend([
            "--mode".to_string(),
            "rpc".to_string(),
            "--thinking".to_string(),
            String::new(),
            "--tools".to_string(),
            "read,grep,find,ls,todo,subagent".to_string(),
        ]);
        assert_eq!(direct_rpc_args(&blank, project.path()), expected_blank);
    }

    #[test]
    fn spawn_plan_errors_naming_the_launcher_and_the_candidates() {
        let dir = tempfile::tempdir().expect("tempdir");
        let launcher_home = tempfile::tempdir().expect("tempdir");
        let prefs = PiPrefs {
            launcher_dir: Some(launcher_home.path().to_str().expect("utf8").to_string()),
            ..PiPrefs::default()
        };
        let roles = PrepareRoles {
            provider: String::new(),
            model: String::new(),
            thinking: String::new(),
            smol: String::new(),
        };
        let err = spawn_plan(&prefs, &BundledPaths::default(), None, dir.path(), &roles, "")
            .expect_err("must error");
        assert!(err.contains("no pi binary found"));
        assert!(err.contains(
            &launcher_home
                .path()
                .join("bin")
                .join("efficient-pi")
                .display()
                .to_string()
        ));
        assert!(err.contains(
            &launcher_home
                .path()
                .join("bin")
                .join("pi")
                .display()
                .to_string()
        ));
    }

    #[test]
    fn spawn_plan_configured_missing_pi_binary_fails_naming_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        // The bundled sidecar exists: the configured path must still fail the
        // launch instead of silently running the bundled binary.
        let exe = tempfile::tempdir().expect("tempdir");
        touch(&exe.path().join("pi"));
        let bundled = BundledPaths {
            exe_dir: exe.path().to_path_buf(),
            resource_dir: PathBuf::new(),
        };
        let configured = "/no/such/pi-for-terax-tests";
        let prefs = PiPrefs {
            pi_bin: Some(configured.to_string()),
            ..PiPrefs::default()
        };
        let roles = PrepareRoles {
            provider: String::new(),
            model: String::new(),
            thinking: String::new(),
            smol: String::new(),
        };
        let err = spawn_plan(&prefs, &bundled, None, dir.path(), &roles, "")
            .expect_err("configured missing pi binary must fail");
        assert!(
            err.contains("configured pi binary not found: /no/such/pi-for-terax-tests"),
            "err: {err}"
        );
        // No lower-precedence candidate is named: nothing else was tried.
        assert!(
            !err.contains(exe.path().join("pi").to_str().expect("utf8")),
            "err: {err}"
        );
    }

    #[test]
    fn spawn_plan_unset_uses_the_bundled_sidecar() {
        let dir = tempfile::tempdir().expect("tempdir");
        let exe = tempfile::tempdir().expect("tempdir");
        touch(&exe.path().join("pi"));
        let bundled = BundledPaths {
            exe_dir: exe.path().to_path_buf(),
            resource_dir: PathBuf::new(),
        };
        let roles = PrepareRoles {
            provider: String::new(),
            model: String::new(),
            thinking: String::new(),
            smol: String::new(),
        };
        let plan = spawn_plan(&PiPrefs::default(), &bundled, None, dir.path(), &roles, "")
            .expect("plan");
        match plan {
            SpawnPlan::Direct { program, source, .. } => {
                assert_eq!(
                    program,
                    exe.path().join("pi").to_str().expect("utf8")
                );
                assert_eq!(source, PathSource::Bundled);
            }
            other => panic!("expected a direct bundled spawn, got {other:?}"),
        }
    }

    #[test]
    fn spawn_plan_configured_pi_binary_beats_the_checkout_launcher() {
        let dir = tempfile::tempdir().expect("tempdir");
        let launcher_home = tempfile::tempdir().expect("tempdir");
        // The checkout launcher exists; the explicit pi binary is still the
        // design 3.6 first choice and must not be bypassed by it.
        touch(&launcher_home.path().join("bin").join("efficient-pi"));
        let configured = tempfile::tempdir().expect("tempdir");
        touch(&configured.path().join("my-pi"));
        let configured_path = configured.path().join("my-pi");
        let prefs = PiPrefs {
            pi_bin: Some(configured_path.to_string_lossy().into_owned()),
            launcher_dir: Some(launcher_home.path().to_str().expect("utf8").to_string()),
            ..PiPrefs::default()
        };
        let roles = PrepareRoles {
            provider: String::new(),
            model: String::new(),
            thinking: String::new(),
            smol: String::new(),
        };
        let plan = spawn_plan(&prefs, &BundledPaths::default(), None, dir.path(), &roles, "")
            .expect("plan");
        match plan {
            SpawnPlan::Direct { program, source, .. } => {
                assert_eq!(
                    program,
                    configured_path.to_string_lossy().into_owned()
                );
                assert_eq!(source, PathSource::Pref);
            }
            other => panic!("expected a direct configured spawn, got {other:?}"),
        }
    }

    #[test]
    fn errors_without_workspace_cwd() {
        let err =
            resolve_spec(None, Some("/somewhere"), &[], HashMap::new()).expect_err("must error");
        assert!(err.contains("workspace cwd"));
    }
}

#[cfg(all(test, windows))]
mod windows_spawn_tests {
    use super::*;
    use std::fs;

    #[test]
    fn checkout_launcher_is_skipped_for_the_bundled_direct_pi() {
        let workspace = tempfile::tempdir().expect("workspace");
        let checkout = tempfile::tempdir().expect("checkout");
        let bundled_dir = tempfile::tempdir().expect("bundled");
        fs::create_dir_all(checkout.path().join("bin")).expect("checkout bin");
        fs::write(checkout.path().join("bin").join("efficient-pi"), "stub")
            .expect("checkout launcher");
        fs::write(checkout.path().join("bin").join("pi.exe"), "stub")
            .expect("checkout pi");
        fs::write(bundled_dir.path().join("pi.exe"), "stub").expect("bundled pi");
        let prefs = PiPrefs {
            launcher_dir: Some(checkout.path().to_string_lossy().into_owned()),
            ..PiPrefs::default()
        };
        let roles = PrepareRoles {
            provider: "bppc".to_string(),
            model: "model".to_string(),
            thinking: "high".to_string(),
            smol: String::new(),
        };
        let plan = spawn_plan(
            &prefs,
            &BundledPaths {
                exe_dir: bundled_dir.path().to_path_buf(),
                resource_dir: PathBuf::new(),
            },
            None,
            workspace.path(),
            &roles,
            "",
        )
        .expect("bundled direct plan");
        match plan {
            SpawnPlan::Direct { program, source, .. } => {
                assert_eq!(source, PathSource::Bundled);
                assert_eq!(
                    program,
                    bundled_dir.path().join("pi.exe").to_string_lossy().into_owned()
                );
            }
            other => panic!("expected bundled direct pi, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod resolve_paths_tests {
    use super::*;

    fn write_file(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(path, b"binary").expect("write");
        // Pref binaries are held to the executable-file standard, so every
        // fixture binary carries the execute bit.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
    }

    fn make_dir(path: &Path) {
        std::fs::create_dir_all(path).expect("mkdir");
    }

    fn prefs(
        pi_bin: Option<&str>,
        agent_bin: Option<&str>,
        agent_dir: Option<&str>,
        launcher_dir: Option<&str>,
    ) -> PiPrefs {
        PiPrefs {
            pi_bin: pi_bin.map(str::to_string),
            agent_bin: agent_bin.map(str::to_string),
            agent_dir: agent_dir.map(str::to_string),
            launcher_dir: launcher_dir.map(str::to_string),
        }
    }

    fn bundled(exe_dir: &Path, resource_dir: &Path) -> BundledPaths {
        BundledPaths {
            exe_dir: exe_dir.to_path_buf(),
            resource_dir: resource_dir.to_path_buf(),
        }
    }

    #[test]
    fn pref_overrides_beat_bundled_and_checkout() {
        let home = tempfile::tempdir().expect("tempdir");
        let exe = tempfile::tempdir().expect("tempdir");
        let res = tempfile::tempdir().expect("tempdir");
        let checkout = tempfile::tempdir().expect("tempdir");
        let data = tempfile::tempdir().expect("tempdir");
        // Every lower-precedence candidate exists too; the prefs must win.
        write_file(&exe.path().join("pi"));
        write_file(&exe.path().join("agent"));
        make_dir(&res.path().join("pi-home").join("agent"));
        write_file(&checkout.path().join("bin").join("pi"));
        make_dir(&checkout.path().join("pi-home").join("agent"));
        write_file(&home.path().join("custom").join("pi"));
        write_file(&home.path().join("custom").join("agent"));
        make_dir(&home.path().join("custom").join("agent-dir"));
        let home_str = home.path().to_str().expect("utf8");
        let p = prefs(
            Some("$HOME/custom/pi"),
            Some("  $HOME/custom/agent  "),
            Some("$HOME/custom/agent-dir"),
            Some(checkout.path().to_str().expect("utf8")),
        );
        let resolved = resolve_paths_with(
            &p,
            &bundled(exe.path(), res.path()),
            Some(home_str),
            "",
            data.path(),
        );
        let pi = resolved.pi;
        assert_eq!(pi.source, PathSource::Pref);
        assert_eq!(pi.path.as_deref(), Some(format!("{home_str}/custom/pi")).as_deref());
        let agent = resolved.agent;
        assert_eq!(agent.source, PathSource::Pref);
        assert_eq!(
            agent.path.as_deref(),
            Some(format!("{home_str}/custom/agent")).as_deref()
        );
        let agent_dir = resolved.agent_dir;
        assert_eq!(agent_dir.source, PathSource::Pref);
        assert_eq!(
            agent_dir.path.as_deref(),
            Some(format!("{home_str}/custom/agent-dir")).as_deref()
        );
        // A pref agent dir is its own runtime dir.
        assert_eq!(resolved.runtime_agent_dir.source, PathSource::Pref);
        assert_eq!(
            resolved.runtime_agent_dir.path.as_deref(),
            Some(format!("{home_str}/custom/agent-dir")).as_deref()
        );
        assert!(!resolved.runtime_agent_dir.seeded);
    }

    #[test]
    fn configured_missing_pi_binary_never_falls_through_to_bundled() {
        let home = tempfile::tempdir().expect("tempdir");
        let exe = tempfile::tempdir().expect("tempdir");
        let data = tempfile::tempdir().expect("tempdir");
        // The bundled sidecar exists and would win if the resolution fell
        // through; the configured path is authoritative instead.
        write_file(&exe.path().join("pi"));
        write_file(&exe.path().join("agent"));
        let home_str = home.path().to_str().expect("utf8");
        let p = prefs(Some("$HOME/no-such-pi"), None, None, None);
        let resolved = resolve_paths_with(
            &p,
            &bundled(exe.path(), Path::new("")),
            Some(home_str),
            "",
            data.path(),
        );
        assert_eq!(resolved.pi.source, PathSource::Missing);
        assert_eq!(resolved.pi.path, None);
        assert_eq!(
            resolved.pi.candidates,
            vec![
                format!("{home_str}/no-such-pi"),
                exe.path().join("pi").to_str().expect("utf8").to_string()
            ]
        );
    }

    #[test]
    fn configured_missing_agent_binary_never_falls_through_to_bundled() {
        let home = tempfile::tempdir().expect("tempdir");
        let exe = tempfile::tempdir().expect("tempdir");
        let data = tempfile::tempdir().expect("tempdir");
        write_file(&exe.path().join("pi"));
        write_file(&exe.path().join("agent"));
        let home_str = home.path().to_str().expect("utf8");
        let p = prefs(None, Some("$HOME/no-such-agent"), None, None);
        let resolved = resolve_paths_with(
            &p,
            &bundled(exe.path(), Path::new("")),
            Some(home_str),
            "",
            data.path(),
        );
        assert_eq!(resolved.agent.source, PathSource::Missing);
        assert_eq!(resolved.agent.path, None);
        assert_eq!(
            resolved.agent.candidates,
            vec![
                format!("{home_str}/no-such-agent"),
                exe.path()
                    .join("agent")
                    .to_str()
                    .expect("utf8")
                    .to_string()
            ]
        );
        // The pi resolution next to it is untouched.
        assert_eq!(resolved.pi.source, PathSource::Bundled);
    }

    #[test]
    #[cfg(unix)]
    fn configured_binary_that_is_not_executable_fails_like_a_missing_one() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().expect("tempdir");
        let exe = tempfile::tempdir().expect("tempdir");
        let data = tempfile::tempdir().expect("tempdir");
        write_file(&exe.path().join("pi"));
        let home_str = home.path().to_str().expect("utf8");
        let configured = home.path().join("not-executable-pi");
        std::fs::write(&configured, b"binary").expect("write");
        std::fs::set_permissions(&configured, std::fs::Permissions::from_mode(0o644))
            .expect("chmod");
        let p = prefs(Some(configured.to_str().expect("utf8")), None, None, None);
        let resolved = resolve_paths_with(
            &p,
            &bundled(exe.path(), Path::new("")),
            Some(home_str),
            "",
            data.path(),
        );
        assert_eq!(resolved.pi.source, PathSource::Missing);
        assert_eq!(resolved.pi.path, None);
    }

    #[test]
    fn bundled_sidecars_beat_the_checkout() {
        let exe = tempfile::tempdir().expect("tempdir");
        let res = tempfile::tempdir().expect("tempdir");
        let checkout = tempfile::tempdir().expect("tempdir");
        let home = tempfile::tempdir().expect("tempdir");
        let data = tempfile::tempdir().expect("tempdir");
        write_file(&exe.path().join("pi"));
        write_file(&exe.path().join("agent"));
        make_dir(&res.path().join("pi-home").join("agent"));
        write_file(&checkout.path().join("bin").join("pi"));
        make_dir(&checkout.path().join("pi-home").join("agent"));
        let p = prefs(
            None,
            None,
            None,
            Some(checkout.path().to_str().expect("utf8")),
        );
        let resolved = resolve_paths_with(
            &p,
            &bundled(exe.path(), res.path()),
            Some(home.path().to_str().expect("utf8")),
            "",
            data.path(),
        );
        assert_eq!(resolved.pi.source, PathSource::Bundled);
        assert_eq!(
            resolved.pi.path.as_deref(),
            Some(exe.path().join("pi").to_str().expect("utf8"))
        );
        assert_eq!(resolved.agent.source, PathSource::Bundled);
        assert_eq!(
            resolved.agent.path.as_deref(),
            Some(exe.path().join("agent").to_str().expect("utf8"))
        );
        assert_eq!(resolved.agent_dir.source, PathSource::Bundled);
        assert_eq!(
            resolved.agent_dir.path.as_deref(),
            Some(
                res.path()
                    .join("pi-home")
                    .join("agent")
                    .to_str()
                    .expect("utf8")
            )
        );
        // The runtime agent dir is the seeded copy in the app data dir, not
        // the bundled template; nothing has seeded it yet.
        assert_eq!(resolved.runtime_agent_dir.source, PathSource::Bundled);
        assert_eq!(
            resolved.runtime_agent_dir.path.as_deref(),
            Some(
                data.path()
                    .join("pi-home")
                    .join("agent")
                    .to_str()
                    .expect("utf8")
            )
        );
        assert!(!resolved.runtime_agent_dir.seeded);
    }

    #[test]
    fn runtime_agent_dir_is_seeded_once_the_stamp_exists() {
        let exe = tempfile::tempdir().expect("tempdir");
        let res = tempfile::tempdir().expect("tempdir");
        let data = tempfile::tempdir().expect("tempdir");
        write_file(&exe.path().join("pi"));
        make_dir(&res.path().join("pi-home").join("agent"));
        let p = prefs(None, None, None, None);
        let resolved = resolve_paths_with(
            &p,
            &bundled(exe.path(), res.path()),
            None,
            "",
            data.path(),
        );
        assert_eq!(resolved.runtime_agent_dir.source, PathSource::Bundled);
        assert!(!resolved.runtime_agent_dir.seeded);
        // The same stamp launcher::seed_agent_dir writes last.
        make_dir(&data.path().join("pi-home").join("agent"));
        write_file(&data.path().join("pi-home").join("agent").join(".terax-seed"));
        let resolved = resolve_paths_with(
            &p,
            &bundled(exe.path(), res.path()),
            None,
            "",
            data.path(),
        );
        assert!(resolved.runtime_agent_dir.seeded);
    }

    #[test]
    fn checkout_fallbacks_kick_in_without_bundled_dirs() {
        let checkout = tempfile::tempdir().expect("tempdir");
        let home = tempfile::tempdir().expect("tempdir");
        let data = tempfile::tempdir().expect("tempdir");
        write_file(&checkout.path().join("bin").join("pi"));
        make_dir(&checkout.path().join("pi-home").join("agent"));
        let checkout_str = checkout.path().to_str().expect("utf8");
        let p = prefs(None, None, None, Some(checkout_str));
        let resolved = resolve_paths_with(
            &p,
            &BundledPaths::default(),
            Some(home.path().to_str().expect("utf8")),
            "",
            data.path(),
        );
        assert_eq!(resolved.pi.source, PathSource::Checkout);
        assert_eq!(
            resolved.pi.path.as_deref(),
            Some(format!("{checkout_str}/bin/pi")).as_deref()
        );
        // No checkout candidate exists for the agent binary: the harness
        // binary is not inside the efficient-pi checkout and a sibling path
        // must not be guessed.
        assert_eq!(resolved.agent.source, PathSource::Missing);
        assert_eq!(resolved.agent.path, None);
        assert_eq!(resolved.agent.candidates, Vec::<String>::new());
        // A checkout agent dir is its own runtime dir.
        assert_eq!(resolved.agent_dir.source, PathSource::Checkout);
        assert_eq!(
            resolved.agent_dir.path.as_deref(),
            Some(format!("{checkout_str}/pi-home/agent")).as_deref()
        );
        assert_eq!(resolved.runtime_agent_dir.source, PathSource::Checkout);
        assert_eq!(
            resolved.runtime_agent_dir.path.as_deref(),
            Some(format!("{checkout_str}/pi-home/agent")).as_deref()
        );
    }

    #[test]
    fn missing_reports_missing_with_ordered_candidates() {
        let checkout = tempfile::tempdir().expect("tempdir");
        let home = tempfile::tempdir().expect("tempdir");
        let data = tempfile::tempdir().expect("tempdir");
        let checkout_str = checkout.path().to_str().expect("utf8");
        let p = prefs(None, None, None, Some(checkout_str));
        let resolved = resolve_paths_with(
            &p,
            &BundledPaths::default(),
            Some(home.path().to_str().expect("utf8")),
            "",
            data.path(),
        );
        for entry in [&resolved.pi, &resolved.agent, &resolved.agent_dir] {
            assert_eq!(entry.source, PathSource::Missing);
            assert_eq!(entry.path, None);
        }
        // Candidates follow precedence order: bundled first (skipped here
        // because the dirs are empty), then checkout.
        assert_eq!(
            resolved.pi.candidates,
            vec![format!("{checkout_str}/bin/pi")]
        );
        // The agent binary has no checkout candidate, so nothing can be
        // listed; pi_paths callers must handle the empty list.
        assert_eq!(resolved.agent.candidates, Vec::<String>::new());
        assert_eq!(
            resolved.agent_dir.candidates,
            vec![format!("{checkout_str}/pi-home/agent")]
        );
        // A missing agent dir has no runtime dir to name.
        assert_eq!(resolved.runtime_agent_dir.source, PathSource::Missing);
        assert_eq!(resolved.runtime_agent_dir.path, None);
        assert!(!resolved.runtime_agent_dir.seeded);
    }

    #[test]
    fn blank_pref_values_count_as_unset() {
        let data = tempfile::tempdir().expect("tempdir");
        let p = prefs(Some("   "), Some(""), Some("  "), Some(""));
        let resolved = resolve_paths_with(&p, &BundledPaths::default(), None, "", data.path());
        // No candidate leaks the blank string into the listing.
        for entry in [&resolved.pi, &resolved.agent, &resolved.agent_dir] {
            assert!(!entry.candidates.iter().any(|c| c.trim().is_empty()));
        }
    }

    #[test]
    fn exe_suffix_is_a_parameter_so_windows_names_are_testable() {
        assert_eq!(sidecar_name("pi", ".exe"), "pi.exe");
        assert_eq!(sidecar_name("agent", ""), "agent");
        let exe = tempfile::tempdir().expect("tempdir");
        let data = tempfile::tempdir().expect("tempdir");
        let p = prefs(None, None, None, None);
        // With the plain suffix the .exe sidecars are invisible.
        write_file(&exe.path().join("pi.exe"));
        write_file(&exe.path().join("agent.exe"));
        let plain = resolve_paths_with(
            &p,
            &bundled(exe.path(), Path::new("")),
            None,
            "",
            data.path(),
        );
        assert_eq!(plain.pi.source, PathSource::Missing);
        assert_eq!(plain.agent.source, PathSource::Missing);
        // With the Windows suffix they resolve as bundled.
        let windows = resolve_paths_with(
            &p,
            &bundled(exe.path(), Path::new("")),
            None,
            ".exe",
            data.path(),
        );
        assert_eq!(windows.pi.source, PathSource::Bundled);
        assert_eq!(
            windows.pi.path.as_deref(),
            Some(exe.path().join("pi.exe").to_str().expect("utf8"))
        );
        assert_eq!(windows.agent.source, PathSource::Bundled);
        assert_eq!(
            windows.agent.path.as_deref(),
            Some(exe.path().join("agent.exe").to_str().expect("utf8"))
        );
    }
}

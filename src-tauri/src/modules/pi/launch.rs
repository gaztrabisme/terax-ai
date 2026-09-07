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

/// pi's agent dir when PI_CODING_AGENT_DIR is unset (vendor pi_agent_rust
/// src/config.rs global_dir_from_env): `$HOME/.pi/agent`, with pi's own "."
/// fallback when the home dir is unknown.
pub(crate) fn default_global_dir(home: Option<&str>) -> PathBuf {
    PathBuf::from(match home.map(str::trim).filter(|s| !s.is_empty()) {
        Some(h) => h.to_string(),
        None => ".".to_string(),
    })
    .join(".pi")
    .join("agent")
}

/// Tool list the bash launcher passes in PI_BASE_ARGS (bin/efficient-pi); the
/// direct spawn must request the same toolset or pi falls back to its default.
const DIRECT_TOOLS: &str = "read,grep,find,ls,todo,subagent";

/// Args for a direct pi spawn: `--mode rpc` plus the launcher's PI_BASE_ARGS
/// role flags. `--provider`/`--model` are omitted when the provider is empty
/// (then pi uses the agent dir's settings.json default) and `--smol` when the
/// smol role is empty; `--thinking` and `--tools` always pass, matching the
/// bash launcher.
pub fn direct_rpc_args(roles: &PrepareRoles) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), "rpc".to_string()];
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

/// Spawn decision, shared by pi_open and the resolve_spec wrapper: the
/// checkout launcher wins when its file exists (today's behavior on machines
/// with the checkout), else a pi binary resolved through the shared
/// precedence chain spawns directly, else the error names every candidate so
/// a missing-install tab still explains itself. The launcher root falls back
/// to the workspace cwd when launcherDir is unset or blank. `roles` carries
/// the resolved EFFICIENT_PI_* values the direct args are built from.
pub fn spawn_plan(
    prefs: &PiPrefs,
    bundled: &BundledPaths,
    home: Option<&str>,
    cwd: &Path,
    roles: &PrepareRoles,
) -> Result<SpawnPlan, String> {
    let root = launcher_root(prefs, home, cwd);
    let launcher = root.join("bin").join("efficient-pi");
    if launcher.is_file() {
        return Ok(SpawnPlan::CheckoutLauncher {
            program: launcher.to_string_lossy().into_owned(),
            args: vec![
                "--no-prime".to_string(),
                "--mode".to_string(),
                "rpc".to_string(),
            ],
        });
    }
    // No launcher: resolve the pi binary through the shared precedence chain,
    // with the checkout rooted at launcherDir (or the workspace when unset).
    let effective = PiPrefs {
        launcher_dir: Some(root.to_string_lossy().into_owned()),
        ..prefs.clone()
    };
    let resolved = resolve_paths_with(&effective, bundled, home, std::env::consts::EXE_SUFFIX);
    match (&resolved.pi.path, resolved.pi.source) {
        (Some(program), source @ (PathSource::Pref | PathSource::Bundled | PathSource::Checkout)) => {
            Ok(SpawnPlan::Direct {
                program: program.clone(),
                args: direct_rpc_args(roles),
                source,
            })
        }
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
    let mut spec = match spawn_plan(&prefs, bundled, home, dir, &roles)? {
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

/// Checkout fallback for the harness agent, the same path the board code
/// spawns; kept in `$HOME/...` form so it expands like a settings value.
const AGENT_CHECKOUT_BIN: &str = "$HOME/Documents/Work/harness/target/release/agent";

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
}

/// Sidecar file name for a target: `pi` or `pi.exe`. The suffix is a parameter
/// so tests can exercise the Windows form on any host.
fn sidecar_name(base: &str, exe_suffix: &str) -> String {
    format!("{base}{exe_suffix}")
}

/// Resolution precedence: a pref that exists wins, then the bundled file, then
/// the efficient-pi checkout, else Missing with the candidate list.
pub fn resolve_paths(prefs: &PiPrefs, bundled: &BundledPaths, home: Option<&str>) -> ResolvedPaths {
    resolve_paths_with(prefs, bundled, home, std::env::consts::EXE_SUFFIX)
}

fn resolve_paths_with(
    prefs: &PiPrefs,
    bundled: &BundledPaths,
    home: Option<&str>,
    exe_suffix: &str,
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

    let mut agent = Vec::new();
    if let Some(p) = pref_path(prefs.agent_bin.as_deref(), home) {
        agent.push((p, PathSource::Pref));
    }
    if let Some(p) = sidecar_path(&bundled.exe_dir, AGENT_SIDECAR, exe_suffix) {
        agent.push((p, PathSource::Bundled));
    }
    agent.push((
        expand_home(AGENT_CHECKOUT_BIN, home).into(),
        PathSource::Checkout,
    ));

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

    ResolvedPaths {
        pi: pick(pi, false),
        agent: pick(agent, false),
        agent_dir: pick(agent_dir, true),
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

/// First candidate whose file (or dir, for `is_dir`) exists wins; the listed
/// candidates are returned either way for Missing diagnostics.
fn pick(candidates: Vec<(PathBuf, PathSource)>, is_dir: bool) -> ResolvedPath {
    let listed = candidates
        .iter()
        .map(|(p, _)| p.to_string_lossy().into_owned())
        .collect();
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
        // Direct spawns carry the launcher's PI_BASE_ARGS role flags.
        assert_eq!(
            spec.args,
            vec![
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
        let plan = spawn_plan(&prefs, &BundledPaths::default(), None, dir.path(), &roles)
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
        let plan = spawn_plan(&prefs, &BundledPaths::default(), None, dir.path(), &roles)
            .expect("plan");
        match plan {
            SpawnPlan::Direct {
                program,
                args,
                source,
            } => {
                assert!(program.starts_with(launcher_home.path().to_str().expect("utf8")));
                assert!(program.ends_with("bin/pi"));
                assert_eq!(args, direct_rpc_args(&roles));
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
        let plan = spawn_plan(&PiPrefs::default(), &bundled, None, dir.path(), &roles)
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
        assert_eq!(
            direct_rpc_args(&roles),
            vec![
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
            ]
        );
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
        assert_eq!(
            direct_rpc_args(&roles),
            vec![
                "--mode".to_string(),
                "rpc".to_string(),
                "--thinking".to_string(),
                "xhigh".to_string(),
                "--tools".to_string(),
                "read,grep,find,ls,todo,subagent".to_string(),
            ]
        );
        // Whitespace-only counts as unset, and --thinking still passes.
        let blank = PrepareRoles {
            provider: "  ".to_string(),
            model: String::new(),
            thinking: " ".to_string(),
            smol: " ".to_string(),
        };
        assert_eq!(
            direct_rpc_args(&blank),
            vec![
                "--mode".to_string(),
                "rpc".to_string(),
                "--thinking".to_string(),
                String::new(),
                "--tools".to_string(),
                "read,grep,find,ls,todo,subagent".to_string(),
            ]
        );
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
        let err = spawn_plan(&prefs, &BundledPaths::default(), None, dir.path(), &roles)
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
    fn errors_without_workspace_cwd() {
        let err =
            resolve_spec(None, Some("/somewhere"), &[], HashMap::new()).expect_err("must error");
        assert!(err.contains("workspace cwd"));
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
        let resolved = resolve_paths_with(&p, &bundled(exe.path(), res.path()), Some(home_str), "");
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
    }

    #[test]
    fn bundled_sidecars_beat_the_checkout() {
        let exe = tempfile::tempdir().expect("tempdir");
        let res = tempfile::tempdir().expect("tempdir");
        let checkout = tempfile::tempdir().expect("tempdir");
        let home = tempfile::tempdir().expect("tempdir");
        write_file(&exe.path().join("pi"));
        write_file(&exe.path().join("agent"));
        make_dir(&res.path().join("pi-home").join("agent"));
        write_file(&checkout.path().join("bin").join("pi"));
        make_dir(&checkout.path().join("pi-home").join("agent"));
        make_dir(&home.path().join("Documents/Work/harness/target/release"));
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
    }

    #[test]
    fn checkout_fallbacks_kick_in_without_bundled_dirs() {
        let checkout = tempfile::tempdir().expect("tempdir");
        let home = tempfile::tempdir().expect("tempdir");
        write_file(&checkout.path().join("bin").join("pi"));
        make_dir(&checkout.path().join("pi-home").join("agent"));
        write_file(&home.path().join("Documents/Work/harness/target/release/agent"));
        let checkout_str = checkout.path().to_str().expect("utf8");
        let home_str = home.path().to_str().expect("utf8");
        let p = prefs(None, None, None, Some(checkout_str));
        let resolved = resolve_paths_with(&p, &BundledPaths::default(), Some(home_str), "");
        assert_eq!(resolved.pi.source, PathSource::Checkout);
        assert_eq!(
            resolved.pi.path.as_deref(),
            Some(format!("{checkout_str}/bin/pi")).as_deref()
        );
        // The agent checkout path is the same one the board code spawns.
        assert_eq!(resolved.agent.source, PathSource::Checkout);
        assert_eq!(
            resolved.agent.path.as_deref(),
            Some(format!("{home_str}/Documents/Work/harness/target/release/agent")).as_deref()
        );
        assert_eq!(resolved.agent_dir.source, PathSource::Checkout);
        assert_eq!(
            resolved.agent_dir.path.as_deref(),
            Some(format!("{checkout_str}/pi-home/agent")).as_deref()
        );
    }

    #[test]
    fn missing_reports_missing_with_ordered_candidates() {
        let checkout = tempfile::tempdir().expect("tempdir");
        let home = tempfile::tempdir().expect("tempdir");
        let checkout_str = checkout.path().to_str().expect("utf8");
        let home_str = home.path().to_str().expect("utf8");
        let p = prefs(None, None, None, Some(checkout_str));
        let resolved = resolve_paths_with(&p, &BundledPaths::default(), Some(home_str), "");
        for entry in [&resolved.pi, &resolved.agent, &resolved.agent_dir] {
            assert_eq!(entry.source, PathSource::Missing);
            assert_eq!(entry.path, None);
            assert!(!entry.candidates.is_empty(), "candidates must be listed");
        }
        // Candidates follow precedence order: bundled first (skipped here
        // because the dirs are empty), then checkout.
        assert_eq!(
            resolved.pi.candidates,
            vec![format!("{checkout_str}/bin/pi")]
        );
        assert_eq!(
            resolved.agent.candidates,
            vec![format!("{home_str}/Documents/Work/harness/target/release/agent")]
        );
        assert_eq!(
            resolved.agent_dir.candidates,
            vec![format!("{checkout_str}/pi-home/agent")]
        );
    }

    #[test]
    fn blank_pref_values_count_as_unset() {
        let p = prefs(Some("   "), Some(""), Some("  "), Some(""));
        let resolved = resolve_paths_with(&p, &BundledPaths::default(), None, "");
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
        let p = prefs(None, None, None, None);
        // With the plain suffix the .exe sidecars are invisible.
        write_file(&exe.path().join("pi.exe"));
        write_file(&exe.path().join("agent.exe"));
        let plain = resolve_paths_with(&p, &bundled(exe.path(), Path::new("")), None, "");
        assert_eq!(plain.pi.source, PathSource::Missing);
        assert_eq!(plain.agent.source, PathSource::Missing);
        // With the Windows suffix they resolve as bundled.
        let windows = resolve_paths_with(&p, &bundled(exe.path(), Path::new("")), None, ".exe");
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

use std::collections::HashMap;
use std::path::Path;

use super::session::SpawnSpec;

/// HOME for `$HOME/` expansion in settings values: the env var first (the
/// documented contract), the `dirs` lookup as the Windows fallback where HOME
/// is usually unset. Never passed through a shell.
fn home_dir() -> Option<String> {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => Some(home),
        _ => dirs::home_dir().map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Expands a leading `$HOME/` (or bare `$HOME`) in `dir` against `home`.
/// Pure: everything else passes through untouched.
fn expand_home(dir: &str, home: Option<&str>) -> String {
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

/// Extra args appended after the mode flags (prompt targets, provider
/// overrides, anything pi accepts; the launcher passes unknown args through).
/// `launcher_dir` picks the checkout whose bin/efficient-pi (then bin/pi) is
/// spawned; empty falls back to the workspace-local bin/ lookup. `cwd` stays
/// the workspace so pi's project root is the user's project.
pub fn resolve_spec(
    cwd: Option<&Path>,
    launcher_dir: Option<&str>,
    extra_args: &[String],
    env: HashMap<String, String>,
) -> Result<SpawnSpec, String> {
    resolve_spec_with(cwd, launcher_dir, home_dir().as_deref(), extra_args, env)
}

/// Same as `resolve_spec` with the home dir injected for `$HOME/` expansion.
fn resolve_spec_with(
    cwd: Option<&Path>,
    launcher_dir: Option<&str>,
    home: Option<&str>,
    extra_args: &[String],
    env: HashMap<String, String>,
) -> Result<SpawnSpec, String> {
    let dir = cwd
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "pi needs a workspace cwd as its project root".to_string())?;
    let root = match launcher_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => expand_home(dir, home).into(),
        None => dir.to_path_buf(),
    };
    let launcher = root.join("bin").join("efficient-pi");
    if launcher.is_file() {
        let mut args = vec![
            "--no-prime".to_string(),
            "--mode".to_string(),
            "rpc".to_string(),
        ];
        args.extend_from_slice(extra_args);
        return Ok(SpawnSpec {
            program: launcher.to_string_lossy().into_owned(),
            args,
            cwd: Some(dir.to_string_lossy().into_owned()),
            env,
        });
    }
    let direct = root.join("bin").join("pi");
    if direct.is_file() {
        let mut args = vec!["--mode".to_string(), "rpc".to_string()];
        args.extend_from_slice(extra_args);
        return Ok(SpawnSpec {
            program: direct.to_string_lossy().into_owned(),
            args,
            cwd: Some(dir.to_string_lossy().into_owned()),
            env,
        });
    }
    Err(format!(
        "no pi binary found: expected {} or {}",
        launcher.display(),
        direct.display()
    ))
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
        assert_eq!(spec.args, vec!["--mode".to_string(), "rpc".to_string()]);
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
    fn errors_without_workspace_cwd() {
        let err =
            resolve_spec(None, Some("/somewhere"), &[], HashMap::new()).expect_err("must error");
        assert!(err.contains("workspace cwd"));
    }
}

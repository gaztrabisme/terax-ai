use std::collections::HashMap;
use std::path::Path;

use super::session::SpawnSpec;

/// Extra args appended after the mode flags (prompt targets, provider
/// overrides, anything pi accepts; the launcher passes unknown args through).
pub fn resolve_spec(
    cwd: Option<&Path>,
    extra_args: &[String],
    env: HashMap<String, String>,
) -> Result<SpawnSpec, String> {
    let dir = cwd
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "pi needs a workspace cwd to resolve the binary from".to_string())?;
    let launcher = dir.join("bin").join("efficient-pi");
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
    let direct = dir.join("bin").join("pi");
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
        touch(&dir.path().join("bin").join("efficient-pi"));
        touch(&dir.path().join("bin").join("pi"));
        let spec = resolve_spec(
            Some(dir.path()),
            &["--model".to_string(), "m".to_string()],
            HashMap::new(),
        )
        .expect("spec");
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
        assert_eq!(
            spec.cwd.as_deref(),
            Some(dir.path().to_str().expect("utf8"))
        );
    }

    #[test]
    fn falls_back_to_direct_pi() {
        let dir = tempfile::tempdir().expect("tempdir");
        touch(&dir.path().join("bin").join("pi"));
        let mut env = HashMap::new();
        env.insert("PI_CODING_AGENT_DIR".to_string(), "/tmp/agent".to_string());
        let spec = resolve_spec(Some(dir.path()), &[], env).expect("spec");
        assert!(spec.program.ends_with("bin/pi"));
        assert_eq!(spec.args, vec!["--mode".to_string(), "rpc".to_string()]);
        assert_eq!(
            spec.env.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/tmp/agent")
        );
    }

    #[test]
    fn errors_when_no_binary_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = resolve_spec(Some(dir.path()), &[], HashMap::new()).expect_err("must error");
        assert!(err.contains("no pi binary found"));
    }
}

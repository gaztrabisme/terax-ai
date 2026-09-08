//! Cloud provider API keys for pi sessions, stored under the app data dir
//! (philosophy 8: keys live in the user's directories, never in a repo).
//! pi resolves provider credentials from env vars before the per-agent-dir
//! auth.json, so the spawn env carries these on every path and a cloud
//! orchestrator works the same in checkout and standalone mode without
//! touching either agent dir. Keys are never logged and never returned to
//! the frontend after set; pi_secret_status answers presence only.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;

/// Provider id -> the env vars the spawn carries for it (Rust twin of
/// PI_CLOUD_PROVIDERS in src/modules/pi/lib/providers.ts). google holds two:
/// pi's provider metadata lists GEMINI_API_KEY and GOOGLE_API_KEY. omlx holds
/// OMLX_API_KEY for pi plus EFFICIENT_PI_OMLX_KEY, which both spawn paths and
/// the models.json render read.
const PROVIDER_ENVS: &[(&str, &[&str])] = &[
    ("anthropic", &["ANTHROPIC_API_KEY"]),
    ("openai", &["OPENAI_API_KEY"]),
    ("google", &["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
    ("openrouter", &["OPENROUTER_API_KEY"]),
    ("omlx", &["OMLX_API_KEY", "EFFICIENT_PI_OMLX_KEY"]),
];

fn envs_for(provider: &str) -> Option<&'static [&'static str]> {
    PROVIDER_ENVS
        .iter()
        .find(|(id, _)| *id == provider)
        .map(|(_, envs)| *envs)
}

/// The secrets file lives beside the preferences under the app data dir.
pub fn secrets_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("pi-secrets.json")
}

/// Reads the stored keys. Unknown providers and non-string values are ignored,
/// while a malformed existing file is an error naming the file.
fn read_secrets(app_data_dir: &Path) -> Result<HashMap<String, String>, String> {
    if app_data_dir.as_os_str().is_empty() {
        return Ok(HashMap::new());
    }
    let path = secrets_path(app_data_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("invalid JSON in {}: {e}", path.display()))?;
    let Some(map) = parsed.as_object() else {
        return Err(format!(
            "invalid JSON in {}: expected a JSON object",
            path.display()
        ));
    };
    Ok(map
        .iter()
        .filter_map(|(provider, value)| {
            let key = value.as_str()?.trim().to_string();
            let key = (!key.is_empty()).then_some(key)?;
            envs_for(provider)?;
            Some((provider.clone(), key))
        })
        .collect())
}

/// Writes the whole store through a same-directory temporary file. The temp is
/// flushed and synced before the rename, and the live file is never truncated
/// in place.
fn write_secrets(app_data_dir: &Path, secrets: &HashMap<String, String>) -> Result<(), String> {
    if app_data_dir.as_os_str().is_empty() {
        return Err("no app data dir".to_string());
    }
    fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("cannot create the app data dir: {e}"))?;
    let body = serde_json::to_string_pretty(secrets).map_err(|e| e.to_string())?;
    let path = secrets_path(app_data_dir);
    let mut temp = tempfile::NamedTempFile::new_in(app_data_dir)
        .map_err(|e| format!("cannot create temporary file for {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot restrict {}: {e}", path.display()))?;
    }
    temp.write_all(body.as_bytes())
        .and_then(|_| temp.write_all(b"\n"))
        .and_then(|_| temp.flush())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    temp.persist(&path)
        .map_err(|e| format!("cannot replace {}: {}", path.display(), e.error))?;
    Ok(())
}

/// Stores one provider key. Unknown providers are rejected so arbitrary
/// entries can never turn into spawn env vars.
pub fn set_secret(app_data_dir: &Path, provider: &str, key: &str) -> Result<(), String> {
    let provider = provider.trim();
    let key = key.trim();
    if envs_for(provider).is_none() {
        return Err(format!("unknown pi cloud provider: {provider}"));
    }
    if key.is_empty() {
        return Err("empty key".to_string());
    }
    let mut secrets = read_secrets(app_data_dir)?;
    secrets.insert(provider.to_string(), key.to_string());
    write_secrets(app_data_dir, &secrets)?;
    log::info!("pi secret set for provider={provider}");
    Ok(())
}

/// Removes one provider key. Clearing an absent key stays a no-op success.
pub fn clear_secret(app_data_dir: &Path, provider: &str) -> Result<(), String> {
    let provider = provider.trim();
    if envs_for(provider).is_none() {
        return Err(format!("unknown pi cloud provider: {provider}"));
    }
    let mut secrets = read_secrets(app_data_dir)?;
    if secrets.remove(provider).is_none() {
        return Ok(());
    }
    write_secrets(app_data_dir, &secrets)?;
    log::info!("pi secret cleared for provider={provider}");
    Ok(())
}

/// Per-provider presence of the stored key, over every known cloud provider.
/// The value is "set" or "unset"; the key itself never leaves this module.
pub fn secret_status(app_data_dir: &Path) -> Result<HashMap<String, String>, String> {
    let stored = read_secrets(app_data_dir)?;
    Ok(PROVIDER_ENVS
        .iter()
        .map(|(id, _)| {
            let state = if stored.contains_key(*id) { "set" } else { "unset" };
            ((*id).to_string(), state.to_string())
        })
        .collect())
}

/// Whether each provider's env var is present (non-empty) in the app process.
/// The spawn inherits this env, so it answers "would the var reach pi even
/// with no stored key". Presence only; the value is never read out.
pub fn secret_env_status() -> HashMap<String, bool> {
    PROVIDER_ENVS
        .iter()
        .map(|(id, envs)| {
            let present = envs
                .iter()
                .any(|var| std::env::var(var).map(|v| !v.trim().is_empty()).unwrap_or(false));
            ((*id).to_string(), present)
        })
        .collect()
}

/// Fills every cloud env var the caller left unset from the stored keys, so
/// both spawn paths (checkout launcher, direct pi) hand the same keys to pi.
/// The caller's own env wins: an existing non-empty value is never replaced.
pub fn inject_secret_env(
    env: &mut HashMap<String, String>,
    app_data_dir: &Path,
) -> Result<(), String> {
    let secrets = read_secrets(app_data_dir)?;
    for (provider, key) in &secrets {
        let Some(envs) = envs_for(provider) else {
            continue;
        };
        for var in envs {
            let present = env
                .get(*var)
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            if !present {
                env.insert((*var).to_string(), key.clone());
            }
        }
    }
    Ok(())
}

/// One stored key by provider id, for backend callers that must render with
/// it (pi_prepare fills a blank oMLX key from here). The key stays in the
/// process: it is never logged and never returned to the frontend.
pub fn stored_key(app_data_dir: &Path, provider: &str) -> Result<Option<String>, String> {
    if envs_for(provider.trim()).is_none() {
        return Ok(None);
    }
    Ok(read_secrets(app_data_dir)?.remove(provider.trim()))
}

#[tauri::command]
pub fn pi_secret_set(app: tauri::AppHandle, provider: String, key: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    set_secret(&dir, &provider, &key)
}

#[tauri::command]
pub fn pi_secret_clear(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    clear_secret(&dir, &provider)
}

#[tauri::command]
pub fn pi_secret_status(
    app: tauri::AppHandle,
) -> Result<HashMap<String, String>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    secret_status(&dir)
}

/// Env-var presence per cloud provider, booleans only.
#[tauri::command]
pub fn pi_secret_env_status() -> Result<HashMap<String, bool>, String> {
    Ok(secret_env_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_status_reports_set_and_clear_reports_unset() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            secret_status(dir.path())
                .expect("status")
                .get("anthropic")
                .map(String::as_str),
            Some("unset")
        );
        set_secret(dir.path(), "anthropic", " sk-test ").expect("set");
        assert_eq!(
            secret_status(dir.path())
                .expect("status")
                .get("anthropic")
                .map(String::as_str),
            Some("set")
        );
        // The key is trimmed into the store and never returned.
        let raw =
            fs::read_to_string(secrets_path(dir.path())).expect("secrets file");
        assert_eq!(raw, "{\n  \"anthropic\": \"sk-test\"\n}\n");
        clear_secret(dir.path(), "anthropic").expect("clear");
        assert_eq!(
            secret_status(dir.path())
                .expect("status")
                .get("anthropic")
                .map(String::as_str),
            Some("unset")
        );
    }

    #[test]
    fn clearing_an_absent_key_is_a_no_op_success() {
        let dir = tempfile::tempdir().expect("tempdir");
        clear_secret(dir.path(), "openai").expect("clear absent");
    }

    #[test]
    fn unknown_providers_and_empty_keys_are_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = set_secret(dir.path(), "random-provider", "sk").expect_err("unknown");
        assert!(err.contains("unknown pi cloud provider"));
        let err = set_secret(dir.path(), "anthropic", "   ").expect_err("empty");
        assert_eq!(err, "empty key");
        assert!(!secrets_path(dir.path()).exists(), "no file written");
    }

    #[test]
    fn the_store_file_is_written_0600_on_unix() {
        let dir = tempfile::tempdir().expect("tempdir");
        set_secret(dir.path(), "openai", "sk-openai").expect("set");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(secrets_path(dir.path()))
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn a_rewrite_of_a_looser_file_tightens_the_mode_on_unix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = secrets_path(dir.path());
        fs::write(&path, "{}\n").expect("seed loose file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
                .expect("chmod loose");
            set_secret(dir.path(), "google", "sk-g").expect("set");
            let mode = fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn inject_fills_only_the_vars_the_caller_left_unset() {
        let dir = tempfile::tempdir().expect("tempdir");
        set_secret(dir.path(), "anthropic", "sk-a").expect("set anthropic");
        set_secret(dir.path(), "google", "sk-g").expect("set google");
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), "caller-key".to_string());
        inject_secret_env(&mut env, dir.path()).expect("inject");
        // The caller's own value wins where it is already set.
        assert_eq!(
            env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("caller-key")
        );
        // google maps onto both env vars pi reads.
        assert_eq!(env.get("GEMINI_API_KEY").map(String::as_str), Some("sk-g"));
        assert_eq!(
            env.get("GOOGLE_API_KEY").map(String::as_str),
            Some("sk-g")
        );
    }

    #[test]
    fn a_stored_omlx_key_fills_both_env_vars_and_stored_key_answers() {
        let dir = tempfile::tempdir().expect("tempdir");
        set_secret(dir.path(), "omlx", " sk-omlx ").expect("set omlx");
        let mut env = HashMap::new();
        inject_secret_env(&mut env, dir.path()).expect("inject");
        // One stored key lands on both vars the spawn and the render read.
        assert_eq!(env.get("OMLX_API_KEY").map(String::as_str), Some("sk-omlx"));
        assert_eq!(
            env.get("EFFICIENT_PI_OMLX_KEY").map(String::as_str),
            Some("sk-omlx")
        );
        // The caller's own EFFICIENT_PI_OMLX_KEY is never replaced.
        let mut env = HashMap::new();
        env.insert(
            "EFFICIENT_PI_OMLX_KEY".to_string(),
            "caller-host-key".to_string(),
        );
        inject_secret_env(&mut env, dir.path()).expect("inject");
        assert_eq!(
            env.get("EFFICIENT_PI_OMLX_KEY").map(String::as_str),
            Some("caller-host-key")
        );
        assert_eq!(
            env.get("OMLX_API_KEY").map(String::as_str),
            Some("sk-omlx")
        );
        // stored_key answers pi_prepare's blank-key fill and trims like the
        // store write; unknown providers stay None.
        assert_eq!(
            stored_key(dir.path(), "omlx")
                .expect("stored key")
                .as_deref(),
            Some("sk-omlx")
        );
        assert_eq!(stored_key(dir.path(), "bppc").expect("stored key"), None);
        assert_eq!(stored_key(dir.path(), "  ").expect("stored key"), None);
    }

    #[test]
    fn inject_without_a_store_or_dir_is_a_no_op() {
        let mut env = HashMap::new();
        inject_secret_env(&mut env, Path::new("/nonexistent/pi-secrets-test")).expect("inject");
        assert!(env.is_empty());
        inject_secret_env(&mut env, Path::new("")).expect("inject");
        assert!(env.is_empty());
    }

    #[test]
    fn unknown_or_non_string_provider_entries_are_ignored_at_inject() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(
            secrets_path(dir.path()),
            "{\"mystery\": \"sk-x\", \"anthropic\": 42, \"openrouter\": \"sk-r\"}",
        )
        .expect("write junk store");
        let mut env = HashMap::new();
        inject_secret_env(&mut env, dir.path()).expect("inject");
        // Only the known, string-valued provider lands in the env map.
        assert_eq!(env.len(), 1);
        assert_eq!(
            env.get("OPENROUTER_API_KEY").map(String::as_str),
            Some("sk-r")
        );
    }

    #[test]
    fn malformed_store_errors_with_the_file_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = secrets_path(dir.path());
        fs::write(&path, "not json").expect("write malformed store");
        let err = secret_status(dir.path()).expect_err("malformed store must fail");
        assert!(err.contains("pi-secrets.json"), "got: {err}");
        assert!(err.contains("invalid JSON"), "got: {err}");
        let mut env = HashMap::new();
        let err = inject_secret_env(&mut env, dir.path()).expect_err("malformed store");
        assert!(err.contains(&path.display().to_string()), "got: {err}");
        assert!(env.is_empty());
    }

    #[test]
    fn env_status_reports_presence_without_values() {
        let status = secret_env_status();
        // Every known provider is answered; this process sets none of them in
        // the test harness, so absence must not panic and must not leak values.
        for (id, _) in PROVIDER_ENVS {
            assert!(status.contains_key(*id));
        }
    }
}

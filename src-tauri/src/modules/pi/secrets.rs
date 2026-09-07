//! Cloud provider API keys for pi sessions, stored under the app data dir
//! (philosophy 8: keys live in the user's directories, never in a repo).
//! pi resolves provider credentials from env vars before the per-agent-dir
//! auth.json, so the spawn env carries these on every path and a cloud
//! orchestrator works the same in checkout and standalone mode without
//! touching either agent dir. Keys are never logged and never returned to
//! the frontend after set; pi_secret_status answers presence only.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;

/// Provider id -> the env vars pi reads for it (Rust twin of
/// PI_CLOUD_PROVIDERS in src/modules/pi/lib/providers.ts). google holds two:
/// pi's provider metadata lists GEMINI_API_KEY and GOOGLE_API_KEY.
const PROVIDER_ENVS: &[(&str, &[&str])] = &[
    ("anthropic", &["ANTHROPIC_API_KEY"]),
    ("openai", &["OPENAI_API_KEY"]),
    ("google", &["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
    ("openrouter", &["OPENROUTER_API_KEY"]),
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

/// Reads the stored keys. Unknown providers, non-string values and a missing
/// or malformed file all resolve to an empty map: one bad entry never blocks
/// a spawn, and a missing store means no key is injected.
fn read_secrets(app_data_dir: &Path) -> HashMap<String, String> {
    if app_data_dir.as_os_str().is_empty() {
        return HashMap::new();
    }
    let raw = match fs::read_to_string(secrets_path(app_data_dir)) {
        Ok(raw) => raw,
        Err(_) => return HashMap::new(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let Some(map) = parsed.as_object() else {
        return HashMap::new();
    };
    map.iter()
        .filter_map(|(provider, value)| {
            let key = value.as_str()?.trim().to_string();
            let key = (!key.is_empty()).then_some(key)?;
            envs_for(provider)?;
            Some((provider.clone(), key))
        })
        .collect()
}

/// Writes the whole store back. The file is created 0600 on Unix and kept
/// 0600 on rewrite (best effort elsewhere), and errors never quote the key.
fn write_secrets(app_data_dir: &Path, secrets: &HashMap<String, String>) -> Result<(), String> {
    if app_data_dir.as_os_str().is_empty() {
        return Err("no app data dir".to_string());
    }
    fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("cannot create the app data dir: {e}"))?;
    let body = serde_json::to_string_pretty(secrets).map_err(|e| e.to_string())?;
    let path = secrets_path(app_data_dir);
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("cannot write the pi secrets file: {e}"))?;
    file.write_all(body.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("cannot write the pi secrets file: {e}"))?;
    // A rewrite of an existing file keeps its old mode unless it is set again.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot restrict the pi secrets file: {e}"))?;
    }
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
    let mut secrets = read_secrets(app_data_dir);
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
    let mut secrets = read_secrets(app_data_dir);
    if secrets.remove(provider).is_none() {
        return Ok(());
    }
    write_secrets(app_data_dir, &secrets)?;
    log::info!("pi secret cleared for provider={provider}");
    Ok(())
}

/// Per-provider presence of the stored key, over every known cloud provider.
/// The value is "set" or "unset"; the key itself never leaves this module.
pub fn secret_status(app_data_dir: &Path) -> HashMap<String, String> {
    let stored = read_secrets(app_data_dir);
    PROVIDER_ENVS
        .iter()
        .map(|(id, _)| {
            let state = if stored.contains_key(*id) { "set" } else { "unset" };
            ((*id).to_string(), state.to_string())
        })
        .collect()
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
pub fn inject_secret_env(env: &mut HashMap<String, String>, app_data_dir: &Path) {
    let secrets = read_secrets(app_data_dir);
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
    Ok(secret_status(&dir))
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
            secret_status(dir.path()).get("anthropic").map(String::as_str),
            Some("unset")
        );
        set_secret(dir.path(), "anthropic", " sk-test ").expect("set");
        assert_eq!(
            secret_status(dir.path()).get("anthropic").map(String::as_str),
            Some("set")
        );
        // The key is trimmed into the store and never returned.
        let raw =
            fs::read_to_string(secrets_path(dir.path())).expect("secrets file");
        assert_eq!(raw, "{\n  \"anthropic\": \"sk-test\"\n}\n");
        clear_secret(dir.path(), "anthropic").expect("clear");
        assert_eq!(
            secret_status(dir.path()).get("anthropic").map(String::as_str),
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
        inject_secret_env(&mut env, dir.path());
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
    fn inject_without_a_store_or_dir_is_a_no_op() {
        let mut env = HashMap::new();
        inject_secret_env(&mut env, Path::new("/nonexistent/pi-secrets-test"));
        assert!(env.is_empty());
        inject_secret_env(&mut env, Path::new(""));
        assert!(env.is_empty());
    }

    #[test]
    fn a_malformed_or_unknown_provider_store_is_ignored_at_inject() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(
            secrets_path(dir.path()),
            "{\"mystery\": \"sk-x\", \"anthropic\": 42, \"openrouter\": \"sk-r\"}",
        )
        .expect("write junk store");
        let mut env = HashMap::new();
        inject_secret_env(&mut env, dir.path());
        // Only the known, string-valued provider lands in the env map.
        assert_eq!(env.len(), 1);
        assert_eq!(
            env.get("OPENROUTER_API_KEY").map(String::as_str),
            Some("sk-r")
        );
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

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::launch;

const API_KEY: &str = "api_key";
const OAUTH: &str = "oauth";
const NONE: &str = "none";

fn auth_path(agent_dir: &str) -> Result<PathBuf, String> {
    let dir = agent_dir.trim();
    if dir.is_empty() {
        return Err("pi agent dir is empty".to_string());
    }
    Ok(PathBuf::from(launch::expand_home(
        dir,
        launch::home_dir().as_deref(),
    ))
    .join("auth.json"))
}

fn read_auth_map(path: &Path) -> Result<Map<String, Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("invalid JSON in {}: {e}", path.display()))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("invalid auth object in {}: expected a JSON object", path.display()))
}

fn entry_kind(value: &Value) -> &'static str {
    let Some(entry) = value.as_object() else {
        return NONE;
    };
    if entry.get("type").and_then(Value::as_str) == Some(API_KEY)
        || entry.get("key").and_then(Value::as_str).is_some()
    {
        return API_KEY;
    }
    if entry.get("type").and_then(Value::as_str) == Some(OAUTH)
        || entry.get("access").and_then(Value::as_str).is_some()
    {
        return OAUTH;
    }
    NONE
}

fn status_map(entries: &Map<String, Value>) -> HashMap<String, String> {
    entries
        .iter()
        .map(|(provider, entry)| (provider.clone(), entry_kind(entry).to_string()))
        .collect()
}

fn write_auth_map(path: &Path, entries: &Map<String, Value>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("cannot determine parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create {} for {}: {e}", parent.display(), path.display()))?;
    let body = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("cannot serialize {}: {e}", path.display()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
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
    temp.persist(path)
        .map_err(|e| format!("cannot replace {}: {}", path.display(), e.error))?;
    Ok(())
}

#[tauri::command]
pub fn pi_auth_status(agent_dir: String) -> Result<HashMap<String, String>, String> {
    let path = auth_path(&agent_dir)?;
    Ok(status_map(&read_auth_map(&path)?))
}

#[tauri::command]
pub fn pi_auth_set(agent_dir: String, provider: String, key: String) -> Result<(), String> {
    let provider = provider.trim();
    let key = key.trim();
    if provider.is_empty() {
        return Err("provider is empty".to_string());
    }
    if key.is_empty() {
        return Err("empty key".to_string());
    }
    let path = auth_path(&agent_dir)?;
    let mut entries = read_auth_map(&path)?;
    entries.insert(
        provider.to_string(),
        serde_json::json!({ "type": API_KEY, "key": key }),
    );
    write_auth_map(&path, &entries)
}

#[tauri::command]
pub fn pi_auth_clear(agent_dir: String, provider: String) -> Result<(), String> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Err("provider is empty".to_string());
    }
    let path = auth_path(&agent_dir)?;
    let mut entries = read_auth_map(&path)?;
    if entries.remove(provider).is_some() {
        write_auth_map(&path, &entries)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_map_contains_kinds_without_credentials() {
        let entries = serde_json::from_str::<Value>(
            r#"{
                "openai": {"type":"api_key", "key":"sk-secret"},
                "github-copilot": {"type":"oauth", "access":"oauth-secret"},
                "broken": {"type":"other", "token":"hidden"}
            }"#,
        )
        .expect("json");
        let map = status_map(entries.as_object().expect("object"));
        assert_eq!(map.get("openai").map(String::as_str), Some(API_KEY));
        assert_eq!(map.get("github-copilot").map(String::as_str), Some(OAUTH));
        assert_eq!(map.get("broken").map(String::as_str), Some(NONE));
        let encoded = serde_json::to_string(&map).expect("status json");
        assert!(!encoded.contains("sk-secret"));
        assert!(!encoded.contains("oauth-secret"));
    }

    #[test]
    fn malformed_auth_json_names_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("auth.json");
        fs::write(&path, "not json").expect("write");
        let err = read_auth_map(&path).expect_err("malformed auth must fail");
        assert!(err.contains("auth.json"), "got: {err}");
        assert!(err.contains("invalid JSON"), "got: {err}");
    }

    #[test]
    fn auth_edits_preserve_other_entries_and_write_a_private_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        pi_auth_set(
            dir.path().to_string_lossy().into_owned(),
            "openai".to_string(),
            "sk-new".to_string(),
        )
        .expect("set");
        pi_auth_set(
            dir.path().to_string_lossy().into_owned(),
            "anthropic".to_string(),
            "sk-anthropic".to_string(),
        )
        .expect("set second");
        let statuses = pi_auth_status(dir.path().to_string_lossy().into_owned()).expect("status");
        assert_eq!(statuses.get("openai").map(String::as_str), Some(API_KEY));
        assert_eq!(statuses.get("anthropic").map(String::as_str), Some(API_KEY));
        pi_auth_clear(
            dir.path().to_string_lossy().into_owned(),
            "openai".to_string(),
        )
        .expect("clear");
        let statuses = pi_auth_status(dir.path().to_string_lossy().into_owned()).expect("status");
        assert!(!statuses.contains_key("openai"));
        assert_eq!(statuses.get("anthropic").map(String::as_str), Some(API_KEY));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join("auth.json"))
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}

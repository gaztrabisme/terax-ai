//! The session locator: `<project>/.pi/session-manifest.json`.
//!
//! pi reports the session id on its RPC events and writes the session file
//! under the project store (`--session-dir <project>/.pi/sessions`). This
//! module joins those two halves and records the exact result into the
//! locator file design.md section 3.4 row "Session locator" names:
//! `{v:1,lastSessionId,sessions:[{id,path,cwd,createdAt,lastTurnId}]}`.
//! `path` is exact and project-relative, so readers never infer the cwd
//! encoding. Writes go through the fs module's temp-and-rename writer; a
//! failed write logs and leaves the previous file untouched.

use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::sessions::candidate_dirs;
use crate::modules::fs::file::write_atomic;

/// Schema version of the locator file.
const MANIFEST_VERSION: u32 = 1;
static MANIFEST_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// One recorded session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSession {
    pub id: String,
    /// Exact project-relative path of the session file pi wrote.
    pub path: String,
    /// Absolute cwd the session ran in.
    pub cwd: String,
    /// RFC 3339 UTC: the session header's timestamp, else the record time.
    pub created_at: String,
    /// pi 0.3.0's RPC events carry a turn index, never a turn id; null
    /// stays unknown until an event names one.
    pub last_turn_id: Option<String>,
}

/// The locator file's shape. `lastSessionId` names the session the project
/// most recently ran.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionManifest {
    pub v: u32,
    pub last_session_id: Option<String>,
    pub sessions: Vec<ManifestSession>,
}

/// The locator file for a project root.
pub fn manifest_path(project_root: &Path) -> PathBuf {
    project_root.join(".pi").join("session-manifest.json")
}

/// RFC 3339 UTC for unix seconds plus milliseconds: the same shape pi's
/// header timestamps use, formatted without pulling in a time crate.
fn rfc3339_from_unix(secs: u64, millis: u32) -> String {
    let mut days = (secs / 86400) as i64;
    let leap = |year: i64| year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let year_days = |year: i64| if leap(year) { 366 } else { 365 };
    let mut year = 1970i64;
    while days >= year_days(year) {
        days -= year_days(year);
        year += 1;
    }
    let month_days = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1usize;
    while days >= month_days[month - 1] {
        days -= month_days[month - 1];
        month += 1;
    }
    format!(
        "{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        days + 1,
        secs % 86400 / 3600,
        secs % 3600 / 60,
        secs % 60,
    )
}

/// Now as RFC 3339 UTC, for sessions whose file carries no header timestamp.
fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    rfc3339_from_unix(now.as_secs(), now.subsec_millis())
}

/// The filename-safe session suffix pi writes (vendor pi_agent_rust
/// src/session.rs: the first 8 id chars, non-alphanumerics folded to `_`,
/// all-underscore folded to "session").
fn short_id(id: &str) -> String {
    let prefix: String = id
        .chars()
        .take(8)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if prefix.trim_matches('_').is_empty() {
        "session".to_string()
    } else {
        prefix
    }
}

/// True when a session file name names `id`: its stem's suffix after the
/// last underscore is pi's short id, or the full id itself (a future pi
/// writing whole ids must still match).
fn file_names_session(file_name: &str, id: &str) -> bool {
    let stem = file_name.strip_suffix(".jsonl").unwrap_or(file_name);
    match stem.rsplit_once('_') {
        Some((_, suffix)) => suffix == short_id(id) || suffix == id,
        None => false,
    }
}

/// The newest session file for `id` under the project's store: the encoded
/// cwd dir pi writes for the session's project first, then (an older pi or
/// a symlinked path) every directory under the store, as the sessions view
/// recovers. None when pi has not written the file yet.
fn resolve_session_file(project_root: &Path, cwd: &str, id: &str) -> Option<PathBuf> {
    let store = project_root.join(".pi").join("sessions");
    let mut best: Option<PathBuf> = None;
    for dir in candidate_dirs(&store, cwd) {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !file_names_session(name, id) {
                continue;
            }
            // UTC timestamps in pi's file names sort lexicographically, so
            // the greatest name is the newest session.
            let better = match &best {
                Some(prev) => match prev.file_name().and_then(|n| n.to_str()) {
                    Some(prev_name) => name > prev_name,
                    None => true,
                },
                None => true,
            };
            if better {
                best = Some(path);
            }
        }
    }
    best
}

/// The header line's RFC 3339 timestamp, for the session's createdAt.
fn header_timestamp(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    let v: serde_json::Value = serde_json::from_str(line.trim_end()).ok()?;
    v.get("timestamp")?.as_str().map(str::to_string)
}

/// Reads and validates the locator file; None when missing or malformed
/// (wrong version, wrong shape).
pub fn read_manifest(project_root: &Path) -> Option<SessionManifest> {
    let text = fs::read_to_string(manifest_path(project_root)).ok()?;
    let manifest: SessionManifest = serde_json::from_str(&text).ok()?;
    if manifest.v != MANIFEST_VERSION {
        return None;
    }
    Some(manifest)
}

/// Records one session: upserts `{id,path,cwd,createdAt,lastTurnId}` and
/// points `lastSessionId` at it, writing the locator through the fs
/// module's atomic writer. `path` must sit under `project_root`; it is
/// stored project-relative. An identical existing record writes nothing.
/// Errors name the intended path.
pub fn record_session(
    project_root: &Path,
    cwd: &str,
    id: &str,
    path: &Path,
) -> Result<(), String> {
    let _guard = MANIFEST_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let relative = path.strip_prefix(project_root).map_err(|_| {
        format!(
            "session file {} is not under project {}",
            path.display(),
            project_root.display()
        )
    })?;
    let entry = ManifestSession {
        id: id.to_string(),
        path: relative.to_string_lossy().into_owned(),
        cwd: cwd.to_string(),
        created_at: header_timestamp(path).unwrap_or_else(now_rfc3339),
        last_turn_id: None,
    };
    let mut manifest = match fs::read_to_string(manifest_path(project_root)) {
        Ok(text) => {
            let value: SessionManifest = serde_json::from_str(&text)
                .map_err(|e| format!("{}: {e}", manifest_path(project_root).display()))?;
            if value.v != MANIFEST_VERSION {
                return Err(format!("{}: unsupported manifest version", manifest_path(project_root).display()));
            }
            value
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SessionManifest {
            v: MANIFEST_VERSION, last_session_id: None, sessions: Vec::new(),
        },
        Err(e) => return Err(format!("{}: {e}", manifest_path(project_root).display())),
    };
    let mut changed = true;
    match manifest.sessions.iter_mut().find(|s| s.id == entry.id) {
        Some(existing) => {
            let was_last =
                manifest.last_session_id.as_deref() == Some(entry.id.as_str());
            let mut updated = entry.clone();
            updated.last_turn_id = existing.last_turn_id.clone();
            changed = *existing != updated || !was_last;
            let last_turn_id = existing.last_turn_id.clone();
            *existing = entry;
            existing.last_turn_id = last_turn_id;
        }
        None => manifest.sessions.push(entry),
    }
    manifest.last_session_id = Some(id.to_string());
    if !changed {
        return Ok(());
    }
    let text = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("cannot serialize session manifest: {e}"))?;
    write_atomic(&manifest_path(project_root), text.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", manifest_path(project_root).display()))
}

fn record_session_switch(project: &Path, id: &str, path: &Path) -> Result<(), String> {
    let project = fs::canonicalize(project).map_err(|e| e.to_string())?;
    let exact = fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !exact.starts_with(&project) {
        return Err(format!("{}: session file is outside project {}", path.display(), project.display()));
    }
    let file = fs::File::open(&exact).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut header = String::new();
    BufReader::new(file).read_line(&mut header).map_err(|e| format!("{}: {e}", path.display()))?;
    let header: serde_json::Value = serde_json::from_str(&header).map_err(|e| format!("{}: {e}", path.display()))?;
    if id.is_empty() || header.get("type").and_then(|v| v.as_str()) != Some("session")
        || header.get("id").and_then(|v| v.as_str()) != Some(id)
    {
        return Err(format!("{}: session header does not identify {id}", path.display()));
    }
    record_session(&project, &project.to_string_lossy(), id, &exact)
}

#[tauri::command]
pub fn pi_record_session_switch(
    registry: tauri::State<'_, crate::modules::workspace::WorkspaceRegistry>,
    workspace: Option<crate::modules::workspace::WorkspaceEnv>,
    cwd: String,
    session_id: String,
    path: String,
) -> Result<(), String> {
    use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv};
    let workspace = WorkspaceEnv::from_option(workspace);
    let project = authorize_user_spawn_cwd(&registry, Some(&cwd), &workspace)?
        .ok_or_else(|| "pi_record_session_switch needs a cwd".to_string())?;
    record_session_switch(&project, &session_id, Path::new(&path))
}

/// Event-pump hook: parses one pi stdout line, and when a turn-bearing
/// event names a session, resolves that session's file under the project
/// store and records it. `recorded` dedupes ids already recorded so the
/// scan runs at most until the first success per session. The file may not
/// exist yet when the first event lands (pi names it on first save), so a
/// failed resolution is not cached: a later event retries. Never fails the
/// event flow; problems log and drop.
pub fn note_session_event(project_cwd: &Path, line: &str, recorded: &Mutex<HashSet<String>>) {
    let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let kind = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if !matches!(kind, "agent_start" | "turn_start" | "turn_end") {
        return;
    }
    let Some(id) = event.get("sessionId").and_then(|s| s.as_str()) else {
        return;
    };
    let mut recorded = match recorded.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if recorded.contains(id) {
        return;
    }
    let cwd = project_cwd.to_string_lossy();
    let Some(path) = resolve_session_file(project_cwd, &cwd, id) else {
        return;
    };
    match record_session(project_cwd, &cwd, id, &path) {
        Ok(()) => {
            recorded.insert(id.to_string());
            log::info!("session manifest recorded id={id} path={}", path.display());
        }
        Err(e) => log::warn!("session manifest record failed: {e}"),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use super::super::sessions::encode_cwd;

    const ID: &str = "8b394965-ac25-4144-8d5e-87dc14d04ad6";
    const HEADER_TS: &str = "2026-09-06T13:25:00.834Z";
    const FILE_STEM: &str = "2026-09-06T13-25-00-834Z_8b394965";

    /// Writes a minimal session file in pi's shape: header line, one event.
    fn write_session_file(project: &Path, encoded_dir: &str, id: &str) -> PathBuf {
        let dir = project
            .join(".pi")
            .join("sessions")
            .join(encoded_dir);
        fs::create_dir_all(&dir).expect("mkdir store");
        let path = dir.join(format!("{FILE_STEM}.jsonl"));
        fs::write(
            &path,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"{HEADER_TS}\",\"cwd\":\"/p\"}}\n{{\"type\":\"agent_start\",\"sessionId\":\"{id}\"}}\n"
            ),
        )
        .expect("write session");
        path
    }

    #[test]
    fn switch_ack_needs_explicit_locator_and_keeps_exact_path() {
        let project = tempfile::tempdir().expect("project");
        let first = write_session_file(project.path(), "old", ID);
        let other = "aaaaaaaa-bbbb-4144-8d5e-87dc14d04ad6";
        let second = write_session_file(project.path(), "exact-non-inferred-dir", other);
        record_session_switch(project.path(), ID, &first).expect("first");
        note_session_event(project.path(), r#"{"type":"response","command":"switch_session","success":true}"#, &Mutex::new(HashSet::new()));
        assert_eq!(read_manifest(project.path()).unwrap().last_session_id.as_deref(), Some(ID));
        record_session_switch(project.path(), other, &second).expect("switch");
        let saved = read_manifest(project.path()).unwrap();
        assert_eq!(saved.last_session_id.as_deref(), Some(other));
        assert_eq!(saved.sessions.len(), 2);
        assert_eq!(saved.sessions[1].path, format!(".pi/sessions/exact-non-inferred-dir/{FILE_STEM}.jsonl"));
        let before = fs::read(manifest_path(project.path())).unwrap();
        assert!(record_session_switch(project.path(), ID, &second).is_err());
        assert_eq!(fs::read(manifest_path(project.path())).unwrap(), before);
    }

    #[test]
    fn switch_rejects_symlink_escape_and_preserves_corrupt_manifest() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = write_session_file(outside.path(), "outside", ID);
        let link = project.path().join("linked.jsonl");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(record_session_switch(project.path(), ID, &link).unwrap_err().contains("outside project"));
        let local = write_session_file(project.path(), "local", ID);
        fs::write(manifest_path(project.path()), "broken").unwrap();
        assert!(record_session_switch(project.path(), ID, &local).is_err());
        assert_eq!(fs::read_to_string(manifest_path(project.path())).unwrap(), "broken");
    }

    #[test]
    fn rfc3339_formats_known_instants() {
        assert_eq!(rfc3339_from_unix(0, 0), "1970-01-01T00:00:00.000Z");
        // 951782400 = 2000-02-29T00:00:00Z, a leap day.
        assert_eq!(rfc3339_from_unix(951_782_400, 500), "2000-02-29T00:00:00.500Z");
        // 1780931222 = 2026-06-08T15:07:02Z.
        assert_eq!(
            rfc3339_from_unix(1_780_931_222, 452),
            "2026-06-08T15:07:02.452Z"
        );
    }

    #[test]
    fn short_id_matches_pi_rule() {
        assert_eq!(short_id(ID), "8b394965");
        assert_eq!(short_id("ab"), "ab");
        assert_eq!(short_id("a/b/c/d/e/f/g/h"), "a_b_c_d_");
        assert_eq!(short_id("////////"), "session");
    }

    #[test]
    fn file_names_session_matches_short_and_full_id() {
        assert!(file_names_session(&format!("{FILE_STEM}.jsonl"), ID));
        assert!(file_names_session(
            "2026-09-06T13-25-00-834Z_8b394965-ac25-4144-8d5e-87dc14d04ad6.jsonl",
            ID
        ));
        assert!(!file_names_session("2026-09-06T13-25-00-834Z_deadbeef.jsonl", ID));
        assert!(!file_names_session("unrelated.jsonl", ID));
    }

    #[test]
    fn record_then_reread_roundtrips_the_locator() {
        let project = tempfile::tempdir().expect("tempdir");
        let encoded = encode_cwd(Path::new("/p"));
        let file = write_session_file(project.path(), &encoded, ID);
        record_session(project.path(), "/p", ID, &file).expect("record");
        let manifest = read_manifest(project.path()).expect("manifest");
        assert_eq!(manifest.v, 1);
        assert_eq!(manifest.last_session_id.as_deref(), Some(ID));
        assert_eq!(manifest.sessions.len(), 1);
        let session = &manifest.sessions[0];
        assert_eq!(session.id, ID);
        assert_eq!(
            session.path,
            format!(".pi/sessions/{encoded}/{FILE_STEM}.jsonl")
        );
        assert_eq!(session.cwd, "/p");
        assert_eq!(session.created_at, HEADER_TS);
        assert_eq!(session.last_turn_id, None);
        // The file on disk parses back identically.
        let raw = fs::read_to_string(manifest_path(project.path())).expect("read");
        let reparsed: SessionManifest = serde_json::from_str(&raw).expect("json");
        assert_eq!(reparsed, manifest);
    }

    #[test]
    fn record_upserts_and_moves_last_session_id() {
        let project = tempfile::tempdir().expect("tempdir");
        let encoded = encode_cwd(Path::new("/p"));
        let first = write_session_file(project.path(), &encoded, ID);
        let other = "aaaaaaaa-bbbb-4144-8d5e-87dc14d04ad6";
        let second = write_session_file(project.path(), &encoded, other);
        record_session(project.path(), "/p", ID, &first).expect("record first");
        record_session(project.path(), "/p", other, &second).expect("record second");
        let manifest = read_manifest(project.path()).expect("manifest");
        assert_eq!(manifest.last_session_id.as_deref(), Some(other));
        assert_eq!(manifest.sessions.len(), 2);
        // Re-recording the older session moves the pointer without adding
        // a duplicate row.
        let before = fs::read_to_string(manifest_path(project.path())).expect("read");
        record_session(project.path(), "/p", ID, &first).expect("re-record");
        let manifest = read_manifest(project.path()).expect("manifest");
        assert_eq!(manifest.last_session_id.as_deref(), Some(ID));
        assert_eq!(manifest.sessions.len(), 2);
        let after = fs::read_to_string(manifest_path(project.path())).expect("read");
        assert_ne!(before, after, "lastSessionId moved on disk");
        assert!(after.contains(&format!("\"lastSessionId\": \"{ID}\"")));
        // Recording the same session again is a no-op: identical record,
        // already last, nothing to write.
        let before = after;
        record_session(project.path(), "/p", ID, &first).expect("same record");
        let after = fs::read_to_string(manifest_path(project.path())).expect("read");
        assert_eq!(before, after, "identical record writes nothing");
    }

    #[test]
    fn record_rejects_paths_outside_the_project() {
        let project = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("tempdir");
        let file = outside.path().join("session.jsonl");
        fs::write(&file, "{}").expect("write");
        let err =
            record_session(project.path(), "/p", ID, &file).expect_err("must reject");
        assert!(err.contains("not under project"), "{err}");
        assert!(read_manifest(project.path()).is_none(), "nothing written");
    }

    #[test]
    fn read_manifest_returns_none_for_missing_or_wrong_version() {
        let project = tempfile::tempdir().expect("tempdir");
        assert!(read_manifest(project.path()).is_none(), "missing file");
        fs::create_dir_all(project.path().join(".pi")).expect("mkdir");
        fs::write(
            manifest_path(project.path()),
            "{\"v\":2,\"lastSessionId\":null,\"sessions\":[]}",
        )
        .expect("write manifest");
        assert!(read_manifest(project.path()).is_none(), "wrong version");
        fs::write(manifest_path(project.path()), "not json").expect("write junk");
        assert!(read_manifest(project.path()).is_none(), "malformed");
    }

    #[test]
    fn note_session_event_records_from_agent_start_and_dedupes() {
        let project = tempfile::tempdir().expect("tempdir");
        let encoded = encode_cwd(Path::new("/p"));
        let file = write_session_file(project.path(), &encoded, ID);
        let recorded = Mutex::new(HashSet::new());
        let line = format!("{{\"type\":\"agent_start\",\"sessionId\":\"{ID}\"}}");
        note_session_event(project.path(), &line, &recorded);
        assert!(recorded.lock().expect("lock").contains(ID), "recorded");
        let manifest = read_manifest(project.path()).expect("manifest");
        assert_eq!(manifest.sessions.len(), 1);
        assert_eq!(
            manifest.sessions[0].path,
            file.strip_prefix(project.path())
                .expect("under project")
                .to_string_lossy()
        );
        // A second event for the same session does no work and adds no row.
        note_session_event(project.path(), &line, &recorded);
        assert_eq!(read_manifest(project.path()).expect("manifest"), manifest);
    }

    #[test]
    fn note_session_event_ignores_non_session_lines_and_unknown_ids() {
        let project = tempfile::tempdir().expect("tempdir");
        let recorded = Mutex::new(HashSet::new());
        for line in [
            "not json",
            "{\"type\":\"stderr\",\"line\":\"boom\"}",
            "{\"type\":\"agent_start\"}",
            "{\"type\":\"agent_start\",\"sessionId\":\"deadbeef-0000\"}",
            "{\"type\":\"message_end\",\"sessionId\":\"deadbeef-0000\"}",
        ] {
            note_session_event(project.path(), line, &recorded);
        }
        assert!(read_manifest(project.path()).is_none(), "nothing recorded");
    }

    #[test]
    fn note_session_event_retries_until_the_file_exists() {
        let project = tempfile::tempdir().expect("tempdir");
        let recorded = Mutex::new(HashSet::new());
        let line = format!("{{\"type\":\"agent_start\",\"sessionId\":\"{ID}\"}}");
        // pi names the session file on first save, after the first event.
        note_session_event(project.path(), &line, &recorded);
        assert!(read_manifest(project.path()).is_none(), "not yet");
        write_session_file(project.path(), &encode_cwd(Path::new("/p")), ID);
        note_session_event(project.path(), &line, &recorded);
        assert!(read_manifest(project.path()).is_some(), "recorded on retry");
    }
}

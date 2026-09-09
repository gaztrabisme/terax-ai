use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::Watcher;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use super::workspace::WorkspaceRegistry;

const CAP: usize = 262_144;
const REFRESH_CAP: u64 = CAP as u64;
const SCHEMA: &str = include_str!("../../../uat/schema/snapshot.json");

fn schema() -> &'static Value {
    static SCHEMA_VALUE: OnceLock<Value> = OnceLock::new();
    SCHEMA_VALUE.get_or_init(|| serde_json::from_str(SCHEMA).expect("embedded UAT schema"))
}

pub fn launch_uat_from_args<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == "--uat")
}

fn days_before_year(year: i64) -> i64 {
    let y = year - 1;
    365 * y + y / 4 - y / 100 + y / 400
}

fn month_days(year: i64, month: usize) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn utc_time(text: &str) -> Option<i128> {
    let text = text
        .strip_suffix('Z')
        .or_else(|| text.strip_suffix("+00:00"))?;
    if !text.is_ascii() || text.len() < 19 {
        return None;
    }
    if &text[4..5] != "-"
        || &text[7..8] != "-"
        || &text[10..11] != "T"
        || &text[13..14] != ":"
        || &text[16..17] != ":"
    {
        return None;
    }
    if [(0, 4), (5, 7), (8, 10), (11, 13), (14, 16), (17, 19)]
        .iter()
        .any(|(a, b)| !text[*a..*b].bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let number = |a: usize, b: usize| text[a..b].parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)? as usize, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if year < 1
        || !(1..=12).contains(&month)
        || !(1..=month_days(year, month)).contains(&day)
        || !(0..24).contains(&hour)
        || !(0..60).contains(&minute)
        || !(0..60).contains(&second)
    {
        return None;
    }
    let mut nanos = 0;
    if text.len() > 19 {
        let fraction = text[19..].strip_prefix('.')?;
        if fraction.is_empty()
            || fraction.len() > 9
            || !fraction.bytes().all(|c| c.is_ascii_digit())
        {
            return None;
        }
        nanos = fraction.parse::<i128>().ok()? * 10_i128.pow(9 - fraction.len() as u32);
    }
    let days = days_before_year(year) - days_before_year(1970)
        + (1..month).map(|m| month_days(year, m)).sum::<i64>()
        + day
        - 1;
    Some(i128::from(days * 86400 + hour * 3600 + minute * 60 + second) * 1_000_000_000 + nanos)
}

fn now() -> String {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = time.as_secs();
    let mut days = (seconds / 86400) as i64;
    let mut year = 1970;
    while days >= days_before_year(year + 1) - days_before_year(year) {
        days -= days_before_year(year + 1) - days_before_year(year);
        year += 1;
    }
    let mut month = 1;
    while days >= month_days(year, month) {
        days -= month_days(year, month);
        month += 1;
    }
    format!(
        "{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        days + 1,
        seconds % 86400 / 3600,
        seconds % 3600 / 60,
        seconds % 60,
        time.subsec_millis()
    )
}

fn matches_type(value: &Value, kind: &str) -> bool {
    match kind {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "string" => value.is_string(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "integer" => value
            .as_f64()
            .is_some_and(|n| n.is_finite() && n.fract() == 0.0),
        _ => false,
    }
}

fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same_value(value, other)))
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_value(a, b))
        }
        _ => a == b,
    }
}

fn validate_schema(value: &Value, rule: &Value, root: &Value) -> Result<(), String> {
    let fail = || "SCHEMA_INVALID: snapshot does not satisfy section 5.3".to_string();
    if let Some(reference) = rule["$ref"].as_str() {
        return validate_schema(
            value,
            root.pointer(reference.trim_start_matches('#'))
                .ok_or_else(fail)?,
            root,
        );
    }
    if rule.get("const").is_some_and(|c| c != value)
        || rule["enum"]
            .as_array()
            .is_some_and(|items| !items.contains(value))
    {
        return Err(fail());
    }
    if let Some(choices) = rule["oneOf"].as_array() {
        if choices
            .iter()
            .filter(|r| validate_schema(value, r, root).is_ok())
            .count()
            != 1
        {
            return Err(fail());
        }
    }
    if let Some(kind) = rule.get("type") {
        let valid = if let Some(kind) = kind.as_str() {
            matches_type(value, kind)
        } else {
            kind.as_array().is_some_and(|kinds| {
                kinds
                    .iter()
                    .any(|k| matches_type(value, k.as_str().unwrap_or("")))
            })
        };
        if !valid {
            return Err(fail());
        }
    }
    if let Some(object) = value.as_object() {
        if rule["required"].as_array().is_some_and(|names| {
            names
                .iter()
                .any(|name| !object.contains_key(name.as_str().unwrap_or("")))
        }) {
            return Err(fail());
        }
        for (key, child) in object {
            if let Some(child_rule) = rule["properties"].get(key) {
                validate_schema(child, child_rule, root)?;
            } else if rule["additionalProperties"] == false {
                return Err(fail());
            }
        }
    }
    if let Some(array) = value.as_array() {
        let mut seen = HashSet::new();
        for item in array {
            if rule["uniqueItems"] == true && !seen.insert(item.to_string()) {
                return Err(fail());
            }
            if let Some(item_rule) = rule.get("items") {
                validate_schema(item, item_rule, root)?;
            }
        }
    }
    if let Some(text) = value.as_str() {
        let len = text.chars().count() as u64;
        if rule["minLength"].as_u64().is_some_and(|min| len < min)
            || rule["maxLength"].as_u64().is_some_and(|max| len > max)
            || (rule["format"] == "date-time" && utc_time(text).is_none())
        {
            return Err(fail());
        }
        if let Some(pattern) = rule["pattern"].as_str() {
            let valid = match pattern {
                "^[0-9a-f]{64}$" => {
                    text.len() == 64
                        && text
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                }
                "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" => {
                    text.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                        && text.split('-').all(|part| {
                            !part.is_empty()
                                && part
                                    .bytes()
                                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                        })
                }
                _ => false,
            };
            if !valid {
                return Err(fail());
            }
        }
    }
    if let Some(n) = value.as_f64() {
        if !n.is_finite()
            || rule["minimum"].as_f64().is_some_and(|min| n < min)
            || rule["exclusiveMinimum"]
                .as_f64()
                .is_some_and(|min| n <= min)
        {
            return Err(fail());
        }
    }
    Ok(())
}

fn project_path(root: &Path, text: &str) -> Result<PathBuf, String> {
    let path = Path::new(text);
    if text.is_empty()
        || text.contains('\\')
        || text.contains(':')
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("PATH_INVALID: expected a project-relative path".into());
    }
    let target = root.join(path);
    let mut existing = target.as_path();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent().ok_or("PATH_INVALID")?;
            }
            Err(_) => return Err("PATH_INVALID: cannot inspect path".into()),
        }
    }
    if !fs::canonicalize(existing)
        .map_err(|_| "PATH_INVALID: cannot resolve path")?
        .starts_with(root)
    {
        return Err("PATH_INVALID: path escapes project".into());
    }
    Ok(target)
}

fn qualified(element: &Value) -> String {
    format!(
        "{}@{} scope={} key={}",
        element["uat"].as_str().unwrap_or(""),
        element["index"],
        element["scope"].as_str().unwrap_or(""),
        element["key"].as_str().unwrap_or("")
    )
}

fn duplicate_targets(elements: &[Value]) -> BTreeSet<String> {
    let mut tuples = HashMap::new();
    let mut keys = HashMap::new();
    let mut duplicates = BTreeSet::new();
    for element in elements {
        let address = (
            element["uat"].to_string(),
            element["scope"].to_string(),
            element["index"].to_string(),
        );
        let identity = (element["scope"].to_string(), element["key"].to_string());
        let target = qualified(element);
        for previous in [
            tuples.insert(address, target.clone()),
            keys.insert(identity, target.clone()),
        ]
        .into_iter()
        .flatten()
        {
            duplicates.insert(previous);
            duplicates.insert(target.clone());
        }
    }
    duplicates
}

fn validate_snapshot(raw: &str, root: &Path) -> Result<Value, String> {
    if raw.len() > CAP {
        return Err("SNAPSHOT_TOO_LARGE: limit is 262144 bytes".into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "SCHEMA_INVALID: invalid JSON")?;
    validate_schema(&value, schema(), schema())?;
    let tabs = value["tabs"].as_array().ok_or("SCHEMA_INVALID")?;
    let active: Vec<_> = tabs.iter().filter(|t| t["active"] == true).collect();
    if active.len() != 1
        || active[0] != &value["activeTab"]
        || tabs
            .iter()
            .map(|t| t["key"].as_str())
            .collect::<HashSet<_>>()
            .len()
            != tabs.len()
    {
        return Err("TAB_INVALID: expected one matching active tab".into());
    }
    if utc_time(value["capturedAt"].as_str().unwrap_or(""))
        > utc_time(value["ts"].as_str().unwrap_or(""))
    {
        return Err("TIME_INVALID: capturedAt is after ts".into());
    }
    let elements = value["elements"].as_array().ok_or("SCHEMA_INVALID")?;
    let duplicates = duplicate_targets(elements);
    let reported: BTreeSet<_> = value["dupes"]
        .as_array()
        .ok_or("SCHEMA_INVALID")?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    if duplicates != reported || (!duplicates.is_empty() && value["health"] != "error") {
        return Err(
            "DUPES_INVALID: duplicate identities must be reported with error health".into(),
        );
    }
    if (value["health"] == "ok") != value["lastError"].is_null() {
        return Err("HEALTH_INVALID: health and lastError disagree".into());
    }
    for element in elements {
        if element["secret"] == true {
            continue;
        }
        let hidden = element["hidden"] == true;
        let summary = element["summary"] == true;
        let interactable = element["interactable"] == true;
        if (hidden || summary)
            && (!element["rect"].is_null() || !element["hitRect"].is_null() || interactable)
            || (!hidden && !summary && element["rect"].is_null())
            || summary
                && (!hidden
                    || element["role"] != "pane"
                    || element.get("text").is_some()
                    || element["label"] != "")
        {
            return Err("GEOMETRY_INVALID: hidden summaries have no content or rectangles".into());
        }
        if summary
            && element["props"].as_object().is_some_and(|props| {
                props.keys().any(|key| {
                    !["kind", "count", "runningCount", "doneCount"].contains(&key.as_str())
                })
            })
        {
            return Err("SUMMARY_INVALID: hidden tabs expose only kind and counts".into());
        }
        if element.get("text").is_some()
            && ![
                "session-status",
                "turn-tokens",
                "session-cost",
                "usage-footer",
                "terminal-exit-ok",
                "terminal-exit-failed",
                "cache-qualifier",
                "uat-health",
            ]
            .contains(&element["uat"].as_str().unwrap_or(""))
        {
            return Err("TEXT_INVALID: only structural and status text is allowed".into());
        }
        if let Some(hit) = element["hitRect"].as_object() {
            let rect = &element["rect"];
            let n = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
            let (x, y, w, h) = (n(&hit["x"]), n(&hit["y"]), n(&hit["w"]), n(&hit["h"]));
            if w <= 0.0
                || h <= 0.0
                || x < 0.0
                || y < 0.0
                || x + w > n(&value["viewport"]["w"]) + 0.01
                || y + h > n(&value["viewport"]["h"]) + 0.01
                || x < n(&rect["x"]) - 0.01
                || y < n(&rect["y"]) - 0.01
                || x + w > n(&rect["x"]) + n(&rect["w"]) + 0.01
                || y + h > n(&rect["y"]) + n(&rect["h"]) + 0.01
            {
                return Err("GEOMETRY_INVALID: hitRect is not clipped to rect and viewport".into());
            }
        }
        if interactable
            && (element["enabled"] != true
                || element["hitRect"].is_null()
                || value["health"] != "ok"
                || !duplicates.is_empty())
        {
            return Err("GEOMETRY_INVALID: unsafe interactable target".into());
        }
        if let Some(path) = element["props"]["path"].as_str() {
            project_path(root, path)?;
        }
    }
    Ok(value)
}

fn private_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    let path = project_path(root, name)?;
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err("PATH_INVALID: runtime directory is not a real directory".into())
        }
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(&path)
                .map_err(|e| format!("WRITE_FAILED: {}: {e}", path.display()))?;
        }
        Err(e) => return Err(format!("WRITE_FAILED: {}: {e}", path.display())),
    }
    Ok(path)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err("PATH_INVALID: runtime file is not a regular file".into());
    }
    let parent = path.parent().ok_or("PATH_INVALID")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("WRITE_FAILED: {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    restrict_windows_file(temp.path())?;
    temp.write_all(bytes)
        .and_then(|_| temp.flush())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| format!("WRITE_FAILED: {}: {e}", path.display()))?;
    temp.persist(path)
        .map_err(|e| format!("WRITE_FAILED: {}: {}", path.display(), e.error))?;
    Ok(())
}

#[cfg(windows)]
fn restrict_windows_file(path: &Path) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn SetFileSecurityW(path: *const u16, information: u32, descriptor: *const c_void) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)\0".encode_utf16().collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err("WRITE_FAILED: cannot create user-only file permissions".into());
        }
        let result = SetFileSecurityW(path.as_ptr(), 0x8000_0004, descriptor);
        LocalFree(descriptor);
        if result == 0 {
            return Err("WRITE_FAILED: cannot restrict UAT file permissions".into());
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UatError {
    code: String,
    message: String,
    at: String,
    consecutive_failures: u64,
    log_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RefreshRequest {
    v: u8,
    run_id: String,
    window_id: String,
    nonce: String,
    after_seq: u64,
    requested_at: String,
}

#[derive(Default)]
struct WindowState {
    root: Option<PathBuf>,
    seq: u64,
    layout_seq: u64,
    generation: u64,
    sample: Option<Value>,
    failures: u64,
    error: Option<UatError>,
    seen_nonces: HashSet<String>,
    requests: VecDeque<RefreshRequest>,
    acknowledged: Option<RefreshRequest>,
    stop: Option<Arc<AtomicBool>>,
}

#[derive(Default)]
struct Inner {
    windows: HashMap<String, WindowState>,
}

pub struct UatState {
    pub enabled: bool,
    run_id: String,
    inner: Mutex<Inner>,
}

impl UatState {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            run_id: format!(
                "{:x}-{:x}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            inner: Mutex::new(Inner::default()),
        }
    }

    fn guard(&self) -> Result<(), String> {
        if self.enabled {
            Ok(())
        } else {
            Err("UAT_DISABLED: launch with --uat".into())
        }
    }

    fn start(
        &self,
        window_id: &str,
        cwd: &str,
        registry: &WorkspaceRegistry,
    ) -> Result<Value, String> {
        self.guard()?;
        let root =
            fs::canonicalize(cwd).map_err(|_| "PROJECT_UNAUTHORIZED: project is not accessible")?;
        if !root.is_dir() || !registry.is_authorized(&root) {
            return Err("PROJECT_UNAUTHORIZED: project is not authorized".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "UAT_STATE_UNAVAILABLE")?;
        if inner
            .windows
            .iter()
            .any(|(id, state)| id != window_id && state.root.as_ref() == Some(&root))
        {
            return Err("WINDOW_BUSY: another window owns this project snapshot".into());
        }
        let state = inner.windows.entry(window_id.into()).or_default();
        if let Some(stop) = state.stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        state.root = Some(root.clone());
        state.requests.clear();
        state.acknowledged = None;
        state.sample = None;
        Ok(
            json!({"runId": self.run_id, "windowId": window_id, "cwd": super::fs::to_canon(&root), "seq": state.seq, "layoutSeq": state.layout_seq}),
        )
    }

    fn stop(&self, window_id: &str) -> Result<(), String> {
        self.guard()?;
        let mut inner = self.inner.lock().map_err(|_| "UAT_STATE_UNAVAILABLE")?;
        if let Some(state) = inner.windows.get_mut(window_id) {
            if let Some(stop) = state.stop.take() {
                stop.store(true, Ordering::Relaxed);
            }
            state.root = None;
            state.sample = None;
            state.requests.clear();
            state.acknowledged = None;
        }
        Ok(())
    }

    fn failure(&self, window_id: &str, code: &str, message: &str) -> Result<UatError, String> {
        self.guard()?;
        let mut inner = self.inner.lock().map_err(|_| "UAT_STATE_UNAVAILABLE")?;
        let state = inner.windows.get_mut(window_id).ok_or("WINDOW_UNKNOWN")?;
        state.failures += 1;
        let error = UatError {
            code: code.into(),
            message: message.chars().take(200).collect(),
            at: now(),
            consecutive_failures: state.failures,
            log_path: Some(".pi/logs/uat.jsonl".into()),
        };
        state.error = Some(error.clone());
        if let Some(root) = &state.root {
            eprintln!(
                "UAT snapshot unavailable: {}. Evidence: {}, {}",
                error.message,
                root.join(".pi/uat-status.json").display(),
                root.join(".pi/logs/uat.jsonl").display()
            );
            let status = json!({"v": 1, "runId": self.run_id, "windowId": window_id, "health": "error", "lastError": error, "ts": now()});
            let written = (|| {
                let pi = private_dir(root, ".pi")?;
                atomic_write(&pi.join("uat-status.json"), status.to_string().as_bytes())?;
                append_uat_log(root, &status)
            })();
            if let Err(error) = written {
                eprintln!("UAT health evidence unavailable: {error}");
            }
        }
        Ok(error)
    }

    fn accept_refresh(
        &self,
        window_id: &str,
        bytes: &[u8],
        source: Option<&Path>,
    ) -> Result<RefreshRequest, String> {
        self.guard()?;
        if bytes.len() > REFRESH_CAP as usize {
            return Err("REFRESH_INVALID: request too large".into());
        }
        let request: RefreshRequest =
            serde_json::from_slice(bytes).map_err(|_| "REFRESH_INVALID: invalid request schema")?;
        if request.v != 1
            || request.run_id.is_empty()
            || request.window_id.is_empty()
            || request.nonce.is_empty()
            || utc_time(&request.requested_at).is_none()
        {
            return Err("REFRESH_INVALID: invalid request fields".into());
        }
        if request.run_id != self.run_id {
            return Err("RUN_MISMATCH: refresh is for another run".into());
        }
        if request.window_id != window_id {
            return Err("WINDOW_UNKNOWN: refresh is for another window".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "UAT_STATE_UNAVAILABLE")?;
        let state = inner
            .windows
            .get_mut(window_id)
            .filter(|s| s.root.is_some())
            .ok_or("WINDOW_UNKNOWN")?;
        if source.is_some_and(|root| state.root.as_deref() != Some(root)) {
            return Err("PROJECT_CHANGED: refresh watcher no longer owns this project".into());
        }
        if request.after_seq > state.seq {
            return Err("FUTURE_SEQUENCE: afterSeq has not been committed".into());
        }
        if !state.seen_nonces.insert(request.nonce.clone()) {
            return Err("NONCE_REUSED: refresh nonce was already used".into());
        }
        state.requests.push_back(request.clone());
        if let Some(root) = state.root.as_deref() {
            append_uat_log(
                root,
                &json!({"time": now(), "event": "refresh", "nonce": request.nonce, "seq": state.seq}),
            )
            .unwrap_or_else(|error| eprintln!("UAT refresh log unavailable: {error}"));
        }
        Ok(request)
    }

    fn write(
        &self,
        window_id: &str,
        raw: &str,
        registry: &WorkspaceRegistry,
    ) -> Result<Value, String> {
        self.guard()?;
        let mut inner = self.inner.lock().map_err(|_| "UAT_STATE_UNAVAILABLE")?;
        let state = inner.windows.get_mut(window_id).ok_or("WINDOW_UNKNOWN")?;
        let root = state.root.as_ref().ok_or("PROJECT_UNAUTHORIZED")?;
        if !registry.is_authorized(root) || fs::canonicalize(root).ok().as_ref() != Some(root) {
            return Err("PROJECT_UNAUTHORIZED".into());
        }
        let mut snapshot = validate_snapshot(raw, root)?;
        if snapshot["runId"] != self.run_id
            || snapshot["windowId"] != window_id
            || snapshot["cwd"] != super::fs::to_canon(root)
        {
            return Err(
                "IDENTITY_MISMATCH: snapshot does not belong to the active project/window/run"
                    .into(),
            );
        }
        let seq = snapshot["seq"].as_u64().ok_or("SEQUENCE_INVALID")?;
        let layout_seq = snapshot["layoutSeq"].as_u64().ok_or("SEQUENCE_INVALID")?;
        if seq != state.seq + 1 || layout_seq < state.layout_seq {
            return Err("SEQUENCE_INVALID: sequences must increase".into());
        }
        if !state
            .sample
            .as_ref()
            .is_some_and(|sample| same_value(sample, &snapshot["window"]))
        {
            return Err("GEOMETRY_CHANGED: native geometry must be recaptured".into());
        }
        let nonce = snapshot["refreshNonce"].as_str().map(str::to_string);
        if let Some(nonce) = &nonce {
            if !state
                .requests
                .front()
                .into_iter()
                .chain(state.acknowledged.as_ref())
                .any(|r| &r.nonce == nonce && seq > r.after_seq)
            {
                return Err(
                    "NONCE_INVALID: snapshot does not acknowledge the pending refresh".into(),
                );
            }
        }
        snapshot["ts"] = json!(now());
        if utc_time(snapshot["capturedAt"].as_str().unwrap_or(""))
            > utc_time(snapshot["ts"].as_str().unwrap_or(""))
        {
            return Err("TIME_INVALID: capture is in the future".into());
        }
        let pi = private_dir(root, ".pi")?;
        let status = json!({"v": 1, "runId": self.run_id, "windowId": window_id, "health": snapshot["health"], "lastError": snapshot["lastError"], "ts": snapshot["ts"]});
        atomic_write(&pi.join("uat-status.json"), status.to_string().as_bytes())?;
        let bytes = snapshot.to_string();
        if bytes.len() > CAP {
            return Err("SNAPSHOT_TOO_LARGE: limit is 262144 bytes".into());
        }
        atomic_write(&pi.join("uat-snapshot.json"), bytes.as_bytes())?;
        state.seq = seq;
        state.layout_seq = layout_seq;
        state.sample = None;
        if state
            .requests
            .front()
            .is_some_and(|r| Some(r.nonce.as_str()) == nonce.as_deref())
        {
            state.acknowledged = state.requests.pop_front();
            if let Some(ack) = state.acknowledged.as_ref() {
                if let Some(root) = state.root.as_deref() {
                    append_uat_log(
                        root,
                        &json!({"time": now(), "event": "ack", "nonce": ack.nonce, "seq": seq}),
                    )
                    .unwrap_or_else(|error| eprintln!("UAT ack log unavailable: {error}"));
                }
            }
        }
        if snapshot["health"] == "ok" {
            state.failures = 0;
            state.error = None;
        }
        Ok(json!({"seq": seq, "ts": snapshot["ts"]}))
    }
}

fn append_uat_log(root: &Path, event: &Value) -> Result<(), String> {
    private_dir(root, ".pi")?;
    let logs = private_dir(root, ".pi/logs")?;
    let path = logs.join("uat.jsonl");
    let mut bytes = match read_bounded(root, ".pi/logs/uat.jsonl", 1_048_576) {
        Ok(Some(bytes)) => bytes,
        _ => Vec::new(),
    };
    bytes.extend(event.to_string().bytes());
    bytes.push(b'\n');
    atomic_write(&path, &bytes)
}

fn read_bounded(root: &Path, name: &str, cap: u64) -> Result<Option<Vec<u8>>, String> {
    let path = project_path(root, name)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("READ_FAILED: cannot inspect UAT file".into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("PATH_INVALID: UAT file is not a regular file".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "READ_FAILED: cannot read UAT file")?;
    let mut bytes = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "READ_FAILED: cannot read UAT file")?;
    if bytes.len() > cap as usize {
        return Err("READ_FAILED: UAT file exceeds size limit".into());
    }
    Ok(Some(bytes))
}

fn report(window: &tauri::WebviewWindow, state: &UatState, error: &str) {
    let code = error.split(':').next().unwrap_or("COLLECTOR_FAILED");
    if let Ok(error) = state.failure(window.label(), code, error) {
        let _ = window.emit("uat:health", error);
    }
}

fn watch_refresh(window: tauri::WebviewWindow, root: PathBuf, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let notifications = tx.clone();
        let _poll_sender = tx;
        let watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                if event.is_ok_and(|e| {
                    e.paths
                        .iter()
                        .any(|p| p.file_name().is_some_and(|n| n == "uat-refresh.json"))
                }) {
                    let _ = notifications.try_send(());
                }
            });
        let mut watcher = watcher.ok();
        if let Some(watcher) = &mut watcher {
            let _ = watcher.watch(&root, notify::RecursiveMode::NonRecursive);
        }
        let mut watched_pi = false;
        let mut stamp = None;
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            if !watched_pi {
                if let Some(watcher) = &mut watcher {
                    watched_pi = watcher
                        .watch(&root.join(".pi"), notify::RecursiveMode::NonRecursive)
                        .is_ok();
                }
            }
            let state = window.state::<UatState>();
            let path = root.join(".pi/uat-refresh.json");
            let next_stamp = fs::symlink_metadata(&path)
                .ok()
                .map(|m| (m.modified().ok(), m.len(), m.created().ok()));
            if next_stamp != stamp {
                stamp = next_stamp;
                let result =
                    read_bounded(&root, ".pi/uat-refresh.json", REFRESH_CAP).and_then(|bytes| {
                        match bytes {
                            Some(bytes) => state
                                .accept_refresh(window.label(), &bytes, Some(&root))
                                .map(Some),
                            None => Ok(None),
                        }
                    });
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match result {
                    Ok(Some(request)) => {
                        let _ = window.emit("uat:refresh", request);
                    }
                    Ok(None) => (),
                    Err(error) => report(&window, &state, &error),
                }
            }
            let _ = rx.recv_timeout(Duration::from_millis(100));
        }
    });
}

fn mapped_origin(
    physical: (f64, f64),
    display_physical: (f64, f64),
    display_driver: (f64, f64),
    scale: f64,
) -> Value {
    json!({"x": display_driver.0 + (physical.0 - display_physical.0) / scale,
        "y": display_driver.1 + (physical.1 - display_physical.1) / scale})
}

fn native_window(
    window: &tauri::WebviewWindow,
    viewport_width: f64,
    viewport_height: f64,
) -> Value {
    let mut result = json!({"x": 0, "y": 0, "w": 1, "h": 1, "scale": 1, "cssToPoint": 1,
        "driverUnits": if cfg!(target_os = "macos") { "macos-points" } else { "logical-pixels" },
        "driverOrigin": {"x": 0, "y": 0}, "contentOffset": {"x": 0, "y": 0}, "displayId": "",
        "displayPhysicalOrigin": {"x": 0, "y": 0}, "displayDriverOrigin": {"x": 0, "y": 0}, "coordinateStatus": "unavailable"});
    let (Ok(outer), Ok(size), Ok(inner), Ok(content), Ok(scale), Ok(monitors), Ok(Some(display))) = (
        window.outer_position(),
        window.outer_size(),
        window.inner_position(),
        window.inner_size(),
        window.scale_factor(),
        window.available_monitors(),
        window.current_monitor(),
    ) else {
        return result;
    };
    if !scale.is_finite() || scale <= 0.0 || size.width == 0 || size.height == 0 {
        return result;
    }
    let physical = (f64::from(outer.x), f64::from(outer.y));
    let display_physical = (
        f64::from(display.position().x),
        f64::from(display.position().y),
    );
    let display_driver = (display_physical.0 / scale, display_physical.1 / scale);
    result["x"] = json!(physical.0);
    result["y"] = json!(physical.1);
    result["w"] = json!(f64::from(size.width) / scale);
    result["h"] = json!(f64::from(size.height) / scale);
    result["scale"] = json!(scale);
    result["contentOffset"] = json!({"x": (f64::from(inner.x) - physical.0) / scale, "y": (f64::from(inner.y) - physical.1) / scale});
    result["displayId"] = json!(format!(
        "{}:{},{}",
        display.name().map(String::as_str).unwrap_or("display"),
        display_physical.0,
        display_physical.1
    ));
    result["displayPhysicalOrigin"] = json!({"x": display_physical.0, "y": display_physical.1});
    if !viewport_width.is_finite()
        || !viewport_height.is_finite()
        || viewport_width <= 0.0
        || viewport_height <= 0.0
        || content.width == 0
    {
        return result;
    }
    result["cssToPoint"] = json!(f64::from(content.width) / scale / viewport_width);
    if monitors
        .iter()
        .any(|m| (m.scale_factor() - scale).abs() > 0.0001)
    {
        result["coordinateStatus"] = json!("unsupported-mixed-dpi");
        return result;
    }
    if cfg!(target_os = "macos") && !monitors.is_empty() {
        result["displayDriverOrigin"] = json!({"x": display_driver.0, "y": display_driver.1});
        result["driverOrigin"] = mapped_origin(physical, display_physical, display_driver, scale);
        result["coordinateStatus"] = json!("supported");
    }
    result
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let Some(state) = window.try_state::<UatState>().filter(|s| s.enabled) else {
        return;
    };
    if matches!(event, tauri::WindowEvent::Destroyed) {
        let _ = state.stop(window.label());
    } else if matches!(
        event,
        tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. }
            | tauri::WindowEvent::Focused(_)
    ) {
        if let Ok(mut inner) = state.inner.lock() {
            if let Some(state) = inner.windows.get_mut(window.label()) {
                state.generation += 1;
                state.sample = None;
                let _ = window.emit("uat:geometry", state.generation);
            }
        }
    }
}

#[tauri::command]
pub async fn uat_start(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UatState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Value, String> {
    state.guard()?;
    let session = state.start(window.label(), &cwd, &registry)?;
    let stop = Arc::new(AtomicBool::new(false));
    let root = {
        let mut inner = state.inner.lock().map_err(|_| "UAT_STATE_UNAVAILABLE")?;
        let owner = inner
            .windows
            .get_mut(window.label())
            .ok_or("WINDOW_UNKNOWN")?;
        owner.stop = Some(stop.clone());
        owner.root.clone().ok_or("PROJECT_UNAUTHORIZED")?
    };
    watch_refresh(window, root, stop);
    Ok(session)
}

#[tauri::command]
pub fn uat_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UatState>,
) -> Result<(), String> {
    state.stop(window.label())
}

#[tauri::command]
pub async fn uat_geometry(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UatState>,
    viewport_width: f64,
    viewport_height: f64,
) -> Result<Value, String> {
    state.guard()?;
    let generation = {
        let inner = state.inner.lock().map_err(|_| "UAT_STATE_UNAVAILABLE")?;
        inner
            .windows
            .get(window.label())
            .filter(|s| s.root.is_some())
            .ok_or("WINDOW_UNKNOWN")?
            .generation
    };
    let geometry = native_window(&window, viewport_width, viewport_height);
    let mut inner = state.inner.lock().map_err(|_| "UAT_STATE_UNAVAILABLE")?;
    let owner = inner
        .windows
        .get_mut(window.label())
        .ok_or("WINDOW_UNKNOWN")?;
    if owner.generation != generation {
        return Err("GEOMETRY_CHANGED: native window moved during capture".into());
    }
    owner.sample = Some(geometry.clone());
    Ok(json!({"window": geometry, "generation": generation}))
}

#[tauri::command]
pub async fn uat_write_snapshot(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UatState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    json: String,
) -> Result<Value, String> {
    state.guard()?;
    let result = (|| {
        if json.len() > CAP {
            return Err("SNAPSHOT_TOO_LARGE: limit is 262144 bytes".into());
        }
        let value: Value =
            serde_json::from_str(&json).map_err(|_| "SCHEMA_INVALID: invalid JSON")?;
        let geometry = native_window(
            &window,
            value["viewport"]["w"].as_f64().unwrap_or(0.0),
            value["viewport"]["h"].as_f64().unwrap_or(0.0),
        );
        if !same_value(&geometry, &value["window"]) {
            return Err("GEOMETRY_CHANGED: native window moved before commit".into());
        }
        state.write(window.label(), &json, &registry)
    })();
    if let Err(error) = &result {
        if !error.starts_with("GEOMETRY_CHANGED") {
            report(&window, &state, error);
        }
    }
    result
}

#[tauri::command]
pub fn uat_report_failure(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UatState>,
    code: String,
) -> Result<UatError, String> {
    state.guard()?;
    let message = match code.as_str() {
        "DUPLICATE_TARGET" => "DUPLICATE_TARGET: repeated UAT addresses or identities",
        "SNAPSHOT_TOO_LARGE" => "SNAPSHOT_TOO_LARGE: limit is 262144 bytes",
        _ => "COLLECTOR_FAILED: cannot collect UAT snapshot",
    };
    state.failure(
        window.label(),
        message.split(':').next().unwrap_or("COLLECTOR_FAILED"),
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> Value {
        json!({
            "v": 1, "runId": "run", "windowId": "main", "seq": 1, "layoutSeq": 0,
            "capturedAt": "2026-09-08T10:30:00.000Z", "ts": "2026-09-08T10:30:00.001Z",
            "cwd": super::super::fs::to_canon(root), "refreshNonce": null, "health": "ok", "lastError": null,
            "window": {"x": -200, "y": 100, "w": 800, "h": 600, "scale": 2, "cssToPoint": 1,
                "driverUnits": "macos-points", "driverOrigin": {"x": -100, "y": 50}, "contentOffset": {"x": 1, "y": 28},
                "displayId": "test", "displayPhysicalOrigin": {"x": -2000, "y": 0}, "displayDriverOrigin": {"x": -1000, "y": 0}, "coordinateStatus": "supported"},
            "viewport": {"w": 798, "h": 572, "scrollX": 0, "scrollY": 0},
            "activeTab": {"uat": "tab-active", "key": "tab:1", "kind": "pi", "title": "Chat", "active": true},
            "tabs": [{"uat": "tab-active", "key": "tab:1", "kind": "pi", "title": "Chat", "active": true}],
            "elements": [{"uat": "settings-button", "scope": "tab:1", "index": null, "key": "tab:1/settings", "role": "button", "label": "Settings",
                "rect": {"x": 10, "y": 20, "w": 30, "h": 40}, "hitRect": {"x": 10, "y": 20, "w": 30, "h": 40},
                "enabled": true, "checked": null, "hidden": false, "interactable": true, "unstable": false, "summary": false, "props": {}}],
            "dupes": []
        })
    }

    fn setup() -> (tempfile::TempDir, WorkspaceRegistry, UatState, Value) {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let state = UatState::new(true);
        state
            .start("main", root.to_str().unwrap(), &registry)
            .unwrap();
        let mut value = fixture(&root);
        value["runId"] = json!(state.run_id);
        sample(&state, &value);
        (dir, registry, state, value)
    }

    fn sample(state: &UatState, value: &Value) {
        state
            .inner
            .lock()
            .unwrap()
            .windows
            .get_mut("main")
            .unwrap()
            .sample = Some(value["window"].clone());
    }

    #[test]
    fn flag_is_exact_and_default_is_off() {
        assert!(!launch_uat_from_args(Vec::<String>::new()));
        assert!(!launch_uat_from_args(["--uat=1", "--uatt", "uat", "--pi"]));
        assert!(launch_uat_from_args(["/tmp", "--uat", "--pi"]));
    }

    #[test]
    fn every_operation_refuses_when_off_without_touching_history() {
        let (dir, registry, _, value) = setup();
        let state = UatState::new(false);
        assert!(state.guard().unwrap_err().starts_with("UAT_DISABLED"));
        assert!(state
            .start("main", dir.path().to_str().unwrap(), &registry)
            .is_err());
        assert!(state.write("main", &value.to_string(), &registry).is_err());
        assert!(state.accept_refresh("main", b"{}", None).is_err());
        assert!(state.failure("main", "test", "test").is_err());
        assert!(state.stop("main").is_err());
        assert!(!dir.path().join(".pi").exists());
        fs::create_dir(dir.path().join(".pi")).unwrap();
        fs::write(dir.path().join(".pi/uat-snapshot.json"), b"historical").unwrap();
        assert!(state.write("main", &value.to_string(), &registry).is_err());
        assert_eq!(
            fs::read(dir.path().join(".pi/uat-snapshot.json")).unwrap(),
            b"historical"
        );
        assert!(!dir.path().join(".pi/uat-status.json").exists());
    }

    #[test]
    fn full_schema_checks_every_required_field_and_unknown_field_recursively() {
        fn mutate(value: &Value, rule: &Value, path: &str, fixture: &Value, root: &Path) {
            let rule = rule["$ref"]
                .as_str()
                .map(|r| schema().pointer(&r[1..]).unwrap())
                .unwrap_or(rule);
            if let Some(required) = rule["required"].as_array() {
                for name in required {
                    let mut invalid = fixture.clone();
                    invalid
                        .pointer_mut(path)
                        .unwrap()
                        .as_object_mut()
                        .unwrap()
                        .remove(name.as_str().unwrap());
                    assert!(
                        validate_snapshot(&invalid.to_string(), root).is_err(),
                        "missing {path}/{name}"
                    );
                }
                let mut invalid = fixture.clone();
                invalid.pointer_mut(path).unwrap()["argv"] = json!(["sensitive"]);
                assert!(
                    validate_snapshot(&invalid.to_string(), root).is_err(),
                    "extra {path}/argv"
                );
            }
            if let Some(object) = value.as_object() {
                for (key, value) in object {
                    if let Some(child) = rule["properties"].get(key) {
                        mutate(value, child, &format!("{path}/{key}"), fixture, root);
                    }
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let fixture = fixture(dir.path());
        validate_snapshot(&fixture.to_string(), dir.path()).unwrap();
        mutate(&fixture, schema(), "", &fixture, dir.path());
        for (pointer, replacement) in [
            ("/v", json!(2)),
            ("/seq", json!(0)),
            ("/layoutSeq", json!(-1)),
            ("/window/scale", json!(0)),
            ("/window/driverUnits", json!("physical")),
            ("/viewport/w", json!(-1)),
            ("/elements/0/label", json!("x".repeat(201))),
            ("/elements/0/uat", json!("Bad_ID")),
            ("/elements/0/props/sha256", json!("bad")),
            ("/elements/0/props/inputTokens", json!(-1)),
            ("/elements/0/props/argv", json!(["secret"])),
            ("/elements/0/props/exit", json!("ok")),
            ("/elements/0/index", json!(-1)),
            ("/capturedAt", json!("2026-02-30T12:00:00Z")),
            ("/ts", json!("2026-09-08T12:00:00+02:00")),
            ("/capturedAt", json!("2026-09-09T12:00:00Z")),
        ] {
            let mut invalid = fixture.clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            invalid.pointer_mut(parent).unwrap()[key] = replacement;
            assert!(
                validate_snapshot(&invalid.to_string(), dir.path()).is_err(),
                "invalid {pointer}"
            );
        }
        assert!(utc_time("2024-02-29T00:00:00Z").is_some());
        assert!(utc_time("2025-02-29T00:00:00Z").is_none());
        assert!(utc_time(&now()).is_some());
    }

    #[test]
    fn cap_counts_utf8_bytes_and_rejects_before_any_write() {
        let (dir, registry, state, mut value) = setup();
        value["elements"][0]["props"]["status"] = json!("é".repeat(CAP / 2));
        let raw = value.to_string();
        assert!(raw.chars().count() < CAP && raw.len() > CAP);
        assert!(state
            .write("main", &raw, &registry)
            .unwrap_err()
            .starts_with("SNAPSHOT_TOO_LARGE"));
        assert!(!dir.path().join(".pi").exists());
        let mut raw = fixture(dir.path()).to_string();
        raw.push_str(&" ".repeat(CAP - raw.len()));
        validate_snapshot(&raw, dir.path()).unwrap();
        raw.push(' ');
        assert!(validate_snapshot(&raw, dir.path()).is_err());
    }

    #[test]
    fn ownership_authorization_identity_and_sequences_are_enforced() {
        let (dir, registry, state, value) = setup();
        let outsider = tempfile::tempdir().unwrap();
        assert!(state
            .start("other", outsider.path().to_str().unwrap(), &registry)
            .is_err());
        assert!(state
            .start("other", dir.path().to_str().unwrap(), &registry)
            .unwrap_err()
            .starts_with("WINDOW_BUSY"));
        for field in ["cwd", "runId", "windowId"] {
            let mut invalid = value.clone();
            invalid[field] = json!("elsewhere");
            assert!(state
                .write("main", &invalid.to_string(), &registry)
                .is_err());
        }
        state.write("main", &value.to_string(), &registry).unwrap();
        sample(&state, &value);
        assert!(state.write("main", &value.to_string(), &registry).is_err());
        state.stop("main").unwrap();
        state
            .start("other", dir.path().to_str().unwrap(), &registry)
            .unwrap();
        assert!(state.write("main", &value.to_string(), &registry).is_err());
    }

    #[test]
    fn secret_summaries_duplicates_and_clipping_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let mut value = fixture(dir.path());
        let secret = json!({"uat": "settings-secret", "scope": "settings", "index": null, "key": "provider", "secret": true});
        value["elements"].as_array_mut().unwrap().push(secret);
        validate_snapshot(&value.to_string(), dir.path()).unwrap();
        for field in ["label", "text", "value", "rect", "props"] {
            let mut bad = value.clone();
            bad["elements"][1][field] = json!("credential");
            assert!(validate_snapshot(&bad.to_string(), dir.path()).is_err());
        }
        for (field, changed) in [
            ("hidden", json!(true)),
            ("enabled", json!(false)),
            ("hitRect", Value::Null),
        ] {
            let mut bad = value.clone();
            bad["elements"][0][field] = changed;
            assert!(validate_snapshot(&bad.to_string(), dir.path()).is_err());
        }
        let mut bad = value.clone();
        bad["elements"][0]["hitRect"]["x"] = json!(9);
        assert!(validate_snapshot(&bad.to_string(), dir.path()).is_err());
        let duplicate = value["elements"][0].clone();
        value["elements"].as_array_mut().unwrap().push(duplicate);
        assert!(validate_snapshot(&value.to_string(), dir.path()).is_err());
        value["dupes"] = json!(duplicate_targets(value["elements"].as_array().unwrap()));
        value["health"] = json!("error");
        value["lastError"] = json!({"code": "DUPLICATE_TARGET", "message": "Duplicates", "at": now(), "consecutiveFailures": 1, "logPath": ".pi/logs/uat.jsonl"});
        value["elements"][0]["interactable"] = json!(false);
        value["elements"][2]["interactable"] = json!(false);
        validate_snapshot(&value.to_string(), dir.path()).unwrap();
    }

    #[test]
    fn refresh_validates_all_fields_and_rejects_replays_and_future_sequences() {
        let (_dir, registry, state, mut value) = setup();
        let request = json!({"v": 1, "runId": state.run_id, "windowId": "main", "nonce": "fresh", "afterSeq": 0, "requestedAt": now()});
        assert!(state
            .accept_refresh(
                "main",
                request.to_string().as_bytes(),
                Some(Path::new("/another-project"))
            )
            .unwrap_err()
            .starts_with("PROJECT_CHANGED"));
        for key in ["v", "runId", "windowId", "nonce", "afterSeq", "requestedAt"] {
            let mut bad = request.clone();
            bad.as_object_mut().unwrap().remove(key);
            assert!(state
                .accept_refresh("main", bad.to_string().as_bytes(), None)
                .is_err());
        }
        for (field, changed) in [
            ("v", json!(2)),
            ("runId", json!("old")),
            ("windowId", json!("unknown")),
            ("nonce", json!("")),
            ("afterSeq", json!(1)),
            ("requestedAt", json!("today")),
            ("action", json!("click")),
        ] {
            let mut bad = request.clone();
            bad[field] = changed;
            assert!(state
                .accept_refresh("main", bad.to_string().as_bytes(), None)
                .is_err());
        }
        state
            .accept_refresh("main", request.to_string().as_bytes(), None)
            .unwrap();
        assert!(state
            .accept_refresh("main", request.to_string().as_bytes(), None)
            .unwrap_err()
            .starts_with("NONCE_REUSED"));
        value["refreshNonce"] = json!("wrong");
        assert!(state.write("main", &value.to_string(), &registry).is_err());
        value["refreshNonce"] = json!("fresh");
        state.write("main", &value.to_string(), &registry).unwrap();
        assert!(state.inner.lock().unwrap().windows["main"]
            .requests
            .is_empty());
        value["seq"] = json!(2);
        sample(&state, &value);
        state.write("main", &value.to_string(), &registry).unwrap();
        assert_eq!(
            state.inner.lock().unwrap().windows["main"]
                .acknowledged
                .as_ref()
                .unwrap()
                .nonce,
            "fresh"
        );
    }

    #[test]
    fn accepted_refreshes_and_acknowledged_writes_append_event_lines() {
        let (dir, registry, state, mut value) = setup();
        let request = json!({"v": 1, "runId": state.run_id, "windowId": "main", "nonce": "n1", "afterSeq": 0, "requestedAt": now()});
        state
            .accept_refresh("main", request.to_string().as_bytes(), None)
            .unwrap();
        value["refreshNonce"] = json!("n1");
        state.write("main", &value.to_string(), &registry).unwrap();
        value["seq"] = json!(2);
        sample(&state, &value);
        state.write("main", &value.to_string(), &registry).unwrap();
        let lines: Vec<Value> = fs::read_to_string(dir.path().join(".pi/logs/uat.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0],
            json!({"time": lines[0]["time"], "event": "refresh", "nonce": "n1", "seq": 0})
        );
        assert_eq!(
            lines[1],
            json!({"time": lines[1]["time"], "event": "ack", "nonce": "n1", "seq": 1})
        );
    }

    #[test]
    fn atomic_replacement_stays_complete_for_concurrent_readers_and_tightens_permissions() {
        let (dir, registry, state, mut value) = setup();
        state.write("main", &value.to_string(), &registry).unwrap();
        let path = dir.path().join(".pi/uat-snapshot.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let readers: Vec<_> = (0..4)
            .map(|_| {
                let stop = stop.clone();
                let path = path.clone();
                std::thread::spawn(move || {
                    let mut reads = 0;
                    while !stop.load(Ordering::Relaxed) || reads == 0 {
                        let snapshot: Value =
                            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                        assert!(snapshot["seq"].as_u64().unwrap() >= 1);
                        reads += 1;
                    }
                })
            })
            .collect();
        for seq in 2..20 {
            value["seq"] = json!(seq);
            sample(&state, &value);
            state.write("main", &value.to_string(), &registry).unwrap();
        }
        stop.store(true, Ordering::Relaxed);
        for reader in readers {
            reader.join().unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(dir.path().join(".pi/uat-status.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(fs::read_dir(dir.path().join(".pi")).unwrap().count(), 2);
    }

    #[test]
    fn failures_are_logged_and_recovery_clears_health() {
        let (dir, registry, state, value) = setup();
        for count in 1..=3 {
            assert_eq!(
                state
                    .failure("main", "WRITE_FAILED", "Test failure")
                    .unwrap()
                    .consecutive_failures,
                count
            );
        }
        let status: Value =
            serde_json::from_slice(&fs::read(dir.path().join(".pi/uat-status.json")).unwrap())
                .unwrap();
        assert_eq!(status["health"], "error");
        assert_eq!(
            fs::read_to_string(dir.path().join(".pi/logs/uat.jsonl"))
                .unwrap()
                .lines()
                .count(),
            3
        );
        state.write("main", &value.to_string(), &registry).unwrap();
        assert_eq!(state.inner.lock().unwrap().windows["main"].failures, 0);
        let status: Value =
            serde_json::from_slice(&fs::read(dir.path().join(".pi/uat-status.json")).unwrap())
                .unwrap();
        assert_eq!(status["health"], "ok");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_runtime_files_and_escaping_paths_are_refused() {
        use std::os::unix::fs::symlink;
        let (dir, registry, state, mut value) = setup();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), dir.path().join(".pi")).unwrap();
        assert!(state.write("main", &value.to_string(), &registry).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_file(dir.path().join(".pi")).unwrap();
        fs::create_dir(dir.path().join(".pi")).unwrap();
        symlink(
            outside.path().join("stolen"),
            dir.path().join(".pi/uat-snapshot.json"),
        )
        .unwrap();
        assert!(state.write("main", &value.to_string(), &registry).is_err());
        assert!(!outside.path().join("stolen").exists());
        symlink(outside.path(), dir.path().join("escape")).unwrap();
        for path in [
            "../escape",
            "/outside",
            "a/../../outside",
            "a\\..\\outside",
            "escape/body.md",
        ] {
            value["elements"][0]["props"]["path"] = json!(path);
            assert!(
                validate_snapshot(&value.to_string(), &fs::canonicalize(dir.path()).unwrap())
                    .is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn display_origin_transform_preserves_negative_desktop_and_content_offset() {
        assert!(same_value(
            &json!({"x": 100.0, "scale": 2.0}),
            &json!({"x": 100, "scale": 2})
        ));
        let origin = mapped_origin((-1800.0, 200.0), (-2000.0, 0.0), (-1000.0, 0.0), 2.0);
        assert_eq!(origin, json!({"x": -900.0, "y": 100.0}));
        let click_x = origin["x"].as_f64().unwrap() + 1.0 + (10.0 + 30.0 / 2.0) * 1.25;
        let click_y = origin["y"].as_f64().unwrap() + 28.0 + (20.0 + 40.0 / 2.0) * 1.25;
        assert_eq!((click_x, click_y), (-867.75, 178.0));
    }
}

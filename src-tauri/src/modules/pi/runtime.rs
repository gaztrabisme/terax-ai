//! K14: the resolved-configuration report `<project>/.pi/runtime.json`
//! (design.md sections 3.4 "Runtime resolution and failures" and 3.6).
//!
//! The launcher's four preparation steps run in the harness agent; this module
//! transcribes the agent's step names and statuses exactly (seed, render,
//! root, wiki; OK, WARN, FAIL), joins them with the effective binary, agent
//! dirs, orchestrator role and endpoint, scrubs every credential value, and
//! writes the file through the fs module's atomic writer before pi spawns.
//! First-run check rows read this report back so Settings describes the last
//! real launch, never the bundled template directory.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::launcher::PrepareReport;
use crate::modules::fs::file::write_atomic;

/// Schema version of the runtime report.
const REPORT_VERSION: u32 = 1;

/// Replacement text for every scrubbed credential value.
pub(crate) const REDACTED: &str = "[redacted]";

/// Env vars whose values are credentials. Their values never enter the
/// report, and any occurrence inside a transcribed detail is replaced; the
/// names follow the launch path's own credential set (Rust twins:
/// LIST_MODEL_SCRUB_* in mod.rs, PROVIDER_ENVS in secrets.rs).
pub(crate) const CREDENTIAL_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
    "OMLX_API_KEY",
    "EFFICIENT_PI_OMLX_KEY",
];

/// One preparation step as the harness reported it: names and statuses are
/// transcribed verbatim (seed, render, root, wiki; OK, WARN, FAIL).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeStep {
    pub name: String,
    pub status: String,
    pub detail: String,
}

/// The pi binary the session spawns and where the resolution found it
/// ("pref", "bundled" or "checkout"; launch.rs PathSource lowercased).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeBinary {
    pub path: String,
    pub source: String,
}

/// The effective orchestrator role: provider, model, thinking level, endpoint
/// (a baseUrl from the rendered models.json, never a credential) and where
/// each value came from ("project", "global" or "default", per the design 3.6
/// precedence order).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrchestratorRole {
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub endpoint: Option<String>,
    pub source: String,
}

/// The role block: one entry today, keyed so a future subagent role slots in
/// beside the orchestrator without reshaping the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeRoles {
    pub orchestrator: OrchestratorRole,
}

/// The credential-free effective report for one launch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeReport {
    pub v: u32,
    pub steps: Vec<RuntimeStep>,
    pub agent_dir: String,
    pub session_dir: String,
    pub agent_hub_dir: String,
    pub binary: RuntimeBinary,
    pub agent_dir_source: String,
    pub roles: RuntimeRoles,
    pub launched_at: String,
}

/// Everything the spawn path knows about the resolution, threaded from pi_open
/// through session::prepare_direct so the report records what actually runs.
#[derive(Debug, Clone, Default)]
pub struct RuntimeContext {
    pub binary_path: String,
    pub binary_source: String,
    pub agent_dir_source: String,
    pub provider: String,
    pub provider_source: String,
    pub model: String,
    pub model_source: String,
    pub thinking: String,
    pub thinking_source: String,
}

/// `<project>/.pi/runtime.json` for a project root.
pub fn runtime_path(project_root: &Path) -> PathBuf {
    project_root.join(".pi").join("runtime.json")
}

/// RFC 3339 UTC for the current time, the same date/time notation the other
/// `.pi` records use, computed without a time crate (days-from-civil).
pub fn now_rfc3339() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    rfc3339_from_unix(now.as_secs(), now.subsec_millis())
}

/// RFC 3339 UTC for unix seconds plus milliseconds.
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
    let mut month = 1;
    for length in month_days {
        if days < length {
            break;
        }
        days -= length;
        month += 1;
    }
    let day = days + 1;
    let secs_of_day = (secs % 86400) as u32;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    )
}

/// Replaces every occurrence of every secret value with the redaction mark.
/// Blank values are never treated as secrets; the longest values are replaced
/// first so one secret containing another cannot leave a fragment behind.
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    let mut ordered: Vec<&String> = secrets
        .iter()
        .filter(|s| !s.trim().is_empty())
        .collect();
    ordered.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for secret in ordered {
        if out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), REDACTED);
        }
    }
    out
}

/// Every credential value the spawn env and the render endpoint carry, ready
/// for scrub(). Values stay in memory only: they are never written anywhere.
pub fn collect_secrets(env: &HashMap<String, String>, endpoint_key: &str) -> Vec<String> {
    let mut secrets: Vec<String> = CREDENTIAL_ENV_KEYS
        .iter()
        .filter_map(|key| env.get(*key))
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .collect();
    if !endpoint_key.trim().is_empty() {
        secrets.push(endpoint_key.to_string());
    }
    secrets.sort();
    secrets.dedup();
    secrets
}

/// The orchestrator endpoint: `providers.<provider>.baseUrl` from the rendered
/// models.json in the runtime agent dir. Only the baseUrl is read; the api
/// key stays in the file and never enters the report. None when the file is
/// missing, unreadable, or does not list the provider.
pub fn read_endpoint(agent_dir: &Path, provider: &str) -> Option<String> {
    let raw = fs::read_to_string(agent_dir.join("models.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let base = parsed
        .get("providers")?
        .get(provider)?
        .get("baseUrl")?
        .as_str()?;
    (!base.trim().is_empty()).then(|| base.to_string())
}

/// Where a role value came from, per the design 3.6 order: the project
/// override wins, then the global preference the caller resolved into the
/// spawn env, then the packaged default. (An explicit launch-environment
/// override is indistinguishable from a global value at this layer; pi_open
/// documents the limitation.)
pub fn role_source(from_project: bool, value: &str) -> &'static str {
    if from_project {
        "project"
    } else if !value.trim().is_empty() {
        "global"
    } else {
        "default"
    }
}

/// Builds the report from a prepare report plus the spawn resolution. Steps
/// are transcribed exactly; `session_dir`/`agent_hub_dir` prefer the harness
/// report's own values when it supplies them and are derived the way the
/// launch path derives them otherwise (`<project>/.pi/sessions` via
/// PI_SESSIONS_DIR, `<agent dir>/agent-hub` via pi's own layout).
pub fn build_report(
    project_root: &Path,
    prepare: &PrepareReport,
    ctx: &RuntimeContext,
) -> RuntimeReport {
    let agent_dir = prepare.agent_dir.to_string_lossy().into_owned();
    let endpoint = read_endpoint(&prepare.agent_dir, ctx.provider.trim());
    RuntimeReport {
        v: REPORT_VERSION,
        steps: prepare
            .steps
            .iter()
            .map(|step| RuntimeStep {
                name: step.name.clone(),
                status: step.status.clone(),
                detail: step.detail.clone(),
            })
            .collect(),
        // The harness report's own locators win (K11 extends the prepare
        // report with sessionDir and agentHubDir); the launch path's derived
        // values fill the gap when the report carries none.
        session_dir: prepare.session_dir.clone().unwrap_or_else(|| {
            project_root
                .join(".pi")
                .join("sessions")
                .to_string_lossy()
                .into_owned()
        }),
        agent_hub_dir: prepare.agent_hub_dir.clone().unwrap_or_else(|| {
            prepare
                .agent_dir
                .join("agent-hub")
                .to_string_lossy()
                .into_owned()
        }),
        agent_dir,
        binary: RuntimeBinary {
            path: ctx.binary_path.clone(),
            source: ctx.binary_source.clone(),
        },
        agent_dir_source: ctx.agent_dir_source.clone(),
        roles: RuntimeRoles {
            orchestrator: OrchestratorRole {
                provider: ctx.provider.clone(),
                model: ctx.model.clone(),
                thinking: ctx.thinking.clone(),
                endpoint,
                source: ctx.provider_source.clone(),
            },
        },
        launched_at: now_rfc3339(),
    }
}

/// Scrubs every string field in place.
pub fn scrub_report(report: &mut RuntimeReport, secrets: &[String]) {
    for step in &mut report.steps {
        step.detail = scrub(&step.detail, secrets);
        step.name = scrub(&step.name, secrets);
        step.status = scrub(&step.status, secrets);
    }
    report.agent_dir = scrub(&report.agent_dir, secrets);
    report.session_dir = scrub(&report.session_dir, secrets);
    report.agent_hub_dir = scrub(&report.agent_hub_dir, secrets);
    report.binary.path = scrub(&report.binary.path, secrets);
    report.binary.source = scrub(&report.binary.source, secrets);
    report.agent_dir_source = scrub(&report.agent_dir_source, secrets);
    let role = &mut report.roles.orchestrator;
    role.provider = scrub(&role.provider, secrets);
    role.model = scrub(&role.model, secrets);
    role.thinking = scrub(&role.thinking, secrets);
    role.source = scrub(&role.source, secrets);
    if let Some(endpoint) = &role.endpoint {
        role.endpoint = Some(scrub(endpoint, secrets));
    }
    report.launched_at = scrub(&report.launched_at, secrets);
}

/// Serializes and atomically replaces `<project>/.pi/runtime.json`. The write
/// failure is returned so the caller can refuse the spawn rather than launch
/// with an unrecorded resolution. The caller scrubs credentials first (the
/// launch path does: collect_secrets + scrub_report); write_report writes
/// exactly what it is given.
pub fn write_report(project_root: &Path, report: &RuntimeReport) -> Result<(), String> {
    let text = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
    let path = runtime_path(project_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    write_atomic(&path, text.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// `.pi/terax.json` project overrides
// ---------------------------------------------------------------------------

/// The allowed Pi preference keys a project override file may carry: exactly
/// the Pi keys the global preferences define (frontend twin: WORKSPACE_KEYS in
/// src/modules/pi/lib/providers.ts). Any other key fails the launch visibly.
pub const OVERRIDE_KEYS: &[&str] = &[
    "piLauncherDir",
    "piBoardBin",
    "piAgentBin",
    "piAgentDir",
    "piProvider",
    "piModel",
    "piThinking",
    "piSmol",
    "piBppcHost",
];

/// The valid thinking levels (frontend twin: PI_THINKING_LEVELS).
const THINKING_LEVELS: &[&str] = &["off", "low", "medium", "high", "xhigh"];

/// The project override values merged over the global preferences. `None`
/// means "the global value stands".
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProjectOverrides {
    pub launcher_dir: Option<String>,
    pub board_bin: Option<String>,
    pub agent_bin: Option<String>,
    pub agent_dir: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub smol: Option<String>,
    pub bppc_host: Option<String>,
}

impl ProjectOverrides {
    fn from_pairs(pairs: Vec<(&str, String)>) -> Self {
        let mut out = Self::default();
        for (key, value) in pairs {
            match key {
                "piLauncherDir" => out.launcher_dir = Some(value),
                "piBoardBin" => out.board_bin = Some(value),
                "piAgentBin" => out.agent_bin = Some(value),
                "piAgentDir" => out.agent_dir = Some(value),
                "piProvider" => out.provider = Some(value),
                "piModel" => out.model = Some(value),
                "piThinking" => out.thinking = Some(value),
                "piSmol" => out.smol = Some(value),
                "piBppcHost" => out.bppc_host = Some(value),
                _ => {}
            }
        }
        out
    }
}

/// Reads and validates `<project>/.pi/terax.json`. Missing file or no project
/// yields no overrides. Malformed JSON and unknown keys fail visibly with the
/// path or key name; a known key with a value of the wrong type (or an
/// invalid thinking level) is ignored, the same call resolvePiPrefs makes in
/// the frontend.
pub fn read_project_overrides(project_root: Option<&Path>) -> Result<ProjectOverrides, String> {
    let Some(project_root) = project_root else {
        return Ok(ProjectOverrides::default());
    };
    let path = project_root.join(".pi").join("terax.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(ProjectOverrides::default());
    };
    let parsed: serde_json::Value = serde_json::from_str(raw.trim()).map_err(|e| {
        format!(
            "invalid pi override file {}: {e}",
            path.to_string_lossy()
        )
    })?;
    let Some(object) = parsed.as_object() else {
        return Err(format!(
            "invalid pi override file {}: expected a JSON object",
            path.to_string_lossy()
        ));
    };
    let mut pairs = Vec::new();
    for key in object.keys() {
        if !OVERRIDE_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "unknown pi preference key \"{key}\" in {}",
                path.to_string_lossy()
            ));
        }
    }
    for (key, value) in object {
        let Some(text) = value.as_str() else {
            // Known key, wrong type: ignored, matching resolvePiPrefs.
            continue;
        };
        if key == "piThinking" && !THINKING_LEVELS.contains(&text) {
            continue;
        }
        pairs.push((key.as_str(), text.to_string()));
    }
    Ok(ProjectOverrides::from_pairs(pairs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn prepare_with_status(status: &str, detail: &str) -> PrepareReport {
        PrepareReport {
            steps: vec![super::super::launcher::PrepareStep {
                name: "render".to_string(),
                ok: status != "FAIL",
                status: status.to_string(),
                detail: detail.to_string(),
            }],
            agent_dir: "/agents/runtime".into(),
            env: Default::default(),
            session_dir: None,
            agent_hub_dir: None,
        }
    }

    fn ctx() -> RuntimeContext {
        RuntimeContext {
            binary_path: "/bundled/pi".to_string(),
            binary_source: "bundled".to_string(),
            agent_dir_source: "bundled".to_string(),
            provider: "bppc".to_string(),
            provider_source: "project".to_string(),
            model: "qwen3.8-27b".to_string(),
            model_source: "global".to_string(),
            thinking: "xhigh".to_string(),
            thinking_source: "default".to_string(),
        }
    }

    #[test]
    fn report_shape_round_trips_through_the_atomic_writer() {
        let project = tempfile::tempdir().expect("tempdir");
        let prepare = prepare_with_status("OK", "models.json unchanged");
        let report = build_report(project.path(), &prepare, &ctx());
        assert_eq!(report.v, 1);
        assert_eq!(report.steps.len(), 1);
        assert_eq!(report.steps[0].name, "render");
        assert_eq!(report.steps[0].status, "OK");
        assert_eq!(report.binary.path, "/bundled/pi");
        assert_eq!(report.binary.source, "bundled");
        assert_eq!(report.agent_dir_source, "bundled");
        assert_eq!(report.roles.orchestrator.provider, "bppc");
        assert_eq!(report.roles.orchestrator.model, "qwen3.8-27b");
        assert_eq!(report.roles.orchestrator.thinking, "xhigh");
        assert_eq!(report.roles.orchestrator.source, "project");
        assert_eq!(
            report.session_dir,
            project
                .path()
                .join(".pi")
                .join("sessions")
                .to_string_lossy()
        );
        assert_eq!(report.agent_hub_dir, "/agents/runtime/agent-hub");
        write_report(project.path(), &report).expect("write");
        let raw =
            fs::read_to_string(runtime_path(project.path())).expect("runtime.json");
        let parsed: RuntimeReport = serde_json::from_str(&raw).expect("parse");
        assert_eq!(parsed, report);
        assert!(parsed.launched_at.ends_with('Z'));
        assert!(parsed.launched_at.contains('T'));
    }

    #[test]
    fn statuses_are_transcribed_exactly_including_warn_and_fail() {
        let project = tempfile::tempdir().expect("tempdir");
        let mut prepare = prepare_with_status("WARN", "models.json drifted");
        prepare.steps.push(super::super::launcher::PrepareStep {
            name: "root".to_string(),
            ok: false,
            status: "FAIL".to_string(),
            detail: "no .git".to_string(),
        });
        let report = build_report(project.path(), &prepare, &ctx());
        let statuses: Vec<&str> =
            report.steps.iter().map(|s| s.status.as_str()).collect();
        assert_eq!(statuses, vec!["WARN", "FAIL"]);
        let names: Vec<&str> = report.steps.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["render", "root"]);
    }

    #[test]
    fn every_credential_value_is_scrubbed_from_the_written_file() {
        let project = tempfile::tempdir().expect("tempdir");
        let mut env = HashMap::new();
        env.insert("OMLX_API_KEY".to_string(), "sk-omlx-live".to_string());
        env.insert(
            "ANTHROPIC_API_KEY".to_string(),
            "sk-ant-live".to_string(),
        );
        env.insert("EFFICIENT_PI_OMLX_KEY".to_string(), "  ".to_string());
        let secrets = collect_secrets(&env, "sk-omlx-live");
        assert_eq!(secrets, vec!["sk-ant-live", "sk-omlx-live"]);
        let mut report = build_report(
            project.path(),
            &prepare_with_status("OK", "key sk-omlx-live in detail"),
            &ctx(),
        );
        report.roles.orchestrator.endpoint =
            Some("http://127.0.0.1:8080/v1?key=sk-omlx-live".to_string());
        // The launch path's exact write sequence: scrub, then write.
        scrub_report(&mut report, &secrets);
        write_report(project.path(), &report).expect("write");
        let raw =
            fs::read_to_string(runtime_path(project.path())).expect("runtime.json");
        assert!(!raw.contains("sk-omlx-live"), "raw: {raw}");
        assert!(!raw.contains("sk-ant-live"), "raw: {raw}");
        assert!(raw.contains(REDACTED), "raw: {raw}");
    }

    #[test]
    fn scrub_replaces_the_longest_secret_first_and_keeps_blank_values() {
        let scrubbed = scrub("a longsecretvalue b secret", &[
            "secret".to_string(),
            "longsecretvalue".to_string(),
            "  ".to_string(),
        ]);
        assert_eq!(scrubbed, format!("a {REDACTED} b {REDACTED}"));
        // Blank values are never secrets, so an empty report stays intact.
        assert_eq!(scrub("plain", &["  ".to_string()]), "plain");
    }

    #[test]
    fn endpoint_is_read_from_the_rendered_models_json_only() {
        let agent = tempfile::tempdir().expect("tempdir");
        fs::write(
            agent.path().join("models.json"),
            r#"{"providers":{"bppc":{"api":"openai-completions","baseUrl":"http://127.0.0.1:8080/v1","apiKey":"sk-secret"},"omlx":{"baseUrl":"http://127.0.0.1:8000/v1"}}}"#,
        )
        .expect("models.json");
        assert_eq!(
            read_endpoint(agent.path(), "bppc").as_deref(),
            Some("http://127.0.0.1:8080/v1")
        );
        assert_eq!(
            read_endpoint(agent.path(), "omlx").as_deref(),
            Some("http://127.0.0.1:8000/v1")
        );
        assert_eq!(read_endpoint(agent.path(), "missing"), None);
        // No models.json at all: no endpoint, never a guess.
        let empty = tempfile::tempdir().expect("tempdir");
        assert_eq!(read_endpoint(empty.path(), "bppc"), None);
        // The key beside the baseUrl never leaks through read_endpoint.
        let report = build_report(
            tempfile::tempdir().expect("tempdir").path(),
            &PrepareReport {
                steps: vec![],
                agent_dir: agent.path().to_path_buf(),
                env: Default::default(),
                session_dir: None,
                agent_hub_dir: None,
            },
            &ctx(),
        );
        assert_eq!(
            report.roles.orchestrator.endpoint.as_deref(),
            Some("http://127.0.0.1:8080/v1")
        );
    }

    #[test]
    fn role_source_follows_the_project_global_default_order() {
        assert_eq!(role_source(true, ""), "project");
        assert_eq!(role_source(false, "bppc"), "global");
        assert_eq!(role_source(false, "   "), "default");
    }

    #[test]
    fn harness_report_dirs_override_the_derived_ones() {
        let project = tempfile::tempdir().expect("tempdir");
        let mut prepare = prepare_with_status("OK", "seeded");
        prepare.session_dir = Some("/custom/sessions".to_string());
        prepare.agent_hub_dir = Some("/custom/hub".to_string());
        let report = build_report(project.path(), &prepare, &ctx());
        assert_eq!(report.session_dir, "/custom/sessions");
        assert_eq!(report.agent_hub_dir, "/custom/hub");
        // Without report values the derived paths are the launch path's own.
        let mut prepare = prepare_with_status("OK", "seeded");
        prepare.session_dir = None;
        prepare.agent_hub_dir = None;
        let report = build_report(project.path(), &prepare, &ctx());
        assert_eq!(
            report.session_dir,
            project
                .path()
                .join(".pi")
                .join("sessions")
                .to_string_lossy()
        );
        assert_eq!(report.agent_hub_dir, "/agents/runtime/agent-hub");
    }

    #[test]
    fn rfc3339_formats_the_known_timestamp_shapes() {
        // Cross-checked against `date -u -r 1757635455` and Python's
        // datetime.fromtimestamp: the UTC instant is 2025-09-12T00:04:15Z.
        assert_eq!(
            rfc3339_from_unix(1_757_635_455, 123),
            "2025-09-12T00:04:15.123Z"
        );
        assert_eq!(rfc3339_from_unix(0, 0), "1970-01-01T00:00:00.000Z");
        // Leap-year day boundary: 2024-02-29.
        assert_eq!(
            rfc3339_from_unix(1_709_164_800, 0),
            "2024-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn overrides_read_merge_and_refuse_by_key() {
        let project = tempfile::tempdir().expect("tempdir");
        // No file: no overrides, no error.
        assert_eq!(
            read_project_overrides(Some(project.path())).expect("none"),
            ProjectOverrides::default()
        );
        fs::create_dir_all(project.path().join(".pi")).expect("mkdir");
        fs::write(
            project.path().join(".pi").join("terax.json"),
            r#"{"piProvider":"bppc","piModel":"qwen3.8-27b","piThinking":"high","piBppcHost":"10.0.0.9","piAgentDir":"$HOME/agents/x"}"#,
        )
        .expect("write overrides");
        let got = read_project_overrides(Some(project.path())).expect("overrides");
        assert_eq!(got.provider.as_deref(), Some("bppc"));
        assert_eq!(got.model.as_deref(), Some("qwen3.8-27b"));
        assert_eq!(got.thinking.as_deref(), Some("high"));
        assert_eq!(got.bppc_host.as_deref(), Some("10.0.0.9"));
        assert_eq!(got.agent_dir.as_deref(), Some("$HOME/agents/x"));
        assert_eq!(got.launcher_dir, None);
    }

    #[test]
    fn overrides_refuse_unknown_keys_and_malformed_json_visibly() {
        let project = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(project.path().join(".pi")).expect("mkdir");
        let path = project.path().join(".pi").join("terax.json");
        fs::write(&path, r#"{"piProvider":"bppc","piSecret":"x"}"#).expect("write");
        let err = read_project_overrides(Some(project.path())).expect_err("unknown key");
        assert!(err.contains("piSecret"), "err: {err}");
        assert!(err.contains("terax.json"), "err: {err}");
        fs::write(&path, "{not json").expect("write");
        let err = read_project_overrides(Some(project.path())).expect_err("malformed");
        assert!(err.contains("invalid pi override file"), "err: {err}");
        fs::write(&path, r#"["piProvider"]"#).expect("write");
        let err =
            read_project_overrides(Some(project.path())).expect_err("non-object");
        assert!(err.contains("expected a JSON object"), "err: {err}");
        // No project: no overrides.
        assert_eq!(
            read_project_overrides(None).expect("none"),
            ProjectOverrides::default()
        );
    }

    #[test]
    fn overrides_ignore_wrong_typed_and_invalid_thinking_values() {
        let project = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(project.path().join(".pi")).expect("mkdir");
        fs::write(
            project.path().join(".pi").join("terax.json"),
            r#"{"piProvider":42,"piThinking":"maximum","piModel":"m"}"#,
        )
        .expect("write overrides");
        let got = read_project_overrides(Some(project.path())).expect("overrides");
        assert_eq!(got.provider, None, "wrong type is ignored");
        assert_eq!(got.thinking, None, "invalid level is ignored");
        assert_eq!(got.model.as_deref(), Some("m"));
    }

    /// The written file must be parseable byte-for-byte after a concurrent
    /// style rewrite: the atomic writer replaces, never appends.
    #[test]
    fn rewrite_replaces_the_previous_report() {
        let project = tempfile::tempdir().expect("tempdir");
        let prepare = prepare_with_status("OK", "first");
        let mut report = build_report(project.path(), &prepare, &ctx());
        write_report(project.path(), &report).expect("write");
        report.steps[0].detail = "second".to_string();
        write_report(project.path(), &report).expect("rewrite");
        let raw =
            fs::read_to_string(runtime_path(project.path())).expect("runtime.json");
        assert!(raw.contains("second"));
        assert!(!raw.contains("first"));
        let mut handle = fs::File::open(runtime_path(project.path())).expect("open");
        let mut buf = Vec::new();
        handle.read_to_end(&mut buf).expect("read");
    }
}

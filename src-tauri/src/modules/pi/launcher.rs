//! Session preparation by delegation: the four local launcher steps (seed the
//! agent dir, render models.json, the project-root guard, wiki init) run in
//! the harness agent binary (`agent pi prepare`, crates/agent/src/pi.rs) - one
//! implementation serving every caller, the bash launcher and this module
//! alike. The binary is resolved by the app through pi_paths (a pref or the
//! bundled sidecar); this module builds the command line, maps the agent's
//! JSON report onto PrepareReport so launcher.log and the frontend keep their
//! shape, and keeps the oMLX key default the spawn paths share. Health probes
//! of bppc and oMLX stay out of this unit; the caller composes them
//! separately.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// Agent dir inside the app data dir: a writable per-user copy of the bundled
/// read-only template (resources/pi-home/agent).
pub fn user_agent_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("pi-home").join("agent")
}

/// Env var the agent reads the oMLX key from (`--omlx-key-env`). Set on the
/// prepare child process only: the key never lands in the spawn env, the
/// report or launcher.log.
const OMLX_KEY_ENV: &str = "OMLX_API_KEY";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRoles {
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub smol: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareEndpoints {
    pub bppc_host: String,
    pub omlx_key: String,
}

/// The pi_prepare command input: everything except the dirs the command fills
/// from the AppHandle and the cwd it takes separately.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareOptions {
    pub roles: PrepareRoles,
    pub endpoints: PrepareEndpoints,
    pub allow_any_dir: bool,
    #[serde(default)]
    pub agent_dir: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PrepareInput {
    pub app_version: String,
    pub template_dir: PathBuf,
    pub app_data_dir: PathBuf,
    pub agent_dir: PathBuf,
    pub cwd: PathBuf,
    pub roles: PrepareRoles,
    pub endpoints: PrepareEndpoints,
    pub allow_any_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrepareStep {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareReport {
    pub steps: Vec<PrepareStep>,
    pub agent_dir: PathBuf,
    pub env: BTreeMap<String, String>,
}

/// One step of the agent's `--json` report. Status is the agent's vocabulary:
/// OK, FAIL or SKIPPED; the last counts as ok for the spawn decision, exactly
/// like the local steps before it.
#[derive(Debug, Deserialize)]
struct AgentStep {
    name: String,
    status: String,
    detail: String,
}

/// The JSON object `agent pi prepare --json` prints on stdout. modelsJson is
/// accepted and ignored: the report names the path, never the rendered body
/// (the key stays in the file, as before).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentReport {
    #[serde(default)]
    steps: Vec<AgentStep>,
    #[serde(default)]
    agent_dir: String,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

/// Prepares a pi session by running the resolved harness agent
/// (`agent pi prepare`) and mapping its JSON report onto PrepareReport, so
/// launcher.log and the frontend keep their shape. A missing agent, a spawn
/// failure or an unreadable report yields one FAIL step named "prepare",
/// never a panic; every other step outcome comes from the agent verbatim.
pub fn prepare_session(input: PrepareInput, agent_bin: Option<&Path>) -> PrepareReport {
    let agent_dir = if input.agent_dir.as_os_str().is_empty() {
        user_agent_dir(&input.app_data_dir)
    } else {
        input.agent_dir.clone()
    };
    let fail = |detail: String| PrepareReport {
        steps: vec![PrepareStep {
            name: "prepare".to_string(),
            ok: false,
            detail,
        }],
        agent_dir: agent_dir.clone(),
        env: report_env(&agent_dir, &input.roles),
    };
    let Some(agent_bin) = agent_bin else {
        return fail(
            "no harness agent binary resolved; install it (bin/pi-fetch style) or set the Agent bin path in Settings > Pi"
                .to_string(),
        );
    };
    match run_agent_prepare(&input, &agent_dir, agent_bin) {
        Ok(report) => report,
        Err(detail) => fail(detail),
    }
}

/// Builds and runs the command line: `agent pi prepare --template T
/// --agent-dir A --cwd C [--version V] [--bppc-host H] [--allow-any-dir]
/// --omlx-key-env OMLX_API_KEY --json`, the oMLX key carried on the child's
/// env only. `--version` (not `--stamp`) reproduces the seed stamp the
/// previous local implementation wrote, `<app version>+<template hash>`, so
/// already-seeded agent dirs are not re-seeded. Blank host or version values
/// are omitted: the agent treats them as unset (LAN default host, bare hash)
/// and its usage parser rejects empty values.
fn run_agent_prepare(
    input: &PrepareInput,
    agent_dir: &Path,
    agent_bin: &Path,
) -> Result<PrepareReport, String> {
    let mut cmd = Command::new(agent_bin);
    cmd.args(["pi", "prepare"]);
    cmd.arg("--template").arg(&input.template_dir);
    cmd.arg("--agent-dir").arg(agent_dir);
    cmd.arg("--cwd").arg(&input.cwd);
    if !input.app_version.trim().is_empty() {
        cmd.arg("--version").arg(&input.app_version);
    }
    if !input.endpoints.bppc_host.trim().is_empty() {
        cmd.arg("--bppc-host").arg(&input.endpoints.bppc_host);
    }
    cmd.arg("--omlx-key-env").arg(OMLX_KEY_ENV);
    if input.allow_any_dir {
        cmd.arg("--allow-any-dir");
    }
    cmd.arg("--json");
    if input.endpoints.omlx_key.trim().is_empty() {
        // A blank key must stay blank: drop any inherited value so the agent
        // reports the gap instead of rendering with a shell's key.
        cmd.env_remove(OMLX_KEY_ENV);
    } else {
        cmd.env(OMLX_KEY_ENV, &input.endpoints.omlx_key);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("cannot run harness agent {}: {e}", agent_bin.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let exit = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
    let parsed: AgentReport = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("harness agent report unreadable (exit {exit}): {e}; stderr: {}", stderr_tail(&stderr)))?;
    let AgentReport {
        steps,
        agent_dir: reported_dir,
        env: agent_env,
    } = parsed;
    if steps.is_empty() {
        return Err(format!(
            "harness agent report carried no steps (exit {exit}); stderr: {}",
            stderr_tail(&stderr)
        ));
    }
    let agent_dir = if reported_dir.is_empty() {
        agent_dir.to_path_buf()
    } else {
        PathBuf::from(reported_dir)
    };
    let mut env = report_env(&agent_dir, &input.roles);
    for (key, value) in agent_env {
        env.insert(key, value);
    }
    Ok(PrepareReport {
        steps: steps
            .into_iter()
            .map(|s| PrepareStep {
                ok: matches!(s.status.as_str(), "OK" | "SKIPPED"),
                name: s.name,
                detail: s.detail,
            })
            .collect(),
        agent_dir,
        env,
    })
}

/// The report env every spawn path consumes: PI_CODING_AGENT_DIR plus the
/// four EFFICIENT_PI_* role values. The agent owns the first (its env echoes
/// it back); roles stay a caller concern.
fn report_env(agent_dir: &Path, roles: &PrepareRoles) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert(
        "PI_CODING_AGENT_DIR".to_string(),
        agent_dir.to_string_lossy().into_owned(),
    );
    env.insert("EFFICIENT_PI_PROVIDER".to_string(), roles.provider.clone());
    env.insert("EFFICIENT_PI_MODEL".to_string(), roles.model.clone());
    env.insert("EFFICIENT_PI_THINKING".to_string(), roles.thinking.clone());
    env.insert("EFFICIENT_PI_SMOL".to_string(), roles.smol.clone());
    env
}

/// Last non-empty stderr line, bounded, for failure details: the agent prints
/// its `[k/4]` progress there, and a refusal or usage error explains itself.
fn stderr_tail(stderr: &str) -> String {
    const MAX: usize = 200;
    let line = stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    if line.chars().count() > MAX {
        let cut: String = line.chars().take(MAX).collect();
        format!("{cut}...")
    } else {
        line.to_string()
    }
}

/// OMLX_KEY default, the same fallback bin/efficient-pi uses when the env
/// carries none: `auth.api_key` from `~/.omlx/settings.json`. None when the
/// file is missing, malformed or the key blank, so the caller fills the gap
/// from the secrets store or leaves the agent's render step to report it.
pub fn omlx_key_default(home: Option<&str>) -> Option<String> {
    let home = home.map(str::trim).filter(|s| !s.is_empty())?;
    let path = Path::new(home).join(".omlx").join("settings.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let key = parsed
        .get("auth")?
        .get("api_key")?
        .as_str()?
        .trim()
        .to_string();
    (!key.is_empty()).then_some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent_dir_sits_under_app_data() {
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(
            user_agent_dir(Path::new("/data")).to_string_lossy(),
            format!("/data{sep}pi-home{sep}agent")
        );
    }

    #[test]
    fn omlx_key_default_reads_the_same_settings_file_as_the_bash_launcher() {
        let home = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(home.path().join(".omlx")).expect("mkdir");
        std::fs::write(
            home.path().join(".omlx").join("settings.json"),
            r#"{"auth": {"api_key": "sk-omlx"}}"#,
        )
        .expect("write");
        let home_str = home.path().to_str().expect("utf8");
        assert_eq!(omlx_key_default(Some(home_str)).as_deref(), Some("sk-omlx"));
        // Whitespace-only keys count as unset, as do blank homes and missing
        // or malformed files: the caller fills the gap or the agent reports it.
        std::fs::write(
            home.path().join(".omlx").join("settings.json"),
            r#"{"auth": {"api_key": "  "}}"#,
        )
        .expect("rewrite");
        assert_eq!(omlx_key_default(Some(home_str)), None);
        let empty = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            omlx_key_default(empty.path().to_str()),
            None,
            "missing file must yield None"
        );
        assert_eq!(omlx_key_default(Some("   ")), None);
        assert_eq!(omlx_key_default(None), None);
    }
}

/// The CLI-mapping tests need a fake agent binary, so they run on Unix only
/// (a shell script stands in for the harness binary in a temp dir).
#[cfg(all(test, unix))]
mod agent_cli_tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    /// Writes a fake agent that records its argv and the OMLX key env into
    /// <dir>/argv.txt, then prints `report` (the --json body) on stdout.
    fn write_fake_agent(dir: &Path, report: &str) -> PathBuf {
        let argv = dir.join("argv.txt");
        let script = "#!/bin/sh\n\
             printf '%s\\n' \"$@\" > {ARGV}\n\
             printf 'OMLX_API_KEY=%s\\n' \"${OMLX_API_KEY-unset}\" >> {ARGV}\n\
             cat <<'JSON'\n{REPORT}\nJSON\n"
            .replace("{ARGV}", &argv.to_string_lossy())
            .replace("{REPORT}", report);
        let path = dir.join("agent");
        fs::write(&path, script).expect("write agent stub");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    fn read_argv(dir: &Path) -> Vec<String> {
        fs::read_to_string(dir.join("argv.txt"))
            .expect("argv record")
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn input(template: &Path, app_data: &Path, cwd: &Path, allow_any_dir: bool) -> PrepareInput {
        PrepareInput {
            app_version: "0.7.3".to_string(),
            template_dir: template.to_path_buf(),
            app_data_dir: app_data.to_path_buf(),
            agent_dir: user_agent_dir(app_data),
            cwd: cwd.to_path_buf(),
            roles: PrepareRoles {
                provider: "bppc".to_string(),
                model: "qwen3.8-27b".to_string(),
                thinking: "xhigh".to_string(),
                smol: "omlx/Qwen3.6-35B-A3B-OptiQ-4bit".to_string(),
            },
            endpoints: PrepareEndpoints {
                bppc_host: "203.0.113.10".to_string(),
                omlx_key: "sk-omlx".to_string(),
            },
            allow_any_dir,
        }
    }

    #[test]
    fn prepare_session_maps_the_agent_cli_json_and_builds_the_expected_command() {
        let scratch = tempfile::tempdir().expect("tempdir");
        let app_data = tempfile::tempdir().expect("tempdir");
        let template = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        let agent_dir = user_agent_dir(app_data.path());
        let report = serde_json::json!({
            "steps": [
                {"name": "seed", "status": "OK",
                 "detail": format!("seeded {}: 3 created, 0 updated, 0 kept", agent_dir.display())},
                {"name": "render", "status": "SKIPPED",
                 "detail": "models.json unchanged (bppc host 203.0.113.10)"},
                {"name": "root", "status": "FAIL",
                 "detail": format!("{} has no .git, CLAUDE.md, AGENTS.md, or wiki/", project.path().display())},
                {"name": "wiki", "status": "OK", "detail": "wiki files present"},
            ],
            "agentDir": agent_dir.to_string_lossy(),
            "modelsJson": agent_dir.join("models.json").to_string_lossy(),
            "env": {"PI_CODING_AGENT_DIR": agent_dir.to_string_lossy()},
        })
        .to_string();
        let agent = write_fake_agent(scratch.path(), &report);
        let got = prepare_session(
            input(template.path(), app_data.path(), project.path(), false),
            Some(&agent),
        );
        // The exact command line each caller builds: verb, dirs, version stamp
        // prefix, endpoint host, key env name, then --json.
        assert_eq!(
            read_argv(scratch.path()),
            vec![
                "pi".to_string(),
                "prepare".to_string(),
                "--template".to_string(),
                template.path().to_string_lossy().into_owned(),
                "--agent-dir".to_string(),
                agent_dir.to_string_lossy().into_owned(),
                "--cwd".to_string(),
                project.path().to_string_lossy().into_owned(),
                "--version".to_string(),
                "0.7.3".to_string(),
                "--bppc-host".to_string(),
                "203.0.113.10".to_string(),
                "--omlx-key-env".to_string(),
                "OMLX_API_KEY".to_string(),
                "--json".to_string(),
                "OMLX_API_KEY=sk-omlx".to_string(),
            ]
        );
        // Statuses map onto the report: SKIPPED counts as ok, FAIL does not,
        // and details stay the agent's own words.
        let oks: Vec<bool> = got.steps.iter().map(|s| s.ok).collect();
        assert_eq!(oks, vec![true, true, false, true]);
        assert_eq!(
            got.steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["seed", "render", "root", "wiki"]
        );
        assert_eq!(
            got.steps[1].detail,
            "models.json unchanged (bppc host 203.0.113.10)"
        );
        assert_eq!(got.agent_dir, agent_dir);
        assert_eq!(
            got.env.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some(agent_dir.to_str().expect("utf8"))
        );
        assert_eq!(
            got.env.get("EFFICIENT_PI_PROVIDER").map(String::as_str),
            Some("bppc")
        );
        assert_eq!(
            got.env.get("EFFICIENT_PI_MODEL").map(String::as_str),
            Some("qwen3.8-27b")
        );
        assert_eq!(
            got.env.get("EFFICIENT_PI_THINKING").map(String::as_str),
            Some("xhigh")
        );
        assert_eq!(
            got.env.get("EFFICIENT_PI_SMOL").map(String::as_str),
            Some("omlx/Qwen3.6-35B-A3B-OptiQ-4bit")
        );
    }

    #[test]
    fn prepare_session_uses_the_resolved_agent_dir() {
        let scratch = tempfile::tempdir().expect("tempdir");
        let app_data = tempfile::tempdir().expect("app data");
        let template = tempfile::tempdir().expect("template");
        let project = tempfile::tempdir().expect("project");
        let custom = tempfile::tempdir().expect("custom agent");
        let custom_dir = custom.path().join("agent");
        let report = serde_json::json!({
            "steps": [{"name": "seed", "status": "OK", "detail": "seeded"}],
            "agentDir": custom_dir.to_string_lossy(),
            "env": {"PI_CODING_AGENT_DIR": custom_dir.to_string_lossy()}
        })
        .to_string();
        let agent = write_fake_agent(scratch.path(), &report);
        let mut input = input(template.path(), app_data.path(), project.path(), false);
        input.agent_dir = custom_dir.clone();
        let got = prepare_session(input, Some(&agent));
        assert_eq!(got.agent_dir, custom_dir);
        assert_eq!(
            read_argv(scratch.path())
                .windows(2)
                .find(|pair| pair[0] == "--agent-dir")
                .map(|pair| pair[1].as_str()),
            custom_dir.to_str()
        );
        assert_ne!(got.agent_dir, user_agent_dir(app_data.path()));
    }

    #[test]
    fn prepare_session_allow_any_dir_flag_and_blank_key_stays_blank_on_the_child() {
        let scratch = tempfile::tempdir().expect("tempdir");
        let app_data = tempfile::tempdir().expect("tempdir");
        let template = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        let agent_dir = user_agent_dir(app_data.path());
        let report = serde_json::json!({
            "steps": [
                {"name": "root", "status": "SKIPPED",
                 "detail": format!("root guard skipped (--allow-any-dir): {}", project.path().display())},
            ],
            "agentDir": agent_dir.to_string_lossy(),
            "env": {},
        })
        .to_string();
        let agent = write_fake_agent(scratch.path(), &report);
        let mut inp = input(template.path(), app_data.path(), project.path(), true);
        inp.endpoints.omlx_key = "   ".to_string();
        inp.app_version = String::new();
        let got = prepare_session(inp, Some(&agent));
        // The skipped guard is ok for the spawn decision, like the local
        // implementation's (any dir allowed) step was.
        assert_eq!(got.steps.len(), 1);
        assert!(got.steps[0].ok, "{}", got.steps[0].detail);
        let argv = read_argv(scratch.path());
        assert!(argv.contains(&"--allow-any-dir".to_string()), "argv: {argv:?}");
        // Blank endpoint key: the var is removed from the child env, so the
        // agent's own fallback and failure message apply.
        assert!(
            argv.contains(&"OMLX_API_KEY=unset".to_string()),
            "argv: {argv:?}"
        );
        // An empty version or host value is omitted, never passed as "".
        assert!(!argv.contains(&"--version".to_string()), "argv: {argv:?}");
    }

    #[test]
    fn prepare_session_missing_agent_binary_yields_a_fail_step_not_a_panic() {
        let app_data = tempfile::tempdir().expect("tempdir");
        let template = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        for agent_bin in [
            None,
            Some(Path::new("/no/such/harness-agent-for-terax-tests")),
        ] {
            let got = prepare_session(
                input(template.path(), app_data.path(), project.path(), false),
                agent_bin,
            );
            assert_eq!(got.steps.len(), 1, "one FAIL step for {agent_bin:?}");
            assert!(!got.steps[0].ok);
            assert_eq!(got.steps[0].name, "prepare");
            assert!(got.steps[0].detail.contains("agent"), "{}", got.steps[0].detail);
            assert_eq!(got.agent_dir, user_agent_dir(app_data.path()));
            assert_eq!(
                got.env.get("PI_CODING_AGENT_DIR").map(String::as_str),
                Some(user_agent_dir(app_data.path()).to_str().expect("utf8"))
            );
            assert_eq!(got.env.len(), 5, "report env keeps its shape");
        }
    }

    #[test]
    fn prepare_session_unreadable_agent_report_yields_a_fail_step() {
        let scratch = tempfile::tempdir().expect("tempdir");
        let app_data = tempfile::tempdir().expect("tempdir");
        let template = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        let agent = write_fake_agent(scratch.path(), "this is not json");
        let got = prepare_session(
            input(template.path(), app_data.path(), project.path(), false),
            Some(&agent),
        );
        assert_eq!(got.steps.len(), 1);
        assert!(!got.steps[0].ok);
        assert!(got.steps[0].detail.contains("report unreadable"), "{}", got.steps[0].detail);
    }
}

//! Local steps of the bash launcher (bin/efficient-pi steps 5 and 8, plus
//! bin/wiki-init and bin/pi-render-models) as pure functions, so a pi session
//! can be prepared on macOS, Linux and Windows without bash. Health probes of
//! bppc and oMLX stay out of this unit; the caller composes them separately.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Agent dir inside the app data dir: a writable per-user copy of the bundled
/// read-only template (resources/pi-home/agent).
pub fn user_agent_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("pi-home").join("agent")
}

/// Entries the app owns in the agent dir; everything else (auth.json,
/// models.json, mcp.json, sessions/, logs/, wiki/, agent-hub/,
/// tool-output-artifacts/) belongs to the user or the runtime and is never
/// written by the seed.
const MANAGED_FILES: &[&str] = &[
    "AGENTS.md",
    "settings.json",
    "settings.README.md",
    "models.json.tmpl",
];
const MANAGED_DIRS: &[&str] = &["agents", "extensions", "prompts", "skills"];
const SEED_STAMP_FILE: &str = ".terax-seed";

#[derive(Debug, Default, Clone)]
pub struct SeedReport {
    /// Managed entries that did not exist in dest and were copied.
    pub created: Vec<String>,
    /// Managed entries that existed but differed and were re-copied.
    pub updated: Vec<String>,
    /// Managed entries already identical to the template, left untouched.
    pub kept: Vec<String>,
}

impl SeedReport {
    fn is_empty(&self) -> bool {
        self.created.is_empty() && self.updated.is_empty() && self.kept.is_empty()
    }
}

/// FNV-1a 64-bit: tiny, dependency-free, stable across platforms; good enough
/// to detect template drift between app versions.
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv1a(hash: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *hash ^= u64::from(b);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}

/// Stamp stored in dest/.terax-seed: the app version plus a content hash of
/// the managed template entries, so an app update with new templates re-seeds
/// while identical templates keep the user agent dir untouched.
pub fn template_stamp(app_version: &str, template: &Path) -> String {
    let mut hash = FNV_OFFSET;
    for name in MANAGED_FILES {
        hash_entry(&mut hash, template, Path::new(name));
    }
    for name in MANAGED_DIRS {
        hash_entry(&mut hash, template, Path::new(name));
    }
    format!("{app_version}+{hash:016x}")
}

fn hash_entry(hash: &mut u64, template: &Path, rel: &Path) {
    let full = template.join(rel);
    if full.is_dir() {
        let mut children: Vec<PathBuf> = match fs::read_dir(&full) {
            Ok(entries) => entries.filter_map(Result::ok).map(|e| e.path()).collect(),
            Err(_) => {
                fnv1a(hash, b"<missing-dir>\0");
                return;
            }
        };
        children.sort();
        for child in children {
            let child_rel = rel.join(child.file_name().unwrap_or_default());
            hash_entry(hash, template, &child_rel);
        }
    } else {
        fnv1a(hash, rel.to_string_lossy().as_bytes());
        fnv1a(hash, b"\0");
        match fs::read(&full) {
            Ok(bytes) => fnv1a(hash, &bytes),
            Err(_) => fnv1a(hash, b"<missing>"),
        }
    }
}

/// First run copies the whole managed template; later runs re-copy only when
/// the stamp differs, and then only the managed set. User files are never
/// touched. The stamp is written last, so a crash mid-seed leaves the old
/// stamp behind and the next run re-seeds.
pub fn seed_agent_dir(template: &Path, dest: &Path, stamp: &str) -> io::Result<SeedReport> {
    if fs::read_to_string(dest.join(SEED_STAMP_FILE)).is_ok_and(|s| s == stamp) {
        return Ok(SeedReport::default());
    }
    if !template.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("agent dir template not found: {}", template.display()),
        ));
    }
    fs::create_dir_all(dest)?;
    let mut report = SeedReport::default();
    for name in MANAGED_FILES {
        seed_file(template, dest, name, &mut report)?;
    }
    for name in MANAGED_DIRS {
        seed_dir(template, dest, name, &mut report)?;
    }
    fs::write(dest.join(SEED_STAMP_FILE), stamp)?;
    Ok(report)
}

fn seed_file(template: &Path, dest: &Path, name: &str, report: &mut SeedReport) -> io::Result<()> {
    let src = template.join(name);
    if !src.is_file() {
        return Ok(());
    }
    let dst = dest.join(name);
    let content = fs::read(&src)?;
    let existed = dst.exists();
    if existed && fs::read(&dst).is_ok_and(|d| d == content) {
        report.kept.push(name.to_string());
        return Ok(());
    }
    copy_file(&src, &dst)?;
    if existed {
        report.updated.push(name.to_string());
    } else {
        report.created.push(name.to_string());
    }
    Ok(())
}

fn seed_dir(template: &Path, dest: &Path, name: &str, report: &mut SeedReport) -> io::Result<()> {
    let src = template.join(name);
    if !src.is_dir() {
        return Ok(());
    }
    let mut files = Vec::new();
    collect_files(&src, Path::new(""), &mut files)?;
    files.sort();
    let dst_root = dest.join(name);
    if !dst_root.is_dir() {
        fs::create_dir_all(&dst_root)?;
        for rel in &files {
            copy_file(&src.join(rel), &dst_root.join(rel))?;
        }
        report.created.push(format!("{name}/"));
        return Ok(());
    }
    let mut stale = Vec::new();
    for rel in &files {
        let src_path = src.join(rel);
        let dst_path = dst_root.join(rel);
        match (fs::read(&src_path), fs::read(&dst_path)) {
            (Ok(s), Ok(d)) if s == d => {}
            (Ok(s), _) => stale.push((src_path, dst_path, s)),
            (Err(e), _) => return Err(e),
        }
    }
    if stale.is_empty() {
        report.kept.push(format!("{name}/"));
        return Ok(());
    }
    for (src_path, dst_path, _) in stale {
        copy_file(&src_path, &dst_path)?;
    }
    report.updated.push(format!("{name}/"));
    Ok(())
}

/// Copies while preserving the source permissions (skills carry scripts).
fn copy_file(src: &Path, dst: &Path) -> io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, dst).map(|_| ())
}

fn collect_files(root: &Path, rel: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(root.join(rel))? {
        let entry = entry?;
        let child = rel.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            collect_files(root, &child, out)?;
        } else {
            out.push(child);
        }
    }
    Ok(())
}

/// Placeholders from bin/pi-render-models: the bppc LAN host varies by
/// network and the oMLX key is secret.
const BPPC_HOST_PLACEHOLDER: &str = "__BPPC_HOST__";
const OMLX_KEY_PLACEHOLDER: &str = "__OMLX_KEY__";
/// Blank host: the local machine, so a fresh install never points at another box.
const BPPC_HOST_LAN: &str = "127.0.0.1";

/// Same substitution as bin/pi-render-models: replaces every placeholder with
/// the given values, byte for byte (no sed escaping involved).
pub fn render_models_json(tmpl: &str, bppc_host: &str, omlx_key: &str) -> String {
    tmpl.replace(BPPC_HOST_PLACEHOLDER, bppc_host)
        .replace(OMLX_KEY_PLACEHOLDER, omlx_key)
}

/// Writes <agent_dir>/models.json only when the rendered content differs from
/// what is on disk; returns whether it wrote.
pub fn write_models_json(agent_dir: &Path, content: &str) -> io::Result<bool> {
    let path = agent_dir.join("models.json");
    if fs::read(&path).is_ok_and(|d| d.as_slice() == content.as_bytes()) {
        return Ok(false);
    }
    fs::create_dir_all(agent_dir)?;
    fs::write(&path, content)?;
    Ok(true)
}

/// Wiki skeleton files written by bin/wiki-init. Byte-equal to the script's
/// heredocs (the em-dashes are its output, spelled as escapes here).
const WIKI_INDEX: &str = "# Wiki Index
- [active-work.md](active-work.md) \u{2014} current workstreams, status, next steps
- [decisions.md](decisions.md) \u{2014} choices made, rejected options, why
- [log.md](log.md) \u{2014} dated session journal (grep it, never read wholesale)
";
const WIKI_ACTIVE_WORK: &str = "# Active Work\n\n(no open workstreams)\n";
const WIKI_DECISIONS: &str = "# Decisions\n";
const WIKI_LOG: &str = "# Wiki Log\n";

const WIKI_FILES: &[(&str, &str)] = &[
    ("index.md", WIKI_INDEX),
    ("active-work.md", WIKI_ACTIVE_WORK),
    ("decisions.md", WIKI_DECISIONS),
    ("log.md", WIKI_LOG),
];

/// Port of bin/wiki-init: creates wiki/index.md, active-work.md, decisions.md
/// and log.md under the project root, each only when missing, and returns the
/// files it created.
pub fn wiki_init(project_root: &Path) -> io::Result<Vec<PathBuf>> {
    let wiki = project_root.join("wiki");
    fs::create_dir_all(&wiki)?;
    let mut created = Vec::new();
    for (name, body) in WIKI_FILES {
        let path = wiki.join(name);
        if path.exists() {
            continue;
        }
        fs::write(&path, body)?;
        created.push(path);
    }
    Ok(created)
}

/// Step-8 project-root guard from bin/efficient-pi: the cwd must look like a
/// project (.git of any kind, CLAUDE.md, AGENTS.md, or wiki/). The Err text
/// mirrors the launcher's refusal message.
pub fn project_root_check(cwd: &Path) -> Result<(), String> {
    let is_root = cwd.join(".git").exists()
        || cwd.join("CLAUDE.md").is_file()
        || cwd.join("AGENTS.md").is_file()
        || cwd.join("wiki").is_dir();
    if is_root {
        Ok(())
    } else {
        Err(format!(
            "{} has no .git, CLAUDE.md, AGENTS.md, or wiki/; run from inside a project directory or allow any dir",
            cwd.display()
        ))
    }
}

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
}

#[derive(Debug, Clone)]
pub struct PrepareInput {
    pub app_version: String,
    pub template_dir: PathBuf,
    pub app_data_dir: PathBuf,
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

/// Composes seed, render, root guard and wiki init in launcher step order.
/// Every step reports its own outcome; a failed step never aborts the rest,
/// so the frontend sees the full picture in one round-trip.
pub fn prepare_session(input: PrepareInput) -> PrepareReport {
    let agent_dir = user_agent_dir(&input.app_data_dir);
    let mut steps = Vec::new();

    let stamp = template_stamp(&input.app_version, &input.template_dir);
    steps.push(match seed_agent_dir(&input.template_dir, &agent_dir, &stamp) {
        Ok(report) if report.is_empty() => PrepareStep {
            name: "seed".to_string(),
            ok: true,
            detail: format!("agent dir ready at {}", agent_dir.display()),
        },
        Ok(report) => PrepareStep {
            name: "seed".to_string(),
            ok: true,
            detail: format!(
                "seeded {}: {} created, {} updated, {} kept",
                agent_dir.display(),
                report.created.len(),
                report.updated.len(),
                report.kept.len()
            ),
        },
        Err(e) => PrepareStep {
            name: "seed".to_string(),
            ok: false,
            detail: e.to_string(),
        },
    });

    steps.push(render_step(&agent_dir, &input.endpoints));

    steps.push(if input.allow_any_dir {
        PrepareStep {
            name: "root".to_string(),
            ok: true,
            detail: format!("project root: {} (any dir allowed)", input.cwd.display()),
        }
    } else {
        match project_root_check(&input.cwd) {
            Ok(()) => PrepareStep {
                name: "root".to_string(),
                ok: true,
                detail: format!("project root: {}", input.cwd.display()),
            },
            Err(msg) => PrepareStep {
                name: "root".to_string(),
                ok: false,
                detail: msg,
            },
        }
    });

    steps.push(match wiki_init(&input.cwd) {
        Ok(created) if created.is_empty() => PrepareStep {
            name: "wiki".to_string(),
            ok: true,
            detail: "wiki files present".to_string(),
        },
        Ok(created) => {
            let names = created
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            PrepareStep {
                name: "wiki".to_string(),
                ok: true,
                detail: format!("created {names}"),
            }
        }
        Err(e) => PrepareStep {
            name: "wiki".to_string(),
            ok: false,
            detail: e.to_string(),
        },
    });

    let mut env = BTreeMap::new();
    env.insert(
        "PI_CODING_AGENT_DIR".to_string(),
        agent_dir.to_string_lossy().into_owned(),
    );
    env.insert("EFFICIENT_PI_PROVIDER".to_string(), input.roles.provider);
    env.insert("EFFICIENT_PI_MODEL".to_string(), input.roles.model);
    env.insert("EFFICIENT_PI_THINKING".to_string(), input.roles.thinking);
    env.insert("EFFICIENT_PI_SMOL".to_string(), input.roles.smol);

    PrepareReport {
        steps,
        agent_dir,
        env,
    }
}

/// Step 5: render pi-home/agent/models.json from the seeded template. A blank
/// oMLX key fails like bin/pi-render-models; a blank bppc host falls back to
/// the script's LAN default.
fn render_step(agent_dir: &Path, endpoints: &PrepareEndpoints) -> PrepareStep {
    let name = "render".to_string();
    let tmpl_path = agent_dir.join("models.json.tmpl");
    let tmpl = match fs::read_to_string(&tmpl_path) {
        Ok(t) => t,
        Err(e) => {
            return PrepareStep {
                name,
                ok: false,
                detail: format!("cannot read {}: {e}", tmpl_path.display()),
            };
        }
    };
    if endpoints.omlx_key.trim().is_empty() {
        return PrepareStep {
            name,
            ok: false,
            detail: "OMLX_KEY not set; cannot render models.json".to_string(),
        };
    }
    let host = if endpoints.bppc_host.trim().is_empty() {
        BPPC_HOST_LAN
    } else {
        endpoints.bppc_host.as_str()
    };
    let rendered = render_models_json(&tmpl, host, &endpoints.omlx_key);
    match write_models_json(agent_dir, &rendered) {
        Ok(true) => PrepareStep {
            name,
            ok: true,
            detail: format!("wrote models.json (bppc host {host})"),
        },
        Ok(false) => PrepareStep {
            name,
            ok: true,
            detail: format!("models.json unchanged (bppc host {host})"),
        },
        Err(e) => PrepareStep {
            name,
            ok: false,
            detail: e.to_string(),
        },
    }
}

/// OMLX_KEY default, the same fallback bin/efficient-pi uses when the env
/// carries none: `auth.api_key` from `~/.omlx/settings.json`. None when the
/// file is missing, malformed or the key blank, so render_step's own failure
/// message reports the gap.
pub fn omlx_key_default(home: Option<&str>) -> Option<String> {
    let home = home.map(str::trim).filter(|s| !s.is_empty())?;
    let path = Path::new(home).join(".omlx").join("settings.json");
    let raw = fs::read_to_string(path).ok()?;
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

    struct Template {
        dir: tempfile::TempDir,
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(path, content).expect("write");
    }

    fn template() -> Template {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write(&root.join("AGENTS.md"), "# agent\n");
        write(&root.join("settings.json"), "{}\n");
        write(&root.join("settings.README.md"), "docs\n");
        write(
            &root.join("models.json.tmpl"),
            r#"{"baseUrl": "http://__BPPC_HOST__:8080/v1", "apiKey": "__OMLX_KEY__"}"#,
        );
        write(&root.join("agents/worker.md"), "# worker\n");
        write(&root.join("extensions/board.mjs"), "export {};\n");
        write(&root.join("prompts/brief.md"), "# brief\n");
        write(&root.join("skills/dev/SKILL.md"), "# dev\n");
        Template { dir }
    }

    fn managed_entry_names() -> Vec<String> {
        let mut names: Vec<String> = MANAGED_FILES
            .iter()
            .map(|s| s.to_string())
            .chain(MANAGED_DIRS.iter().map(|s| format!("{s}/")))
            .collect();
        names.sort();
        names
    }

    fn seed_report_names(report: &SeedReport) -> Vec<String> {
        let mut names = report.created.clone();
        names.extend(report.updated.iter().cloned());
        names.extend(report.kept.iter().cloned());
        names.sort();
        names
    }

    #[test]
    fn user_agent_dir_sits_under_app_data() {
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(
            user_agent_dir(Path::new("/data")).to_string_lossy(),
            format!("/data{sep}pi-home{sep}agent")
        );
    }

    #[test]
    fn seed_first_run_copies_everything_and_writes_the_stamp() {
        let tmpl = template();
        let dest = tempfile::tempdir().expect("tempdir");
        let report = seed_agent_dir(tmpl.dir.path(), dest.path(), "v1+abc").expect("seed");
        assert_eq!(seed_report_names(&report), managed_entry_names());
        assert!(report.kept.is_empty());
        assert_eq!(
            fs::read_to_string(dest.path().join(".terax-seed")).expect("stamp"),
            "v1+abc"
        );
        assert_eq!(
            fs::read_to_string(dest.path().join("AGENTS.md")).expect("agents.md"),
            "# agent\n"
        );
        assert_eq!(
            fs::read_to_string(dest.path().join("skills/dev/SKILL.md")).expect("skill"),
            "# dev\n"
        );
    }

    #[test]
    fn seed_second_run_with_same_stamp_changes_nothing() {
        let tmpl = template();
        let dest = tempfile::tempdir().expect("tempdir");
        let stamp = template_stamp("1.2.3", tmpl.dir.path());
        seed_agent_dir(tmpl.dir.path(), dest.path(), &stamp).expect("first seed");
        let agents_before = fs::read(dest.path().join("AGENTS.md")).expect("read");
        let report = seed_agent_dir(tmpl.dir.path(), dest.path(), &stamp).expect("second seed");
        assert!(report.is_empty(), "same stamp must be a no-op");
        assert_eq!(fs::read(dest.path().join("AGENTS.md")).expect("read"), agents_before);
    }

    #[test]
    fn changed_stamp_recopies_modified_prompt_and_keeps_auth_json() {
        let tmpl = template();
        let dest = tempfile::tempdir().expect("tempdir");
        seed_agent_dir(tmpl.dir.path(), dest.path(), "v1").expect("first seed");
        write(&dest.path().join("auth.json"), r#"{"bppc":"secret"}"#);
        write(&tmpl.dir.path().join("prompts/brief.md"), "# brief v2\n");
        let report = seed_agent_dir(tmpl.dir.path(), dest.path(), "v2").expect("re-seed");
        assert_eq!(report.updated, vec!["prompts/".to_string()]);
        assert!(report.created.is_empty(), "nothing new on re-seed");
        assert_eq!(
            fs::read_to_string(dest.path().join("prompts/brief.md")).expect("prompt"),
            "# brief v2\n"
        );
        assert_eq!(
            fs::read_to_string(dest.path().join("auth.json")).expect("auth"),
            r#"{"bppc":"secret"}"#
        );
        assert_eq!(
            fs::read_to_string(dest.path().join(".terax-seed")).expect("stamp"),
            "v2"
        );
    }

    #[test]
    fn template_stamp_tracks_app_version_and_template_content() {
        let tmpl = template();
        let a = template_stamp("1.0.0", tmpl.dir.path());
        let b = template_stamp("1.0.1", tmpl.dir.path());
        let c = {
            write(&tmpl.dir.path().join("prompts/ticket.md"), "# ticket\n");
            template_stamp("1.0.0", tmpl.dir.path())
        };
        assert_ne!(a, b, "version must be part of the stamp");
        assert_ne!(a, c, "template drift must change the stamp");
        assert!(a.starts_with("1.0.0+"));
    }

    #[test]
    fn render_substitutes_both_placeholders() {
        let out = render_models_json(
            r#"{"baseUrl": "http://__BPPC_HOST__:8080/v1", "apiKey": "__OMLX_KEY__"}"#,
            "100.1.2.3",
            "sk-test",
        );
        assert_eq!(
            out,
            r#"{"baseUrl": "http://100.1.2.3:8080/v1", "apiKey": "sk-test"}"#
        );
    }

    #[test]
    fn write_models_json_skips_identical_content() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(
            write_models_json(dir.path(), "{}").expect("write"),
            "first write lands"
        );
        let first = fs::read(dir.path().join("models.json")).expect("read");
        assert!(
            !write_models_json(dir.path(), "{}").expect("second write"),
            "identical content must not rewrite"
        );
        assert_eq!(fs::read(dir.path().join("models.json")).expect("read"), first);
        assert!(
            write_models_json(dir.path(), "[]").expect("third write"),
            "changed content rewrites"
        );
    }

    #[test]
    fn wiki_init_creates_only_missing_files() {
        let project = tempfile::tempdir().expect("tempdir");
        let first = wiki_init(project.path()).expect("wiki init");
        assert_eq!(first.len(), 4, "all four files created on a fresh project");
        for path in &first {
            assert!(path.exists(), "{} must exist", path.display());
        }
        assert_eq!(
            fs::read_to_string(project.path().join("wiki/index.md")).expect("index"),
            "# Wiki Index\n- [active-work.md](active-work.md) \u{2014} current workstreams, status, next steps\n- [decisions.md](decisions.md) \u{2014} choices made, rejected options, why\n- [log.md](log.md) \u{2014} dated session journal (grep it, never read wholesale)\n"
        );
        write(&project.path().join("wiki/decisions.md"), "user edits\n");
        let second = wiki_init(project.path()).expect("wiki init again");
        assert!(
            second.is_empty(),
            "no file may be overwritten once it exists"
        );
        assert_eq!(
            fs::read_to_string(project.path().join("wiki/decisions.md")).expect("decisions"),
            "user edits\n"
        );
    }

    #[test]
    fn wiki_templates_are_byte_equal_to_bin_wiki_init() {
        let expected: Vec<(&str, &str)> = vec![
            (
                "index.md",
                "# Wiki Index\n- [active-work.md](active-work.md) \u{2014} current workstreams, status, next steps\n- [decisions.md](decisions.md) \u{2014} choices made, rejected options, why\n- [log.md](log.md) \u{2014} dated session journal (grep it, never read wholesale)\n",
            ),
            ("active-work.md", "# Active Work\n\n(no open workstreams)\n"),
            ("decisions.md", "# Decisions\n"),
            ("log.md", "# Wiki Log\n"),
        ];
        for ((name, body), (expected_name, expected_body)) in WIKI_FILES.iter().zip(expected.iter())
        {
            assert_eq!(name, expected_name);
            assert_eq!(body, expected_body);
            assert!(body.ends_with('\n'), "heredocs always end with a newline");
        }
    }

    #[test]
    fn project_root_check_passes_on_markers_and_fails_when_empty() {
        let project = tempfile::tempdir().expect("tempdir");
        write(&project.path().join("CLAUDE.md"), "x\n");
        assert!(project_root_check(project.path()).is_ok());
        let git_project = tempfile::tempdir().expect("tempdir");
        fs::create_dir(git_project.path().join(".git")).expect("gitdir");
        assert!(project_root_check(git_project.path()).is_ok());
        let empty = tempfile::tempdir().expect("tempdir");
        let err = project_root_check(empty.path()).expect_err("empty dir must fail");
        assert!(err.contains(".git"));
        assert!(err.contains(empty.path().to_str().expect("utf8")));
    }

    #[test]
    fn prepare_session_runs_end_to_end_on_a_temp_project() {
        let tmpl = template();
        let app_data = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        fs::create_dir(project.path().join(".git")).expect("gitdir");
        let report = prepare_session(PrepareInput {
            app_version: "0.7.3".to_string(),
            template_dir: tmpl.dir.path().to_path_buf(),
            app_data_dir: app_data.path().to_path_buf(),
            cwd: project.path().to_path_buf(),
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
            allow_any_dir: false,
        });
        assert_eq!(
            report.steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["seed", "render", "root", "wiki"]
        );
        for step in &report.steps {
            assert!(step.ok, "step {} failed: {}", step.name, step.detail);
        }
        assert_eq!(
            report.agent_dir,
            app_data.path().join("pi-home").join("agent")
        );
        assert_eq!(
            report.env.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some(report.agent_dir.to_str().expect("utf8"))
        );
        assert_eq!(
            report.env.get("EFFICIENT_PI_PROVIDER").map(String::as_str),
            Some("bppc")
        );
        assert_eq!(
            report.env.get("EFFICIENT_PI_MODEL").map(String::as_str),
            Some("qwen3.8-27b")
        );
        assert_eq!(
            report.env.get("EFFICIENT_PI_THINKING").map(String::as_str),
            Some("xhigh")
        );
        assert_eq!(
            report.env.get("EFFICIENT_PI_SMOL").map(String::as_str),
            Some("omlx/Qwen3.6-35B-A3B-OptiQ-4bit")
        );
        assert_eq!(
            fs::read_to_string(report.agent_dir.join("models.json")).expect("models.json"),
            r#"{"baseUrl": "http://203.0.113.10:8080/v1", "apiKey": "sk-omlx"}"#
        );
        assert!(report.agent_dir.join("AGENTS.md").is_file());
        assert!(report.agent_dir.join(".terax-seed").is_file());
        assert!(project.path().join("wiki/index.md").is_file());
    }

    #[test]
    fn prepare_session_reports_failures_per_step_without_aborting() {
        let app_data = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        let report = prepare_session(PrepareInput {
            app_version: "0.7.3".to_string(),
            template_dir: app_data.path().join("no-such-template"),
            app_data_dir: app_data.path().to_path_buf(),
            cwd: project.path().to_path_buf(),
            roles: PrepareRoles {
                provider: "bppc".to_string(),
                model: "m".to_string(),
                thinking: "xhigh".to_string(),
                smol: "omlx/s".to_string(),
            },
            endpoints: PrepareEndpoints {
                bppc_host: String::new(),
                omlx_key: String::new(),
            },
            allow_any_dir: false,
        });
        let by_name = |name: &str| {
            report
                .steps
                .iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("step {name} missing"))
        };
        assert!(!by_name("seed").ok, "missing template must fail seed");
        assert!(!by_name("render").ok, "missing template must fail render");
        assert!(!by_name("root").ok, "empty project must fail the root guard");
        assert!(by_name("wiki").ok, "wiki init still runs");
    }

    #[test]
    fn prepare_session_blank_omlx_key_fails_render_and_allow_any_dir_passes_root() {
        let tmpl = template();
        let app_data = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        let report = prepare_session(PrepareInput {
            app_version: "0.7.3".to_string(),
            template_dir: tmpl.dir.path().to_path_buf(),
            app_data_dir: app_data.path().to_path_buf(),
            cwd: project.path().to_path_buf(),
            roles: PrepareRoles {
                provider: "bppc".to_string(),
                model: "m".to_string(),
                thinking: "xhigh".to_string(),
                smol: "omlx/s".to_string(),
            },
            endpoints: PrepareEndpoints {
                bppc_host: String::new(),
                omlx_key: "  ".to_string(),
            },
            allow_any_dir: true,
        });
        let by_name = |name: &str| {
            report
                .steps
                .iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("step {name} missing"))
        };
        assert!(!by_name("render").ok, "blank key must fail render");
        assert!(by_name("render").detail.contains("OMLX_KEY"));
        assert!(by_name("root").ok, "allow_any_dir skips the guard");
        assert!(by_name("root").detail.contains("any dir"));
    }

    #[test]
    fn prepare_session_render_is_idempotent() {
        let tmpl = template();
        let app_data = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        fs::create_dir(project.path().join(".git")).expect("gitdir");
        let endpoints = PrepareEndpoints {
            bppc_host: "10.0.0.9".to_string(),
            omlx_key: "k".to_string(),
        };
        let roles = PrepareRoles {
            provider: "bppc".to_string(),
            model: "m".to_string(),
            thinking: "xhigh".to_string(),
            smol: "omlx/s".to_string(),
        };
        let make_input = || PrepareInput {
            app_version: "0.7.3".to_string(),
            template_dir: tmpl.dir.path().to_path_buf(),
            app_data_dir: app_data.path().to_path_buf(),
            cwd: project.path().to_path_buf(),
            roles: PrepareRoles {
                provider: roles.provider.clone(),
                model: roles.model.clone(),
                thinking: roles.thinking.clone(),
                smol: roles.smol.clone(),
            },
            endpoints: PrepareEndpoints {
                bppc_host: endpoints.bppc_host.clone(),
                omlx_key: endpoints.omlx_key.clone(),
            },
            allow_any_dir: false,
        };
        let first = prepare_session(make_input());
        let second = prepare_session(make_input());
        let first_render = first.steps.iter().find(|s| s.name == "render").expect("step");
        let second_render = second.steps.iter().find(|s| s.name == "render").expect("step");
        assert!(first_render.detail.starts_with("wrote"));
        assert!(
            second_render.detail.contains("unchanged"),
            "second run must not rewrite models.json: {}",
            second_render.detail
        );
        assert!(
            second
                .steps
                .iter()
                .find(|s| s.name == "seed")
                .expect("step")
                .detail
                .starts_with("agent dir ready"),
            "same stamp must be a no-op seed"
        );
    }

    #[test]
    fn omlx_key_default_reads_the_same_settings_file_as_the_bash_launcher() {
        let home = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(home.path().join(".omlx")).expect("mkdir");
        fs::write(
            home.path().join(".omlx").join("settings.json"),
            r#"{"auth": {"api_key": "sk-omlx"}}"#,
        )
        .expect("write");
        let home_str = home.path().to_str().expect("utf8");
        assert_eq!(omlx_key_default(Some(home_str)).as_deref(), Some("sk-omlx"));
        // Whitespace-only keys count as unset, as do blank homes and missing
        // or malformed files: render_step then reports the gap itself.
        fs::write(
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

//! Prompt template listing for the composer slash menu.
//!
//! pi 0.3.0 loads prompt templates from <agent dir>/prompts/*.md and
//! <cwd>/.pi/prompts/*.md (vendor docs/prompt-templates.md "Locations";
//! src/resources.rs load_prompt_templates_with_diagnostics) and expands
//! "/name args" lines itself on the rpc path: the prompt, steer and
//! follow_up handlers run the message through ResourceLoader::expand_input
//! before the turn (vendor src/rpc.rs). The app therefore only lists the
//! templates here; the composer sends the slash line unchanged and pi echoes
//! the expanded body back as the user message.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::modules::workspace::{authorize_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};

/// pi refuses resource files past 1 MiB (vendor src/theme.rs
/// MAX_RESOURCE_FILE_BYTES, applied to prompts via read_resource_file_bounded);
/// the same bound keeps this list aligned with what pi would load.
const MAX_PROMPT_FILE_BYTES: u64 = 1024 * 1024;

/// A listed prompt template: pi's PromptTemplate minus the body. The body
/// stays on disk (philosophy 1); pi reads and expands it at prompt time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromptEntry {
    /// File stem: review.md becomes /review (docs/prompt-templates.md).
    pub name: String,
    /// Front matter description, else the first non-empty body line.
    pub description: String,
    /// Absolute path of the markdown file.
    pub path: String,
    /// "project" (<cwd>/.pi/prompts) or "agent" (<agent dir>/prompts).
    pub source: String,
}

/// Longest description pi derives from a body: the first non-empty line,
/// trimmed, and past 60 chars cut to 57 with a "..." tail (vendor
/// src/resources.rs load_template_from_file). Unlike pi this carries no
/// "(project)"/"(user)" label suffix; the source field serves that.
const DESC_MAX_CHARS: usize = 60;

fn description_from_body(body: &str) -> String {
    let Some(first) = body.lines().find(|line| !line.trim().is_empty()) else {
        return String::new();
    };
    let trimmed = first.trim();
    if trimmed.chars().count() > DESC_MAX_CHARS {
        let head: String = trimmed.chars().take(DESC_MAX_CHARS - 3).collect();
        format!("{head}...")
    } else {
        trimmed.to_string()
    }
}

/// Mirrors pi's parse_frontmatter and parse_frontmatter_lines (vendor
/// src/resources.rs): a raw file whose first line is `---` carries
/// `key: value` front matter until the closing `---`; values are trimmed and
/// stripped of one pair of quotes, blank and `#` lines are skipped, and an
/// unterminated block means no front matter at all (the raw text is the body).
fn parse_frontmatter(raw: &str) -> (HashMap<String, String>, String) {
    let mut lines = raw.lines();
    let Some(first) = lines.next() else {
        return (HashMap::new(), String::new());
    };
    if first.trim() != "---" {
        return (HashMap::new(), raw.to_string());
    }
    let mut front_lines = Vec::new();
    let mut body_lines = Vec::new();
    let mut in_front = true;
    for line in lines {
        if in_front {
            if line.trim() == "---" {
                in_front = false;
            } else {
                front_lines.push(line);
            }
        } else {
            body_lines.push(line);
        }
    }
    if in_front {
        return (HashMap::new(), raw.to_string());
    }
    let mut map = HashMap::new();
    for line in front_lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        map.insert(key.to_string(), value.to_string());
    }
    (map, body_lines.join("\n"))
}

/// Reads one template file into an entry. Files that are unreadable,
/// oversized, non-UTF-8 or stemless are skipped, matching pi's diagnostics
/// path which warns and loads the rest.
fn load_entry(path: &Path, source: &str) -> Option<PromptEntry> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    // take() reads at most MAX + 1 bytes so an oversized file is detected,
    // not silently truncated into a wrong-looking entry.
    file.take(MAX_PROMPT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_PROMPT_FILE_BYTES {
        return None;
    }
    let raw = String::from_utf8(bytes).ok()?;
    let name = path.file_stem()?.to_str()?.to_string();
    let (front, body) = parse_frontmatter(&raw);
    let description = front
        .get("description")
        .filter(|d| !d.is_empty())
        .cloned()
        .unwrap_or_else(|| description_from_body(&body));
    Some(PromptEntry {
        name,
        description,
        path: path.to_string_lossy().into_owned(),
        source: source.to_string(),
    })
}

/// Lists the .md templates in one prompts dir, sorted by path like pi's
/// load_templates_from_dir. A missing or unreadable dir yields nothing:
/// a fresh agent dir ships no prompts until the template seeds one.
fn list_dir(dir: &Path, source: &str) -> Vec<PromptEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    paths
        .iter()
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
        .filter_map(|p| load_entry(p, source))
        .collect()
}

/// Project prompts first, then agent dir prompts, deduped by name keeping the
/// first occurrence (pi loads project before user and dedupe_prompts keeps
/// the first, so a project template wins a name collision), finally sorted by
/// name like pi's list.
pub fn list_prompt_entries(agent_dir: Option<&Path>, cwd: Option<&Path>) -> Vec<PromptEntry> {
    let mut entries = Vec::new();
    if let Some(cwd) = cwd {
        entries.extend(list_dir(&cwd.join(".pi").join("prompts"), "project"));
    }
    if let Some(agent_dir) = agent_dir {
        entries.extend(list_dir(&agent_dir.join("prompts"), "agent"));
    }
    let mut seen = HashSet::new();
    entries.retain(|e| seen.insert(e.name.clone()));
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

/// Slash command list for the composer menu: <agent dir>/prompts plus the
/// project's <cwd>/.pi/prompts. The cwd is workspace-checked like every
/// filesystem surface; the agent dir is authorized the same way (the default
/// seeded copy sits under $HOME, a bootstrap-authorized root). A missing
/// agent dir lists the project prompts only; an existing one outside the
/// authorized workspace is an error.
#[tauri::command]
pub fn pi_prompts_list(
    registry: tauri::State<'_, WorkspaceRegistry>,
    agent_dir: String,
    cwd: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<PromptEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let canonical_cwd = authorize_spawn_cwd(&registry, Some(&cwd), &workspace)?;
    let trimmed = agent_dir.trim();
    let canonical_agent = if trimmed.is_empty() || !Path::new(trimmed).exists() {
        None
    } else {
        Some(
            authorize_spawn_cwd(&registry, Some(trimmed), &workspace)?
                .ok_or_else(|| "agent dir required".to_string())?,
        )
    };
    Ok(list_prompt_entries(
        canonical_agent.as_deref(),
        canonical_cwd.as_deref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(dir: impl AsRef<Path>, name: &str, body: &str) -> PathBuf {
        let dir = dir.as_ref();
        fs::create_dir_all(dir).expect("mkdir");
        let path = dir.join(name);
        fs::write(&path, body).expect("write");
        path
    }

    #[test]
    fn description_falls_back_to_first_body_line_and_truncates() {
        assert_eq!(description_from_body("\n \nReview the diff."), "Review the diff.");
        let long = "a".repeat(70);
        let desc = description_from_body(&long);
        assert_eq!(desc.chars().count(), DESC_MAX_CHARS);
        assert!(desc.ends_with("..."));
        assert_eq!(description_from_body(""), "");
    }

    #[test]
    fn frontmatter_follows_pi_rules() {
        let (front, body) = parse_frontmatter("---\ndescription: \"Go over it\"\n# note\nname: x\n---\nBody $1 here.");
        assert_eq!(front.get("description").map(String::as_str), Some("Go over it"));
        // "name" is not a pi prompt front matter key the loader reads, but the
        // parser keeps it like pi's HashMap does.
        assert_eq!(front.get("name").map(String::as_str), Some("x"));
        assert_eq!(body, "Body $1 here.");

        // No front matter: the raw text is the body.
        let (front, body) = parse_frontmatter("Just a prompt.");
        assert!(front.is_empty());
        assert_eq!(body, "Just a prompt.");

        // Unterminated block: no front matter at all, raw text preserved.
        let (front, body) = parse_frontmatter("---\ndescription: broken");
        assert!(front.is_empty());
        assert_eq!(body, "---\ndescription: broken");
    }

    #[test]
    fn entry_takes_stem_and_frontmatter_description() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "review.md",
            "---\ndescription: Review code\n---\nReview $@.",
        );
        let entry = load_entry(&path, "project").expect("entry");
        assert_eq!(entry.name, "review");
        assert_eq!(entry.description, "Review code");
        assert_eq!(entry.source, "project");
        assert!(entry.path.ends_with("review.md"));
    }

    #[test]
    fn listing_keeps_md_files_only_and_skips_oversize() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "b.md", "Second.");
        write(dir.path(), "a.md", "First.");
        write(dir.path(), "notes.txt", "not a template");
        let big = dir.path().join("big.md");
        fs::write(&big, vec![b'x'; (MAX_PROMPT_FILE_BYTES + 1) as usize]).expect("write");
        let entries = list_dir(dir.path(), "agent");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn project_wins_collision_then_sort_by_name() {
        let agent = tempfile::tempdir().expect("tempdir");
        let project = tempfile::tempdir().expect("tempdir");
        write(agent.path().join("prompts"), "brief.md", "Agent brief.");
        write(agent.path().join("prompts"), "zebra.md", "Agent zebra.");
        write(project.path().join(".pi").join("prompts"), "brief.md", "Project brief.");
        write(project.path().join(".pi").join("prompts"), "alpha.md", "Project alpha.");
        let entries = list_prompt_entries(Some(agent.path()), Some(project.path()));
        let brief = entries.iter().find(|e| e.name == "brief").expect("brief");
        assert_eq!(brief.description, "Project brief.");
        assert_eq!(brief.source, "project");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "brief", "zebra"]);
    }

    #[test]
    fn missing_dirs_yield_nothing() {
        let entries = list_prompt_entries(Some(Path::new("/nonexistent-agent")), None);
        assert!(entries.is_empty());
        assert!(list_prompt_entries(None, None).is_empty());
    }
}

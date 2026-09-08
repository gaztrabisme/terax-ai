//! File-first artifacts and exact answer export (K13).
//!
//! design.md section 3.4 row "Answers and artifacts" and the paragraph
//! beginning "The viewer's authoritative input is always an existing file":
//! an answer's detected HTML or Markdown content becomes a project file
//! under `<project>/.pi/artifacts/<artifact-id>.<ext>` with a record in
//! `.pi/artifacts/index.json`
//! (`{v:1,artifacts:[{id,sessionId,turnId,path,mime,sha256,writerActionId}]}`),
//! and the viewer reads that file back (`pi_read_artifact`) instead of
//! rendering answer text. `Open in editor` writes the answer's exact
//! Markdown to `.pi/answers/<session-id>-<turn-id>.md` and verifies content
//! equality by reading it back before the editor is allowed to open.
//!
//! Writers honor the section 3.4 temp-and-rename contract; errors name the
//! intended path. Hashes come from the shared SHA-256 in attachments.rs.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::attachments::{
    authorized_project_dir, ensure_authorized_subdir, is_filename_safe, sha256_hex, write_durable,
};
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

const ARTIFACTS_DIR: &str = ".pi/artifacts";
const ANSWERS_DIR: &str = ".pi/answers";

fn extension_for_artifact_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "text/html" | "application/xhtml+xml" => Some("html"),
        "image/svg+xml" => Some("svg"),
        "text/markdown" | "text/x-markdown" => Some("md"),
        "text/plain" => Some("txt"),
        _ => None,
    }
}

fn mime_for_extension(extension: &str) -> &'static str {
    match extension {
        "html" | "htm" => "text/html",
        "svg" => "image/svg+xml",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

fn is_text_extension(extension: &str) -> bool {
    matches!(extension, "html" | "htm" | "svg" | "md" | "markdown" | "txt")
}

/// One `.pi/artifacts/index.json` record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    /// Project-relative path of the artifact file.
    pub path: String,
    pub mime: String,
    pub sha256: String,
    /// The action that produced the file, when one is attributed (K12).
    pub writer_action_id: Option<String>,
}

/// The artifact index: `.pi/artifacts/index.json`.
#[derive(Debug, Serialize, Deserialize)]
struct ArtifactIndex {
    v: u32,
    artifacts: Vec<ArtifactRecord>,
}

/// A written artifact file: project-relative path, hash, and whether the
/// existing file already carried exactly this content.
#[derive(Debug, Clone, Serialize)]
pub struct SavedArtifact {
    pub path: String,
    pub sha256: String,
    pub reused: bool,
}

fn read_artifact_index(path: &Path) -> Result<ArtifactIndex, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let index: ArtifactIndex = serde_json::from_str(&text).map_err(|error| {
                format!("malformed artifact index {}: {error}", path.display())
            })?;
            if index.v != 1 {
                return Err(format!(
                    "unsupported artifact index version {} in {}",
                    index.v,
                    path.display()
                ));
            }
            Ok(index)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ArtifactIndex {
            v: 1,
            artifacts: Vec::new(),
        }),
        Err(error) => Err(format!(
            "cannot read artifact index {}: {error}",
            path.display()
        )),
    }
}

fn artifact_file_name(artifact_id: &str, extension: &str) -> String {
    format!("{artifact_id}.{extension}")
}

/// Writes the detected artifact content to
/// `<project>/.pi/artifacts/<artifact-id>.<ext>` and upserts its index
/// record. A file whose on-disk hash already equals the content hash is
/// left untouched (detection re-runs on every transcript change), so the
/// call is idempotent and cheap in the steady state.
#[allow(clippy::too_many_arguments)]
fn write_artifact(
    registry: &WorkspaceRegistry,
    cwd: &str,
    artifact_id: &str,
    session_id: &str,
    turn_id: &str,
    mime: &str,
    content: &str,
    workspace: &WorkspaceEnv,
) -> Result<SavedArtifact, String> {
    if !is_filename_safe(artifact_id) {
        return Err(format!("unsafe artifact id: {artifact_id}"));
    }
    if session_id.trim().is_empty() || turn_id.trim().is_empty() {
        return Err("artifact record needs a session id and a turn id".to_string());
    }
    let extension = extension_for_artifact_mime(mime)
        .ok_or_else(|| format!("unsupported artifact media type: {mime}"))?;
    let bytes = content.as_bytes();
    let sha256 = sha256_hex(bytes);
    let project = authorized_project_dir(registry, cwd, workspace)?;
    let dir = ensure_authorized_subdir(registry, &project, ARTIFACTS_DIR, "artifact")?;
    let file_name = artifact_file_name(artifact_id, extension);
    let target = dir.join(&file_name);

    let mut reused = false;
    match fs::read(&target) {
        Ok(existing) if sha256_hex(&existing) == sha256 => reused = true,
        Ok(_) | Err(_) => write_durable(&target, bytes)?,
    }

    let index_path = dir.join("index.json");
    let mut index = read_artifact_index(&index_path)?;
    let record = ArtifactRecord {
        id: artifact_id.to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        path: format!("{ARTIFACTS_DIR}/{file_name}"),
        mime: mime.trim().to_ascii_lowercase(),
        sha256: sha256.clone(),
        writer_action_id: None,
    };
    match index.artifacts.iter_mut().find(|a| a.id == record.id) {
        Some(existing) => *existing = record,
        None => index.artifacts.push(record),
    }
    let text = serde_json::to_string_pretty(&index)
        .map_err(|error| format!("cannot serialize artifact index: {error}"))?;
    write_durable(&index_path, text.as_bytes())?;

    Ok(SavedArtifact {
        path: format!("{ARTIFACTS_DIR}/{file_name}"),
        sha256,
        reused,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pi_write_artifact(
    cwd: String,
    artifact_id: String,
    session_id: String,
    turn_id: String,
    mime: String,
    content: String,
    workspace: Option<WorkspaceEnv>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<SavedArtifact, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    write_artifact(
        &registry,
        &cwd,
        &artifact_id,
        &session_id,
        &turn_id,
        &mime,
        &content,
        &workspace,
    )
}

/// What the viewer reads back: mime, hash, and the content either as text
/// (html, svg, markdown, text) or as base64 for anything else.
#[derive(Debug, Clone, Serialize)]
pub struct ReadArtifact {
    pub mime: String,
    pub sha256: String,
    pub content: Option<String>,
    pub base64: Option<String>,
}

/// Reads an existing artifact file for the viewer: the authoritative input
/// is the file plus its path and hash. Every failure names the path.
fn read_artifact_file(
    registry: &WorkspaceRegistry,
    cwd: &str,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<ReadArtifact, String> {
    let project: PathBuf = authorized_project_dir(registry, cwd, workspace)?;
    // Project-relative paths resolve against the project root; absolute
    // paths go through the workspace resolver first.
    let resolved = if Path::new(path).is_absolute() {
        resolve_path(path, workspace)
    } else {
        project.join(path)
    };
    let canonical = fs::canonicalize(&resolved)
        .map_err(|error| format!("cannot read artifact {path}: {error}"))?;
    if !canonical.starts_with(&project) || !registry.is_authorized(&canonical) {
        return Err(format!(
            "cannot read artifact {path}: outside the authorized workspace"
        ));
    }
    let bytes = fs::read(&canonical)
        .map_err(|error| format!("cannot read artifact {}: {error}", canonical.display()))?;
    let extension = canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = mime_for_extension(&extension);
    Ok(if is_text_extension(&extension) {
        ReadArtifact {
            mime: mime.to_string(),
            sha256: sha256_hex(&bytes),
            content: Some(String::from_utf8_lossy(&bytes).into_owned()),
            base64: None,
        }
    } else {
        use base64::Engine;
        ReadArtifact {
            mime: mime.to_string(),
            sha256: sha256_hex(&bytes),
            content: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        }
    })
}

#[tauri::command]
pub fn pi_read_artifact(
    cwd: String,
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<ReadArtifact, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    read_artifact_file(&registry, &cwd, &path, &workspace)
}

/// A written answer file: project-relative path plus the exact-content hash.
#[derive(Debug, Clone, Serialize)]
pub struct WrittenAnswer {
    pub path: String,
    pub sha256: String,
}

/// Writes the answer's exact Markdown to
/// `<project>/.pi/answers/<session-id>-<turn-id>.md` and reads it back,
/// refusing to report success when the file's contents differ (design.md:
/// "content equality checked before the editor opens it").
fn write_answer(
    registry: &WorkspaceRegistry,
    cwd: &str,
    session_id: &str,
    turn_id: &str,
    markdown: &str,
    workspace: &WorkspaceEnv,
) -> Result<WrittenAnswer, String> {
    if !is_filename_safe(session_id) {
        return Err(format!("unsafe answer session id: {session_id}"));
    }
    if !is_filename_safe(turn_id) {
        return Err(format!("unsafe answer turn id: {turn_id}"));
    }
    let project = authorized_project_dir(registry, cwd, workspace)?;
    let dir = ensure_authorized_subdir(registry, &project, ANSWERS_DIR, "answers")?;
    let file_name = format!("{session_id}-{turn_id}.md");
    let target = dir.join(&file_name);
    let bytes = markdown.as_bytes();
    write_durable(&target, bytes)?;
    let read_back = fs::read(&target)
        .map_err(|error| format!("cannot verify answer file {}: {error}", target.display()))?;
    if read_back != bytes {
        return Err(format!(
            "answer file {} does not match the answer it was written from",
            target.display()
        ));
    }
    Ok(WrittenAnswer {
        path: format!("{ANSWERS_DIR}/{file_name}"),
        sha256: sha256_hex(bytes),
    })
}

#[tauri::command]
pub fn pi_write_answer(
    cwd: String,
    session_id: String,
    turn_id: String,
    markdown: String,
    workspace: Option<WorkspaceEnv>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<WrittenAnswer, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    write_answer(
        &registry,
        &cwd,
        &session_id,
        &turn_id,
        &markdown,
        &workspace,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn authorized_temp_project() -> (tempfile::TempDir, WorkspaceRegistry) {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry
            .authorize(project.path())
            .expect("authorize project");
        (project, registry)
    }

    #[test]
    fn artifact_mime_map_round_trips_through_extensions() {
        assert_eq!(extension_for_artifact_mime("text/html"), Some("html"));
        assert_eq!(extension_for_artifact_mime("image/svg+xml"), Some("svg"));
        assert_eq!(extension_for_artifact_mime("text/markdown"), Some("md"));
        assert_eq!(extension_for_artifact_mime("application/pdf"), None);
        assert_eq!(mime_for_extension("html"), "text/html");
        assert_eq!(mime_for_extension("svg"), "image/svg+xml");
        assert_eq!(mime_for_extension("md"), "text/markdown");
        assert_eq!(mime_for_extension("png"), "image/png");
    }

    #[test]
    fn write_artifact_creates_the_file_and_its_index_record() {
        let (project, registry) = authorized_temp_project();
        let html = "<html><head><title>P</title></head><body>quartz-lantern</body></html>";

        let saved = write_artifact(
            &registry,
            &path_string(project.path()),
            "art-abc123",
            "session-1",
            "turn-1",
            "text/html",
            html,
            &WorkspaceEnv::Local,
        )
        .expect("artifact write");

        assert_eq!(saved.path, ".pi/artifacts/art-abc123.html");
        assert_eq!(saved.sha256, sha256_hex(html.as_bytes()));
        assert!(!saved.reused);
        let on_disk = fs::read(project.path().join(&saved.path)).expect("artifact file");
        assert_eq!(on_disk, html.as_bytes());

        let text =
            fs::read_to_string(project.path().join(".pi/artifacts/index.json")).expect("index");
        let index: ArtifactIndex = serde_json::from_str(&text).expect("parse index");
        assert_eq!(index.v, 1);
        assert_eq!(index.artifacts.len(), 1);
        assert_eq!(index.artifacts[0].id, "art-abc123");
        assert_eq!(index.artifacts[0].session_id, "session-1");
        assert_eq!(index.artifacts[0].turn_id, "turn-1");
        assert_eq!(index.artifacts[0].path, saved.path);
        assert_eq!(index.artifacts[0].mime, "text/html");
        assert_eq!(index.artifacts[0].sha256, saved.sha256);
        assert_eq!(index.artifacts[0].writer_action_id, None);
    }

    #[test]
    fn write_artifact_is_idempotent_and_updates_changed_content() {
        let (project, registry) = authorized_temp_project();
        let first = write_artifact(
            &registry,
            &path_string(project.path()),
            "art-abc123",
            "session-1",
            "turn-1",
            "text/html",
            "<p>one</p>",
            &WorkspaceEnv::Local,
        )
        .expect("first write");
        let again = write_artifact(
            &registry,
            &path_string(project.path()),
            "art-abc123",
            "session-1",
            "turn-1",
            "text/html",
            "<p>one</p>",
            &WorkspaceEnv::Local,
        )
        .expect("idempotent write");
        assert!(again.reused);
        assert_eq!(again.sha256, first.sha256);

        let changed = write_artifact(
            &registry,
            &path_string(project.path()),
            "art-abc123",
            "session-1",
            "turn-1",
            "text/html",
            "<p>two</p>",
            &WorkspaceEnv::Local,
        )
        .expect("changed write");
        assert!(!changed.reused);
        assert_ne!(changed.sha256, first.sha256);
        let on_disk =
            fs::read(project.path().join(&changed.path)).expect("artifact file");
        assert_eq!(on_disk, b"<p>two</p>");

        // One record per id, not a growing list.
        let text =
            fs::read_to_string(project.path().join(".pi/artifacts/index.json")).expect("index");
        let index: ArtifactIndex = serde_json::from_str(&text).expect("parse index");
        assert_eq!(index.artifacts.len(), 1);
        assert_eq!(index.artifacts[0].sha256, changed.sha256);
    }

    #[test]
    fn write_artifact_rejects_unsafe_ids_and_unknown_mime() {
        let (project, registry) = authorized_temp_project();
        let error = write_artifact(
            &registry,
            &path_string(project.path()),
            "../escape",
            "s",
            "t",
            "text/html",
            "<p></p>",
            &WorkspaceEnv::Local,
        )
        .expect_err("traversal id must be rejected");
        assert!(error.contains("unsafe artifact id"), "{error}");

        let error = write_artifact(
            &registry,
            &path_string(project.path()),
            "art-ok",
            "session-1",
            "turn-1",
            "application/pdf",
            "%PDF",
            &WorkspaceEnv::Local,
        )
        .expect_err("unsupported mime must be rejected");
        assert!(error.contains("unsupported artifact media type"), "{error}");
    }

    #[test]
    fn read_artifact_returns_text_content_and_hash_and_names_missing_paths() {
        let (project, registry) = authorized_temp_project();
        write_artifact(
            &registry,
            &path_string(project.path()),
            "art-abc123",
            "session-1",
            "turn-1",
            "image/svg+xml",
            "<svg><title>cal</title></svg>",
            &WorkspaceEnv::Local,
        )
        .expect("artifact write");

        let read = read_artifact_file(
            &registry,
            &path_string(project.path()),
            ".pi/artifacts/art-abc123.svg",
            &WorkspaceEnv::Local,
        )
        .expect("artifact read");
        assert_eq!(read.mime, "image/svg+xml");
        assert_eq!(
            read.content.as_deref(),
            Some("<svg><title>cal</title></svg>")
        );
        assert!(read.base64.is_none());
        assert_eq!(read.sha256, sha256_hex(b"<svg><title>cal</title></svg>"));

        let error = read_artifact_file(
            &registry,
            &path_string(project.path()),
            ".pi/artifacts/gone.html",
            &WorkspaceEnv::Local,
        )
        .expect_err("missing artifact must be an error");
        assert!(error.contains("cannot read artifact"), "{error}");
        assert!(error.contains("gone.html"), "{error}");
    }

    #[test]
    fn read_artifact_refuses_paths_outside_the_project() {
        let (project, registry) = authorized_temp_project();
        let error = read_artifact_file(
            &registry,
            &path_string(project.path()),
            "../outside.html",
            &WorkspaceEnv::Local,
        )
        .expect_err("traversal path must be rejected");
        assert!(error.contains("cannot read artifact"), "{error}");
    }

    #[test]
    fn write_answer_verifies_content_equality_by_reading_back() {
        let (project, registry) = authorized_temp_project();

        let written = write_answer(
            &registry,
            &path_string(project.path()),
            "sess01ab",
            "turn-42",
            "# exact answer\n\nquartz-lantern",
            &WorkspaceEnv::Local,
        )
        .expect("answer write");

        assert_eq!(written.path, ".pi/answers/sess01ab-turn-42.md");
        assert_eq!(
            written.sha256,
            sha256_hex(b"# exact answer\n\nquartz-lantern")
        );
        let on_disk = fs::read_to_string(project.path().join(&written.path)).expect("answer");
        assert_eq!(on_disk, "# exact answer\n\nquartz-lantern");
    }

    #[test]
    fn write_answer_rejects_unsafe_ids() {
        let (project, registry) = authorized_temp_project();
        let error = write_answer(
            &registry,
            &path_string(project.path()),
            "../session",
            "turn-1",
            "text",
            &WorkspaceEnv::Local,
        )
        .expect_err("traversal session id must be rejected");
        assert!(error.contains("unsafe answer session id"), "{error}");

        let error = write_answer(
            &registry,
            &path_string(project.path()),
            "session-1",
            "turn/1",
            "text",
            &WorkspaceEnv::Local,
        )
        .expect_err("traversal turn id must be rejected");
        assert!(error.contains("unsafe answer turn id"), "{error}");
    }
}

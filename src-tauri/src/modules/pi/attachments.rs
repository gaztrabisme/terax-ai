use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use tauri::State;

use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

const MAX_ATTACHMENT_BYTES: usize = 4 * 1024 * 1024;
const ATTACHMENTS_DIR: &str = ".pi/attachments";

fn extension_for_media_type(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn attachment_file_name(turn: u64, n: u64, extension: &str) -> String {
    format!("{turn}-{n}.{extension}")
}

fn ensure_real_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("attachment directory is a symlink: {}", path.display()))
        }
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(format!("attachment path is not a directory: {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(path) {
                Ok(()) => Ok(()),
                Err(create_error) if create_error.kind() == std::io::ErrorKind::AlreadyExists => {
                    ensure_real_directory(path)
                }
                Err(create_error) => Err(format!(
                    "cannot create attachment directory {}: {create_error}",
                    path.display()
                )),
            }
        }
        Err(error) => Err(format!("cannot inspect {}: {error}", path.display())),
    }
}

fn authorized_project_dir(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<PathBuf, String> {
    let resolved = resolve_path(cwd, workspace);
    let canonical = registry
        .canonicalize_cached(&resolved)
        .map_err(|error| format!("cwd is not accessible: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("cwd is not a directory: {}", canonical.display()));
    }
    if !registry.is_authorized(&canonical) {
        return Err(format!(
            "cwd is outside the authorized workspace: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn write_attachment_file(
    directory: &Path,
    turn: u64,
    start_n: u64,
    extension: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let mut n = start_n;
    loop {
        let file_name = attachment_file_name(turn, n, extension);
        let target = directory.join(&file_name);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                n = n
                    .checked_add(1)
                    .ok_or_else(|| "attachment filename index overflow".to_string())?;
                continue;
            }
            Err(error) => {
                return Err(format!("cannot create {}: {error}", target.display()));
            }
        };

        let result = file.write_all(bytes).and_then(|_| file.sync_all());
        if let Err(error) = result {
            drop(file);
            let _ = fs::remove_file(&target);
            return Err(format!("cannot write {}: {error}", target.display()));
        }
        return Ok(file_name);
    }
}

fn save_attachment(
    registry: &WorkspaceRegistry,
    cwd: &str,
    turn: u64,
    n: u64,
    media_type: &str,
    data: &str,
    workspace: &WorkspaceEnv,
) -> Result<String, String> {
    let extension = extension_for_media_type(media_type)
        .ok_or_else(|| format!("unsupported attachment media type: {media_type}"))?;
    let encoded = data.trim();
    let max_encoded = MAX_ATTACHMENT_BYTES.div_ceil(3) * 4;
    if encoded.len() > max_encoded {
        return Err(format!(
            "attachment exceeds the {} MB image limit",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("invalid attachment base64: {error}"))?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "attachment exceeds the {} MB image limit",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }

    let project = authorized_project_dir(registry, cwd, workspace)?;
    let pi_dir = project.join(".pi");
    ensure_real_directory(&pi_dir)?;
    let attachments = pi_dir.join("attachments");
    ensure_real_directory(&attachments)?;
    let canonical_attachments = fs::canonicalize(&attachments)
        .map_err(|error| format!("cannot resolve attachment directory: {error}"))?;
    if !canonical_attachments.starts_with(&project)
        || !registry.is_authorized(&canonical_attachments)
    {
        return Err("attachment directory is outside the authorized workspace".to_string());
    }

    let file_name = write_attachment_file(&canonical_attachments, turn, n, extension, &bytes)?;
    Ok(format!("{ATTACHMENTS_DIR}/{file_name}"))
}

#[tauri::command]
pub fn pi_save_attachment(
    cwd: String,
    turn: u64,
    n: u64,
    media_type: String,
    data: String,
    workspace: Option<WorkspaceEnv>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    save_attachment(
        &registry,
        &cwd,
        turn,
        n,
        &media_type,
        &data,
        &workspace,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn attachment_file_name_uses_turn_index_and_extension() {
        assert_eq!(attachment_file_name(7, 3, "jpg"), "7-3.jpg");
        assert_eq!(attachment_file_name(0, 0, "webp"), "0-0.webp");
    }

    #[test]
    fn save_bumps_n_without_overwriting_an_existing_attachment() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");

        let first = save_attachment(
            &registry,
            &path_string(project.path()),
            2,
            0,
            "image/png",
            "b2xk",
            &WorkspaceEnv::Local,
        )
        .expect("first attachment");
        let second = save_attachment(
            &registry,
            &path_string(project.path()),
            2,
            0,
            "image/png",
            "bmV3",
            &WorkspaceEnv::Local,
        )
        .expect("second attachment");

        assert_eq!(first, ".pi/attachments/2-0.png");
        assert_eq!(second, ".pi/attachments/2-1.png");
        assert_eq!(
            fs::read(project.path().join(&first)).expect("read first"),
            b"old"
        );
        assert_eq!(
            fs::read(project.path().join(&second)).expect("read second"),
            b"new"
        );
    }

    #[test]
    fn save_rejects_an_unauthorized_project() {
        let authorized = tempfile::tempdir().expect("authorized tempdir");
        let outside = tempfile::tempdir().expect("outside tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(authorized.path()).expect("authorize project");

        let error = save_attachment(
            &registry,
            &path_string(outside.path()),
            0,
            0,
            "image/png",
            "eA==",
            &WorkspaceEnv::Local,
        )
        .expect_err("outside project must be rejected");
        assert!(error.contains("outside the authorized workspace"), "{error}");
    }

    #[test]
    fn save_rejects_bytes_over_the_image_limit() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");
        let bytes = vec![b'x'; MAX_ATTACHMENT_BYTES + 1];
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);

        let error = save_attachment(
            &registry,
            &path_string(project.path()),
            0,
            0,
            "image/png",
            &data,
            &WorkspaceEnv::Local,
        )
        .expect_err("oversize attachment must be rejected");
        assert!(error.contains("4 MB"), "{error}");
    }
}

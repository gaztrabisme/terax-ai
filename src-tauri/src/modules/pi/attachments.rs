use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::modules::fs::file::write_atomic;
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

const MAX_ATTACHMENT_BYTES: usize = 4 * 1024 * 1024;
const ATTACHMENTS_DIR: &str = ".pi/attachments";
const DRAFTS_DIR: &str = ".pi/drafts";

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

/// Pure SHA-256 (FIPS 180-4) over bytes, hex-encoded. The tree carries no
/// hash crate, so the algorithm lives here once: every attachment, artifact
/// and answer record hashes through it (design.md section 3.4: "sha256
/// stores one computed with the SHA-256 algorithm").
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4,
        0xab1c_5ed5, 0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe,
        0x9bdc_06a7, 0xc19b_f174, 0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f,
        0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da, 0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7,
        0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967, 0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc,
        0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85, 0xa2bf_e8a1, 0xa81a_664b,
        0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070, 0x19a4_c116,
        0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
        0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7,
        0xc671_78f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab,
        0x5be0_cd19,
    ];
    let bit_len = (bytes.len() as u64).wrapping_mul(8);
    let mut message = bytes.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in message.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for (i, ki) in K.iter().enumerate() {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(*ki)
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut out = String::with_capacity(64);
    for word in h {
        out.push_str(&format!("{word:08x}"));
    }
    out
}

/// True for the opaque ids that name files (tab sids, attachment ids,
/// submission ids, session and turn ids): short, single path segment, no
/// traversal, no separators, no leading dot.
pub(crate) fn is_filename_safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        && !value.starts_with('.')
}

/// Creates `path` when missing; a symlink or a non-directory is an error.
/// `label` names the owner in the message ("attachment", "artifact", ...).
pub(crate) fn ensure_real_dir(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("{label} directory is a symlink: {}", path.display()))
        }
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(format!("{label} path is not a directory: {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(path) {
                Ok(()) => Ok(()),
                Err(create_error) if create_error.kind() == std::io::ErrorKind::AlreadyExists => {
                    ensure_real_dir(path, label)
                }
                Err(create_error) => Err(format!(
                    "cannot create {label} directory {}: {create_error}",
                    path.display()
                )),
            }
        }
        Err(error) => Err(format!("cannot inspect {}: {error}", path.display())),
    }
}

pub(crate) fn authorized_project_dir(
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
    let bytes = decode_attachment_payload(data)?;
    let project = authorized_project_dir(registry, cwd, workspace)?;
    let attachments = ensure_authorized_subdir(
        registry,
        &project,
        ATTACHMENTS_DIR,
        "attachment",
    )?;
    let file_name = write_attachment_file(&attachments, turn, n, extension, &bytes)?;
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

/// Decodes and size-checks one base64 attachment payload.
fn decode_attachment_payload(data: &str) -> Result<Vec<u8>, String> {
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
    Ok(bytes)
}

/// Resolves `<project>/<relative>`, creating it (and the `.pi` root) when
/// missing; the resolved directory must stay under the project and inside
/// the authorized workspace.
pub(crate) fn ensure_authorized_subdir(
    registry: &WorkspaceRegistry,
    project: &Path,
    relative: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let pi_dir = project.join(".pi");
    if !pi_dir.is_dir() {
        ensure_real_dir(&pi_dir, "pi state")?;
    }
    let dir = project.join(relative);
    ensure_real_dir(&dir, label)?;
    let canonical = fs::canonicalize(&dir)
        .map_err(|error| format!("cannot resolve {label} directory: {error}"))?;
    if !canonical.starts_with(project) || !registry.is_authorized(&canonical) {
        return Err(format!("{label} directory is outside the authorized workspace"));
    }
    Ok(canonical)
}

/// One durable file write honoring the section 3.4 temp-and-rename contract;
/// every error names the intended path.
pub(crate) fn write_durable(target: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic(target, bytes)
        .map_err(|error| format!("cannot write {}: {error}", target.display()))
}

// ---------------------------------------------------------------------------
// K13 draft attachments, submission staging and the binding index
// ---------------------------------------------------------------------------

/// A written attachment file: project-relative path plus the SHA-256 of the
/// exact bytes on disk.
#[derive(Debug, Clone, Serialize)]
pub struct SavedAttachmentFile {
    pub path: String,
    pub sha256: String,
}

/// One queued draft image: written at once to
/// `<project>/.pi/drafts/<tab-sid>-<attachment-id>.<ext>` so the chip is
/// path-backed before anything is sent (design.md section 3.4 row "Chat
/// draft and queued images"). Idempotent per id: the same id rewrites the
/// same file through the temp-and-rename writer.
fn save_draft_attachment(
    registry: &WorkspaceRegistry,
    cwd: &str,
    tab_id: &str,
    attachment_id: &str,
    media_type: &str,
    data: &str,
    workspace: &WorkspaceEnv,
) -> Result<SavedAttachmentFile, String> {
    if !is_filename_safe(tab_id) {
        return Err(format!("unsafe draft attachment tab id: {tab_id}"));
    }
    if !is_filename_safe(attachment_id) {
        return Err(format!("unsafe draft attachment id: {attachment_id}"));
    }
    let extension = extension_for_media_type(media_type)
        .ok_or_else(|| format!("unsupported attachment media type: {media_type}"))?;
    let bytes = decode_attachment_payload(data)?;
    let project = authorized_project_dir(registry, cwd, workspace)?;
    let drafts = ensure_authorized_subdir(registry, &project, DRAFTS_DIR, "draft attachment")?;
    let file_name = format!("{tab_id}-{attachment_id}.{extension}");
    let target = drafts.join(&file_name);
    write_durable(&target, &bytes)?;
    Ok(SavedAttachmentFile {
        path: format!("{DRAFTS_DIR}/{file_name}"),
        sha256: sha256_hex(&bytes),
    })
}

#[tauri::command]
pub fn pi_save_draft_attachment(
    cwd: String,
    tab_id: String,
    attachment_id: String,
    media_type: String,
    data: String,
    workspace: Option<WorkspaceEnv>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<SavedAttachmentFile, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    save_draft_attachment(
        &registry,
        &cwd,
        &tab_id,
        &attachment_id,
        &media_type,
        &data,
        &workspace,
    )
}

/// One attachment queued for staging: which draft file, under which id.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRequest {
    pub attachment_id: String,
    /// Project-relative path of the draft file to copy.
    pub path: String,
}

/// One staged submission copy under `.pi/attachments/`.
#[derive(Debug, Clone, Serialize)]
pub struct StagedAttachment {
    pub attachment_id: String,
    pub path: String,
    pub sha256: String,
}

/// Copies each draft file to
/// `<project>/.pi/attachments/<submission-id>-<attachment-id>.<ext>` before
/// the prompt is sent (design.md row "Sent images": "copies before send").
/// The same submission id restages the same names, so a retry is idempotent.
fn stage_submission(
    registry: &WorkspaceRegistry,
    cwd: &str,
    submission_id: &str,
    requests: Vec<StageRequest>,
    workspace: &WorkspaceEnv,
) -> Result<Vec<StagedAttachment>, String> {
    if !is_filename_safe(submission_id) {
        return Err(format!("unsafe submission id: {submission_id}"));
    }
    let project = authorized_project_dir(registry, cwd, workspace)?;
    let attachments =
        ensure_authorized_subdir(registry, &project, ATTACHMENTS_DIR, "attachment")?;
    let mut staged = Vec::with_capacity(requests.len());
    for request in requests {
        if !is_filename_safe(&request.attachment_id) {
            return Err(format!("unsafe attachment id: {}", request.attachment_id));
        }
        let source = project.join(&request.path);
        let canonical_source = fs::canonicalize(&source).map_err(|error| {
            format!(
                "cannot read attachment source {}: {error}",
                source.display()
            )
        })?;
        if !canonical_source.starts_with(&project)
            || !registry.is_authorized(&canonical_source)
        {
            return Err(format!(
                "attachment source {} is outside the authorized workspace",
                source.display()
            ));
        }
        let bytes = fs::read(&canonical_source).map_err(|error| {
            format!(
                "cannot read attachment source {}: {error}",
                canonical_source.display()
            )
        })?;
        let extension = canonical_source
            .extension()
            .and_then(|ext| ext.to_str())
            .filter(|ext| {
                !ext.is_empty()
                    && ext.len() <= 8
                    && ext
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.')
            })
            .ok_or_else(|| {
                format!(
                    "attachment source {} has no usable extension",
                    canonical_source.display()
                )
            })?
            .to_ascii_lowercase();
        let file_name = format!(
            "{submission_id}-{}.{}",
            request.attachment_id, extension
        );
        write_durable(&attachments.join(&file_name), &bytes)?;
        staged.push(StagedAttachment {
            attachment_id: request.attachment_id,
            path: format!("{ATTACHMENTS_DIR}/{file_name}"),
            sha256: sha256_hex(&bytes),
        });
    }
    Ok(staged)
}

#[tauri::command]
pub fn pi_stage_submission(
    cwd: String,
    submission_id: String,
    attachments: Vec<StageRequest>,
    workspace: Option<WorkspaceEnv>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<Vec<StagedAttachment>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    stage_submission(
        &registry,
        &cwd,
        &submission_id,
        attachments,
        &workspace,
    )
}

/// One entry of the sent-images binding index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIndexEntry {
    pub submission_id: String,
    pub attachment_id: String,
    pub path: String,
    pub sha256: String,
    pub session_id: String,
    pub turn_id: String,
}

/// The sent-images index: `.pi/attachments/index.json`.
#[derive(Debug, Serialize, Deserialize)]
struct AttachmentIndex {
    v: u32,
    entries: Vec<AttachmentIndexEntry>,
}

/// One attachment to bind on acknowledgement.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingRequest {
    pub attachment_id: String,
    pub path: String,
    pub sha256: String,
}

fn read_attachment_index(path: &Path) -> Result<AttachmentIndex, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let index: AttachmentIndex = serde_json::from_str(&text).map_err(|error| {
                format!("malformed attachment index {}: {error}", path.display())
            })?;
            if index.v != 1 {
                return Err(format!(
                    "unsupported attachment index version {} in {}",
                    index.v,
                    path.display()
                ));
            }
            Ok(index)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AttachmentIndex {
            v: 1,
            entries: Vec::new(),
        }),
        Err(error) => Err(format!(
            "cannot read attachment index {}: {error}",
            path.display()
        )),
    }
}

/// Appends `{submissionId,attachmentId,path,sha256,sessionId,turnId}` entries
/// to `.pi/attachments/index.json` atomically (read, append, temp-and-rename),
/// deduped per (submission, attachment). Called on pi's acknowledgement: the
/// user message block for the prompt text.
fn record_attachment_binding(
    registry: &WorkspaceRegistry,
    cwd: &str,
    submission_id: &str,
    session_id: &str,
    turn_id: &str,
    bindings: Vec<BindingRequest>,
    workspace: &WorkspaceEnv,
) -> Result<(), String> {
    if !is_filename_safe(submission_id) {
        return Err(format!("unsafe submission id: {submission_id}"));
    }
    if session_id.trim().is_empty() || turn_id.trim().is_empty() {
        return Err("attachment binding needs a session id and a turn id".to_string());
    }
    let project = authorized_project_dir(registry, cwd, workspace)?;
    let dir = ensure_authorized_subdir(registry, &project, ATTACHMENTS_DIR, "attachment")?;
    let index_path = dir.join("index.json");
    let mut index = read_attachment_index(&index_path)?;
    for binding in bindings {
        let entry = AttachmentIndexEntry {
            submission_id: submission_id.to_string(),
            attachment_id: binding.attachment_id,
            path: binding.path,
            sha256: binding.sha256,
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
        };
        if index.entries.iter().any(|existing| {
            existing.submission_id == entry.submission_id
                && existing.attachment_id == entry.attachment_id
        }) {
            continue;
        }
        index.entries.push(entry);
    }
    let text = serde_json::to_string_pretty(&index)
        .map_err(|error| format!("cannot serialize attachment index: {error}"))?;
    write_durable(&index_path, text.as_bytes())
}

#[tauri::command]
pub fn pi_record_attachment_binding(
    cwd: String,
    submission_id: String,
    session_id: String,
    turn_id: String,
    bindings: Vec<BindingRequest>,
    workspace: Option<WorkspaceEnv>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    record_attachment_binding(
        &registry,
        &cwd,
        &submission_id,
        &session_id,
        &turn_id,
        bindings,
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

    #[test]
    fn sha256_matches_the_fips_vector_for_abc() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn filename_ids_reject_traversal_and_separators() {
        assert!(is_filename_safe("k7x2m9"));
        assert!(is_filename_safe("att-12"));
        assert!(is_filename_safe("sub_9"));
        assert!(!is_filename_safe(""));
        assert!(!is_filename_safe("."));
        assert!(!is_filename_safe(".."));
        assert!(!is_filename_safe(".hidden"));
        assert!(!is_filename_safe("a/b"));
        assert!(!is_filename_safe("a\\b"));
        assert!(!is_filename_safe("a:b"));
    }

    #[test]
    fn draft_attachment_writes_the_file_and_returns_its_hash() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");

        let saved = save_draft_attachment(
            &registry,
            &path_string(project.path()),
            "k7x2m9",
            "att-1",
            "image/png",
            "b2xk",
            &WorkspaceEnv::Local,
        )
        .expect("draft attachment");

        assert_eq!(saved.path, ".pi/drafts/k7x2m9-att-1.png");
        assert_eq!(saved.sha256, sha256_hex(b"old"));
        let on_disk =
            fs::read(project.path().join(".pi/drafts/k7x2m9-att-1.png")).expect("draft file");
        assert_eq!(on_disk, b"old");
        assert_eq!(saved.sha256, sha256_hex(&on_disk));
    }

    #[test]
    fn draft_attachment_rewrites_the_same_name_for_the_same_id() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");

        let first = save_draft_attachment(
            &registry,
            &path_string(project.path()),
            "k7x2m9",
            "att-1",
            "image/png",
            "b2xk",
            &WorkspaceEnv::Local,
        )
        .expect("first write");
        let second = save_draft_attachment(
            &registry,
            &path_string(project.path()),
            "k7x2m9",
            "att-1",
            "image/png",
            "bmV3",
            &WorkspaceEnv::Local,
        )
        .expect("second write");

        assert_eq!(first.path, second.path);
        assert_eq!(second.sha256, sha256_hex(b"new"));
        let on_disk =
            fs::read(project.path().join(&second.path)).expect("draft file");
        assert_eq!(on_disk, b"new");
    }

    #[test]
    fn draft_attachment_rejects_unsafe_ids_and_unauthorized_projects() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");

        let error = save_draft_attachment(
            &registry,
            &path_string(project.path()),
            "../escape",
            "att-1",
            "image/png",
            "eA==",
            &WorkspaceEnv::Local,
        )
        .expect_err("traversal tab id must be rejected");
        assert!(error.contains("unsafe"), "{error}");

        let outside = tempfile::tempdir().expect("outside tempdir");
        let error = save_draft_attachment(
            &registry,
            &path_string(outside.path()),
            "k7x2m9",
            "att-1",
            "image/png",
            "eA==",
            &WorkspaceEnv::Local,
        )
        .expect_err("outside project must be rejected");
        assert!(error.contains("outside the authorized workspace"), "{error}");
    }

    fn seed_draft(project: &Path, name: &str, bytes: &[u8]) -> String {
        let dir = project.join(".pi/drafts");
        fs::create_dir_all(&dir).expect("drafts dir");
        fs::write(dir.join(name), bytes).expect("draft file");
        format!(".pi/drafts/{name}")
    }

    #[test]
    fn staging_copies_draft_files_under_the_submission_name() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");
        let draft = seed_draft(project.path(), "k7x2m9-att-1.png", b"image-bytes");

        let staged = stage_submission(
            &registry,
            &path_string(project.path()),
            "sub-1",
            vec![StageRequest {
                attachment_id: "att-1".to_string(),
                path: draft,
            }],
            &WorkspaceEnv::Local,
        )
        .expect("staged");

        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].attachment_id, "att-1");
        assert_eq!(staged[0].path, ".pi/attachments/sub-1-att-1.png");
        assert_eq!(staged[0].sha256, sha256_hex(b"image-bytes"));
        let copy = fs::read(project.path().join(&staged[0].path)).expect("staged copy");
        assert_eq!(copy, b"image-bytes");
    }

    #[test]
    fn restaging_the_same_submission_replaces_its_files() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");
        let draft = seed_draft(project.path(), "k7x2m9-att-1.png", b"first");

        let first = stage_submission(
            &registry,
            &path_string(project.path()),
            "sub-1",
            vec![StageRequest {
                attachment_id: "att-1".to_string(),
                path: draft.clone(),
            }],
            &WorkspaceEnv::Local,
        )
        .expect("first staging");
        fs::write(project.path().join(&draft), b"second").expect("rewrite draft");
        let second = stage_submission(
            &registry,
            &path_string(project.path()),
            "sub-1",
            vec![StageRequest {
                attachment_id: "att-1".to_string(),
                path: draft,
            }],
            &WorkspaceEnv::Local,
        )
        .expect("retry staging");

        assert_eq!(first[0].path, second[0].path);
        assert_ne!(first[0].sha256, second[0].sha256);
        let copy = fs::read(project.path().join(&second[0].path)).expect("restaged copy");
        assert_eq!(copy, b"second");
    }

    #[test]
    fn staging_rejects_sources_outside_the_project_or_missing() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");

        // An existing file outside the project: its parent (the temp root)
        // is authorized, so the rejection comes from the project boundary.
        let outside = project.path().parent().expect("temp parent");
        registry.authorize(outside).expect("authorize temp parent");
        let outside_file = outside.join("terax-stage-outside-secret.txt");
        fs::write(&outside_file, b"secret").expect("outside file");

        let error = stage_submission(
            &registry,
            &path_string(project.path()),
            "sub-1",
            vec![StageRequest {
                attachment_id: "att-1".to_string(),
                path: "../terax-stage-outside-secret.txt".to_string(),
            }],
            &WorkspaceEnv::Local,
        )
        .expect_err("traversal source must be rejected");
        assert!(error.contains("outside the authorized workspace"), "{error}");
        let _ = fs::remove_file(&outside_file);

        let error = stage_submission(
            &registry,
            &path_string(project.path()),
            "sub-1",
            vec![StageRequest {
                attachment_id: "att-1".to_string(),
                path: ".pi/drafts/missing.png".to_string(),
            }],
            &WorkspaceEnv::Local,
        )
        .expect_err("missing source must be rejected");
        assert!(error.contains("cannot read attachment source"), "{error}");
    }

    #[test]
    fn binding_appends_index_entries_atomically_and_dedupes() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");
        let bind = |submission: &str, turn: &str| {
            record_attachment_binding(
                &registry,
                &path_string(project.path()),
                submission,
                "session-1",
                turn,
                vec![BindingRequest {
                    attachment_id: "att-1".to_string(),
                    path: format!(".pi/attachments/{submission}-att-1.png").to_string(),
                    sha256: "f00d".to_string(),
                }],
                &WorkspaceEnv::Local,
            )
        };

        bind("sub-1", "turn-1").expect("first binding");
        // The same submission again (a replayed ack) must not duplicate.
        bind("sub-1", "turn-1").expect("duplicate binding is a no-op");
        bind("sub-2", "turn-2").expect("second binding");

        let text =
            fs::read_to_string(project.path().join(".pi/attachments/index.json")).expect("index");
        let index: AttachmentIndex = serde_json::from_str(&text).expect("parse index");
        assert_eq!(index.v, 1);
        assert_eq!(index.entries.len(), 2);
        assert_eq!(index.entries[0].submission_id, "sub-1");
        assert_eq!(index.entries[0].session_id, "session-1");
        assert_eq!(index.entries[0].turn_id, "turn-1");
        assert_eq!(index.entries[0].path, ".pi/attachments/sub-1-att-1.png");
        assert_eq!(index.entries[0].sha256, "f00d");
        assert_eq!(index.entries[1].submission_id, "sub-2");
    }

    #[test]
    fn binding_rejects_malformed_indexes_and_blank_ids() {
        let project = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceRegistry::default();
        registry.authorize(project.path()).expect("authorize project");
        let dir = project.path().join(".pi/attachments");
        fs::create_dir_all(&dir).expect("attachments dir");
        fs::write(dir.join("index.json"), "{not json").expect("corrupt index");

        let error = record_attachment_binding(
            &registry,
            &path_string(project.path()),
            "sub-1",
            "session-1",
            "turn-1",
            vec![BindingRequest {
                attachment_id: "att-1".to_string(),
                path: ".pi/attachments/sub-1-att-1.png".to_string(),
                sha256: "f00d".to_string(),
            }],
            &WorkspaceEnv::Local,
        )
        .expect_err("malformed index must be refused");
        assert!(error.contains("malformed attachment index"), "{error}");

        let error = record_attachment_binding(
            &registry,
            &path_string(project.path()),
            "sub-1",
            "",
            "turn-1",
            vec![],
            &WorkspaceEnv::Local,
        )
        .expect_err("blank session id must be refused");
        assert!(error.contains("session id and a turn id"), "{error}");
    }
}

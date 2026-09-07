//! Read-only listing and search over pi's on-disk session store.
//!
//! pi writes sessions as JSONL under
//! `<agent dir>/sessions/<encoded cwd>/<timestamp>_<id>.jsonl` (vendor
//! pi_agent_rust src/session.rs: Session::create derives the per-project
//! directory with encode_cwd). This module only ever opens session files for
//! reading and never writes to the store: the disk is the truth and the app
//! is a view over the files pi already wrote (philosophy 1, 2).

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};

/// firstPrompt cap: the opening line of a session, not its full text.
const FIRST_PROMPT_CHARS: usize = 120;
/// Snippet cap: 160 chars around the first hit, ellipses included.
const SNIPPET_CHARS: usize = 160;
/// How far back from the hit the snippet window starts.
const SNIPPET_CONTEXT_CHARS: usize = 40;
/// Search default and hard cap on returned sessions.
const SEARCH_DEFAULT_LIMIT: usize = 20;
const SEARCH_MAX_LIMIT: usize = 200;

/// One listed session, for the Sessions pane's list mode.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionSummary {
    pub path: String,
    pub started_at: String,
    pub first_prompt: String,
    /// User prompts in the file: a user message opens the next turn in the
    /// fork's transcript grouping (turns.ts groupBlocks), so this is the
    /// number of turns the session shows.
    pub turns: u64,
    /// Sum of every assistant message's usage.totalTokens.
    pub tokens: u64,
}

/// The first match in one session: where it sits and what it says.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionHit {
    pub path: String,
    pub started_at: String,
    /// "user" or "assistant".
    pub role: String,
    /// Up to 160 chars around the first hit; "..." marks each cut edge.
    pub snippet: String,
}

/// Lowercased needle for the file scan.
struct Query {
    needle: String,
    needle_chars: usize,
}

impl Query {
    fn new(query: &str) -> Self {
        let needle = query.to_lowercase();
        let needle_chars = needle.chars().count();
        Self {
            needle,
            needle_chars,
        }
    }
}

/// One scanned session file: list fields plus the optional first hit.
struct FileScan {
    path: String,
    started_at: String,
    first_prompt: String,
    turns: u64,
    tokens: u64,
    hit: Option<(String, String)>,
}

/// pi's session-directory encoding of a cwd. Vendor pi_agent_rust
/// src/session.rs encode_cwd: trim leading slashes, replace `/`, `\` and `:`
/// with `-`, then wrap the whole name in `--`. `/Users/me/Work/Terax` becomes
/// `--Users-me-Work-Terax--`; `C:\dev\app` becomes `--C--dev-app--`.
fn encode_cwd(path: &Path) -> String {
    let s = path.to_string_lossy();
    let s = s.trim_start_matches(['/', '\\']);
    let s = s.replace(['/', '\\', ':'], "-");
    format!("--{s}--")
}

/// Session directories to scan for `cwd`: the encoded dir pi writes for it,
/// or, when that dir is missing (the path was recorded through a symlink or
/// an older pi laid sessions out differently), every directory under the
/// sessions root, filtered afterwards by the cwd in each file header.
fn candidate_dirs(agent_dir: &Path, cwd: &str) -> Vec<PathBuf> {
    let root = agent_dir.join("sessions");
    let mut dirs = Vec::new();
    let primary = root.join(encode_cwd(Path::new(cwd)));
    if primary.is_dir() {
        dirs.push(primary);
        return dirs;
    }
    let Ok(entries) = fs::read_dir(&root) else {
        return dirs;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        }
    }
    dirs
}

/// The header line's cwd and timestamp (vendor SessionHeader, the fields
/// search reads). None when the line is not a session header.
fn read_header(line: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let cwd = v.get("cwd")?.as_str()?.to_string();
    let timestamp = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    Some((cwd, timestamp))
}

/// The text of one session entry when it is a user or assistant message with
/// text content, plus the assistant usage total when present. Thinking
/// blocks, tool calls and tool result entries never produce text: search
/// scans only user and assistant text content.
fn message_text(line: &str) -> Option<(String, String, u64)> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "message" {
        return None;
    }
    let message = v.get("message")?;
    let role = message.get("role")?.as_str()?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let mut text = String::new();
    match message.get("content")? {
        // Plain-string user content: pi's untagged UserContent::Text shape.
        serde_json::Value::String(s) => text.push_str(s),
        serde_json::Value::Array(blocks) => {
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                }
            }
        }
        _ => {}
    }
    let tokens = message
        .get("usage")
        .and_then(|u| u.get("totalTokens"))
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    Some((role.to_string(), text, tokens))
}

/// Truncates to `max` chars without splitting a glyph.
fn clamp_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((idx, _)) => text[..idx].to_string(),
        None => text.to_string(),
    }
}

/// Original char index whose lowercase expansion starts at
/// `lower_prefix_chars` chars into the lowercased text: case folding can
/// change char counts (Turkish-style dots, ligatures), so the byte offset a
/// lowercase find produces must be mapped back before slicing the original.
fn original_char_index(chars: &[char], lower_prefix_chars: usize) -> usize {
    let mut acc = 0;
    for (i, c) in chars.iter().enumerate() {
        if acc >= lower_prefix_chars {
            return i;
        }
        acc += c.to_lowercase().count();
    }
    chars.len()
}

/// How many original chars the match starting at `start` spans, measured in
/// the lowercased stream (the mirror of original_char_index).
fn match_char_len(chars: &[char], start: usize, needle_chars: usize) -> usize {
    let mut acc = 0;
    let mut i = start;
    while i < chars.len() && acc < needle_chars {
        acc += chars[i].to_lowercase().count();
        i += 1;
    }
    i - start
}

/// Up to SNIPPET_CHARS chars around the hit (an original-text char index)
/// with "..." on each cut edge. Glyph boundaries are respected; a needle
/// longer than the window can push the result past the cap rather than lose
/// the match.
fn snippet_around(chars: &[char], hit: usize, match_len: usize) -> String {
    let total = chars.len();
    let start = hit.saturating_sub(SNIPPET_CONTEXT_CHARS);
    let lead = start > 0;
    // The match must sit inside the window; the plain window is the cap minus
    // the worst-case decoration of two ellipses.
    let end = (start + SNIPPET_CHARS - 6)
        .max(hit + match_len)
        .min(total);
    let trail = end < total;
    let core: String = chars[start..end].iter().collect();
    let core = core.trim();
    let mut out = String::new();
    if lead {
        out.push_str("...");
    }
    out.push_str(core);
    if trail {
        out.push_str("...");
    }
    out
}

/// Scans one session file. `query` of None lists only; Some finds the first
/// case-insensitive hit in user and assistant text. Opens the file read-only
/// and skips files whose header records a different cwd.
fn scan_session_file(path: &Path, cwd: &str, query: Option<&Query>) -> Option<FileScan> {
    // Read-only handle: the store stays pi's; this module never writes.
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let (header_cwd, started_at) = read_header(line.trim_end())?;
    if header_cwd != cwd {
        return None;
    }
    let mut first_prompt = String::new();
    let mut turns = 0u64;
    let mut tokens = 0u64;
    let mut hit = None;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let Some((role, text, usage)) = message_text(&line) else {
            continue;
        };
        if role == "user" {
            turns += 1;
            if first_prompt.is_empty() {
                first_prompt = clamp_chars(text.trim(), FIRST_PROMPT_CHARS);
            }
        }
        tokens += usage;
        if let Some(q) = query {
            if hit.is_none() && !text.is_empty() {
                let lower = text.to_lowercase();
                if let Some(byte) = lower.find(&q.needle) {
                    let chars: Vec<char> = text.chars().collect();
                    let lower_hit = lower[..byte].chars().count();
                    let start = original_char_index(&chars, lower_hit);
                    let len = match_char_len(&chars, start, q.needle_chars.max(1));
                    hit = Some((role.clone(), snippet_around(&chars, start, len)));
                }
            }
        }
    }
    Some(FileScan {
        path: path.to_string_lossy().into_owned(),
        started_at,
        first_prompt,
        turns,
        tokens,
        hit,
    })
}

/// Every session for `cwd`, newest first (RFC 3339 UTC timestamps sort
/// lexicographically); files without a timestamp sort last, path-descending
/// for a stable order.
fn collect_sessions(agent_dir: &str, cwd: &str, query: Option<&Query>) -> Vec<FileScan> {
    let mut out = Vec::new();
    for dir in candidate_dirs(Path::new(agent_dir), cwd) {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(scan) = scan_session_file(&path, cwd, query) {
                out.push(scan);
            }
        }
    }
    out.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.path.cmp(&a.path))
    });
    out
}

/// Sessions for one project, newest first. Read-only over the store.
pub(crate) fn list_sessions(agent_dir: &str, cwd: &str) -> Vec<PiSessionSummary> {
    collect_sessions(agent_dir, cwd, None)
        .into_iter()
        .map(|s| PiSessionSummary {
            path: s.path,
            started_at: s.started_at,
            first_prompt: s.first_prompt,
            turns: s.turns,
            tokens: s.tokens,
        })
        .collect()
}

/// The first case-insensitive hit per session, newest first, at most `limit`
/// sessions. Read-only over the store.
pub(crate) fn search_sessions(
    agent_dir: &str,
    cwd: &str,
    query: &str,
    limit: usize,
) -> Vec<PiSessionHit> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let limit = limit.clamp(1, SEARCH_MAX_LIMIT);
    collect_sessions(agent_dir, cwd, Some(&Query::new(query)))
        .into_iter()
        .filter_map(|s| {
            s.hit.map(|(role, snippet)| PiSessionHit {
                path: s.path,
                started_at: s.started_at,
                role,
                snippet,
            })
        })
        .take(limit)
        .collect()
}

/// Lists pi's session files for a workspace cwd. `agentDir` is the runtime
/// agent dir pi_paths reports; the cwd is workspace-authorized like every pi
/// command. Read-only: nothing under the agent dir is written.
#[tauri::command]
pub fn pi_sessions_list(
    registry: tauri::State<'_, WorkspaceRegistry>,
    workspace: Option<WorkspaceEnv>,
    cwd: String,
    agent_dir: String,
) -> Result<Vec<PiSessionSummary>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let canonical = authorize_user_spawn_cwd(&registry, Some(&cwd), &workspace)?;
    let cwd = canonical.ok_or_else(|| "pi_sessions_list needs a cwd".to_string())?;
    Ok(list_sessions(
        agent_dir.trim(),
        &cwd.to_string_lossy(),
    ))
}

/// Searches pi's session files for a workspace cwd: the first
/// case-insensitive hit per session across user and assistant text content,
/// newest first, at most `limit` sessions (default 20).
#[tauri::command]
pub fn pi_sessions_search(
    registry: tauri::State<'_, WorkspaceRegistry>,
    workspace: Option<WorkspaceEnv>,
    cwd: String,
    agent_dir: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<PiSessionHit>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let canonical = authorize_user_spawn_cwd(&registry, Some(&cwd), &workspace)?;
    let cwd = canonical.ok_or_else(|| "pi_sessions_search needs a cwd".to_string())?;
    Ok(search_sessions(
        agent_dir.trim(),
        &cwd.to_string_lossy(),
        &query,
        limit.map_or(SEARCH_DEFAULT_LIMIT, |n| n as usize),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const HEADER_TS: &str = "2026-06-08T15:07:02.400Z";

    fn header_line(cwd: &str, timestamp: &str) -> String {
        format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"019ea7c5\",\"timestamp\":\"{timestamp}\",\"cwd\":\"{cwd}\"}}",
        )
    }

    fn user_blocks_line(text: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"2026-06-08T15:07:02.408Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":{text}}}]}}}}",
            text = serde_json::to_string(text).expect("json string"),
        )
    }

    fn user_plain_line(text: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"2026-06-08T15:07:02.408Z\",\"message\":{{\"role\":\"user\",\"content\":{text}}}}}",
            text = serde_json::to_string(text).expect("json string"),
        )
    }

    fn assistant_line(text: &str, tokens: u64) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"e2\",\"parentId\":\"e1\",\"timestamp\":\"2026-06-08T15:07:05.778Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":{text}}}],\"api\":\"openai-completions\",\"provider\":\"omlx\",\"model\":\"q\",\"usage\":{{\"input\":10,\"output\":2,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":{tokens},\"cost\":{{\"input\":0.0,\"output\":0.0,\"cacheRead\":0.0,\"cacheWrite\":0.0,\"total\":0.0}}}},\"stopReason\":\"stop\",\"timestamp\":1780931222452}}}}",
            text = serde_json::to_string(text).expect("json string"),
        )
    }

    fn tool_result_line(text: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"e3\",\"parentId\":\"e2\",\"timestamp\":\"2026-06-08T15:07:06.000Z\",\"message\":{{\"role\":\"toolResult\",\"toolCallId\":\"c1\",\"toolName\":\"read\",\"content\":[{{\"type\":\"text\",\"text\":{text}}}],\"is_error\":false,\"timestamp\":1780931222460}}}}",
            text = serde_json::to_string(text).expect("json string"),
        )
    }

    fn thinking_line(text: &str) -> String {
        format!(
            "{{\"type\":\"message\",\"id\":\"e4\",\"parentId\":\"e2\",\"timestamp\":\"2026-06-08T15:07:07.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"thinking\",\"thinking\":{text}}}],\"api\":\"a\",\"provider\":\"p\",\"model\":\"m\",\"usage\":{{\"totalTokens\":1}},\"stopReason\":\"stop\",\"timestamp\":1}}}}",
            text = serde_json::to_string(text).expect("json string"),
        )
    }

    fn write_session(
        agent_dir: &Path,
        dir_name: &str,
        file_name: &str,
        lines: &[String],
    ) -> PathBuf {
        let dir = agent_dir.join("sessions").join(dir_name);
        fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join(file_name);
        fs::write(&path, lines.join("\n") + "\n").expect("write session");
        path
    }

    fn encoded_for(cwd: &str) -> String {
        encode_cwd(Path::new(cwd))
    }

    #[test]
    fn encode_cwd_matches_pi_vendor_rule() {
        // Vendor pi_agent_rust src/session.rs encode_cwd: trim leading
        // slashes, replace / \\ : with -, wrap in --.
        assert_eq!(encode_cwd(Path::new("/Users/me/Work")), "--Users-me-Work--");
        assert_eq!(encode_cwd(Path::new("/tmp/x")), "--tmp-x--");
        assert_eq!(encode_cwd(Path::new("C:\\dev\\app")), "--C--dev-app--");
        assert_eq!(encode_cwd(Path::new("relative/path")), "--relative-path--");
    }

    #[test]
    fn list_orders_newest_first_with_first_prompt_turns_tokens() {
        let tmp = TempDir::new().expect("tempdir");
        let cwd = "/tmp/proj";
        let dir = &encoded_for(cwd);
        write_session(
            tmp.path(),
            dir,
            "2026-06-08T15-07-02-400Z_a.jsonl",
            &[
                header_line(cwd, "2026-06-08T15:07:02.400Z"),
                user_blocks_line("first prompt"),
                assistant_line("answer one", 413),
            ],
        );
        write_session(
            tmp.path(),
            dir,
            "2026-06-09T09-00-00-000Z_b.jsonl",
            &[
                header_line(cwd, "2026-06-09T09:00:00.000Z"),
                user_blocks_line("second prompt"),
                assistant_line("answer two", 10),
                assistant_line("more", 5),
            ],
        );
        let sessions = list_sessions(tmp.path().to_str().expect("utf8"), cwd);
        assert_eq!(sessions.len(), 2, "both sessions listed");
        assert!(sessions[0].path.ends_with("_b.jsonl"), "newest first");
        assert_eq!(sessions[0].started_at, "2026-06-09T09:00:00.000Z");
        assert_eq!(sessions[0].first_prompt, "second prompt");
        assert_eq!(sessions[0].turns, 1, "one user prompt is one turn");
        assert_eq!(sessions[0].tokens, 15, "assistant usage summed");
        assert_eq!(sessions[1].first_prompt, "first prompt");
        assert_eq!(sessions[1].tokens, 413);
    }

    #[test]
    fn list_reads_plain_string_user_content() {
        let tmp = TempDir::new().expect("tempdir");
        let cwd = "/tmp/proj";
        write_session(
            tmp.path(),
            &encoded_for(cwd),
            "2026-06-08T15-07-02-400Z_a.jsonl",
            &[
                header_line(cwd, HEADER_TS),
                user_plain_line("typed plain text"),
            ],
        );
        let sessions = list_sessions(tmp.path().to_str().expect("utf8"), cwd);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].first_prompt, "typed plain text");
        assert_eq!(sessions[0].turns, 1);
    }

    #[test]
    fn first_prompt_is_clamped_to_120_chars() {
        let tmp = TempDir::new().expect("tempdir");
        let cwd = "/tmp/proj";
        let long = "x".repeat(200);
        write_session(
            tmp.path(),
            &encoded_for(cwd),
            "2026-06-08T15-07-02-400Z_a.jsonl",
            &[header_line(cwd, HEADER_TS), user_blocks_line(&long)],
        );
        let sessions = list_sessions(tmp.path().to_str().expect("utf8"), cwd);
        assert_eq!(sessions[0].first_prompt.chars().count(), 120);
    }

    #[test]
    fn list_skips_other_projects_and_header_mismatches() {
        let tmp = TempDir::new().expect("tempdir");
        let cwd = "/tmp/proj";
        write_session(
            tmp.path(),
            &encoded_for("/tmp/other"),
            "2026-06-08T15-07-02-400Z_other.jsonl",
            &[header_line("/tmp/other", HEADER_TS), user_blocks_line("nope")],
        );
        write_session(
            tmp.path(),
            &encoded_for(cwd),
            "2026-06-08T15-07-02-400Z_liar.jsonl",
            &[
                header_line("/tmp/other", HEADER_TS),
                user_blocks_line("recorded elsewhere"),
            ],
        );
        let sessions = list_sessions(tmp.path().to_str().expect("utf8"), cwd);
        assert!(sessions.is_empty(), "only matching headers list");
    }

    #[test]
    fn list_falls_back_to_header_cwd_scan_without_encoded_dir() {
        let tmp = TempDir::new().expect("tempdir");
        let cwd = "/tmp/proj";
        // The encoded dir for the canonical cwd is absent (symlinked cwd),
        // but the file header records it: the fallback must find it.
        write_session(
            tmp.path(),
            "--private-tmp-proj--",
            "2026-06-08T15-07-02-400Z_a.jsonl",
            &[header_line(cwd, HEADER_TS), user_blocks_line("found me")],
        );
        let sessions = list_sessions(tmp.path().to_str().expect("utf8"), cwd);
        assert_eq!(sessions.len(), 1, "fallback matches the header cwd");
        assert_eq!(sessions[0].first_prompt, "found me");
    }

    #[test]
    fn list_of_missing_store_is_empty() {
        let tmp = TempDir::new().expect("tempdir");
        let sessions = list_sessions(tmp.path().to_str().expect("utf8"), "/tmp/proj");
        assert!(sessions.is_empty());
    }

    #[test]
    fn search_finds_case_insensitive_hits_in_user_and_assistant_text() {
        let tmp = TempDir::new().expect("tempdir");
        let cwd = "/tmp/proj";
        write_session(
            tmp.path(),
            &encoded_for(cwd),
            "2026-06-08T15-07-02-400Z_a.jsonl",
            &[
                header_line(cwd, HEADER_TS),
                tool_result_line("secret inside a tool result"),
                thinking_line("secret inside thinking"),
                user_blocks_line("please find the Grail diary"),
                assistant_line("the grail diary is cited here", 5),
            ],
        );
        let hits = search_sessions(
            tmp.path().to_str().expect("utf8"),
            cwd,
            "grail DIARY",
            SEARCH_DEFAULT_LIMIT,
        );
        assert_eq!(hits.len(), 1, "one hit: the first in the file");
        assert_eq!(hits[0].role, "user", "user text wins over later assistant");
        assert!(hits[0].snippet.contains("Grail diary"), "hit in snippet");
    }

    #[test]
    fn search_snippet_is_capped_and_marks_cut_edges() {
        let tmp = TempDir::new().expect("tempdir");
        let cwd = "/tmp/proj";
        let filler = "word ".repeat(400);
        write_session(
            tmp.path(),
            &encoded_for(cwd),
            "2026-06-08T15-07-02-400Z_a.jsonl",
            &[
                header_line(cwd, HEADER_TS),
                user_blocks_line(&format!("{filler}needle{filler}")),
            ],
        );
        let hits = search_sessions(
            tmp.path().to_str().expect("utf8"),
            cwd,
            "needle",
            SEARCH_DEFAULT_LIMIT,
        );
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].snippet.chars().count() <= SNIPPET_CHARS,
            "snippet capped at {} chars, got {}",
            SNIPPET_CHARS,
            hits[0].snippet.chars().count()
        );
        assert!(hits[0].snippet.starts_with("..."));
        assert!(hits[0].snippet.ends_with("..."));
        assert!(hits[0].snippet.contains("needle"));
    }

    #[test]
    fn search_snippet_respects_glyph_boundaries() {
        // A multibyte needle around multibyte text: the snippet must stay
        // valid UTF-8 (clippy + the serializer reject nothing else, but the
        // assertion pins the behavior).
        let tmp = TempDir::new().expect("tempdir");
        let cwd = "/tmp/proj";
        write_session(
            tmp.path(),
            &encoded_for(cwd),
            "2026-06-08T15-07-02-400Z_a.jsonl",
            &[
                header_line(cwd, HEADER_TS),
                user_blocks_line("caf\u{e9} na\u{ef}ve r\u{e9}sum\u{e9} tr\u{e8}sclair"),
            ],
        );
        let hits = search_sessions(
            tmp.path().to_str().expect("utf8"),
            cwd,
            "R\u{c9}SUM\u{c9}",
            SEARCH_DEFAULT_LIMIT,
        );
        assert_eq!(hits.len(), 1, "accented case-insensitive match");
        assert_eq!(hits[0].role, "user");
        assert!(hits[0].snippet.contains("r\u{e9}sum\u{e9}"));
    }

    #[test]
    fn search_respects_limit_and_blank_query_is_empty() {
        let tmp = TempDir::new().expect("tempdir");
        let cwd = "/tmp/proj";
        for (i, ts) in ["2026-06-08T15:07:02.400Z", "2026-06-09T15:07:02.400Z", "2026-06-10T15:07:02.400Z"]
            .iter()
            .enumerate()
        {
            write_session(
                tmp.path(),
                &encoded_for(cwd),
                &format!("2026-06-1{i}T15-07-02-400Z_s{i}.jsonl"),
                &[
                    header_line(cwd, ts),
                    user_blocks_line("the target word here"),
                ],
            );
        }
        let dir = tmp.path().to_str().expect("utf8");
        assert_eq!(search_sessions(dir, cwd, "target", 2).len(), 2);
        assert_eq!(search_sessions(dir, cwd, "target", 0).len(), 1, "limit clamped to 1");
        assert!(search_sessions(dir, cwd, "   ", SEARCH_DEFAULT_LIMIT).is_empty());
        assert!(search_sessions(dir, cwd, "absent", SEARCH_DEFAULT_LIMIT).is_empty());
    }

    #[test]
    fn snippet_windows_center_on_the_hit() {
        let chars: Vec<char> = "0123456789".repeat(30).chars().collect();
        let hit = 150;
        let snippet = snippet_around(&chars, hit, 2);
        assert!(snippet.contains(&chars[hit..hit + 2].iter().collect::<String>()));
        assert!(snippet.chars().count() <= SNIPPET_CHARS);
        assert!(snippet.starts_with("...") && snippet.ends_with("..."));
        // A short text with an early hit: no cut edges, no ellipses.
        let short: Vec<char> = "abc needle def".chars().collect();
        let snippet = snippet_around(&short, 4, 6);
        assert_eq!(snippet, "abc needle def");
    }
}

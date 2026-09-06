use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

/// One streamed JSONL line from a watched transcript file.
#[derive(Serialize, Clone)]
pub struct TranscriptLine {
    pub file: String,
    pub line: String,
}

// Held for lifetime only: dropping the watcher ends the watch, and the
// offsets map must live exactly as long as the watch that updates it.
struct TranscriptWatcher {
    #[allow(dead_code)]
    _watcher: RecommendedWatcher,
    #[allow(dead_code)]
    offsets: Arc<Mutex<HashMap<PathBuf, u64>>>,
}

pub struct WatchHandle {
    #[allow(dead_code)]
    watcher: TranscriptWatcher,
    #[allow(dead_code)]
    pub root: PathBuf,
}

/// Appends newly arrived complete lines from `bytes` to `out` and advances
/// `offset`. A trailing partial line (no newline yet) stays buffered: the
/// offset only advances past bytes that end in a newline, so the next event
/// re-reads the remainder and emits it whole.
pub fn extract_new_lines(offset: &mut u64, bytes: &[u8], out: &mut Vec<String>) {
    let start = (*offset as usize).min(bytes.len());
    let chunk = &bytes[start..];
    let last_newline = match chunk.iter().rposition(|b| *b == b'\n') {
        Some(i) => i,
        None => return,
    };
    let complete = &chunk[..=last_newline];
    *offset += complete.len() as u64;
    for line in complete.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        out.push(String::from_utf8_lossy(line).into_owned());
    }
}

/// Reads a watched file from its tracked offset and emits every new line.
fn tail_file(path: &Path, offset: u64, emit: &mut impl FnMut(TranscriptLine)) -> u64 {
    let mut new_offset = offset;
    let file = std::fs::File::open(path);
    if let Ok(mut file) = file {
        if file.seek(SeekFrom::Start(offset)).is_ok() {
            let mut buf = Vec::new();
            if file.read_to_end(&mut buf).is_ok() {
                let mut lines = Vec::new();
                extract_new_lines(&mut new_offset, &buf, &mut lines);
                let file_str = path.to_string_lossy().into_owned();
                for line in lines {
                    emit(TranscriptLine {
                        file: file_str.clone(),
                        line,
                    });
                }
            }
        }
    }
    new_offset
}

/// Handles one notify event: appends new lines for touched files under the
/// watched root. Pure over its inputs apart from the filesystem tail.
fn handle_event(
    event: &Event,
    root: &Path,
    offsets: &Arc<Mutex<HashMap<PathBuf, u64>>>,
    emit: &mut impl FnMut(TranscriptLine),
) {
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    let mut offsets = offsets.lock().expect("transcript offsets poisoned");
    for path in &event.paths {
        // Backend paths may differ from the watched root by symlink prefix
        // (macOS /var vs /private/var): canonicalize before comparing.
        let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.clone());
        if !path.is_file() || !path.starts_with(root) {
            continue;
        }
        let offset = offsets.get(&path).copied().unwrap_or(0);
        let new_offset = tail_file(&path, offset, emit);
        if new_offset != offset {
            offsets.insert(path.clone(), new_offset);
        }
    }
}

/// Watches `<agent_dir>/agent-hub` recursively and calls `emit` once per new
/// JSONL line. The hub dir is created if missing so a watch can be armed
/// before the first pi run. `emit` is Fn + Clone: notify hands every event to
/// the same shared closure and the Tauri Channel / mpsc Sender are both Clone.
pub fn watch_with<E>(agent_dir: &Path, emit: E) -> Result<WatchHandle, String>
where
    E: Fn(TranscriptLine) + Clone + Send + 'static,
{
    let hub = agent_dir.join("agent-hub");
    std::fs::create_dir_all(&hub)
        .map_err(|e| format!("cannot create transcript hub dir: {e}"))?;
    let hub = std::fs::canonicalize(&hub)
        .map_err(|e| format!("cannot resolve transcript hub dir: {e}"))?;

    let offsets: Arc<Mutex<HashMap<PathBuf, u64>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let offsets_for_cb = Arc::clone(&offsets);
    let hub_for_cb = hub.clone();
    let emit_for_cb = emit.clone();
    let watcher = notify::recommended_watcher(
        move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            handle_event(&event, &hub_for_cb, &offsets_for_cb, &mut |l| {
                emit_for_cb(l)
            });
        },
    )
    .map_err(|e| format!("cannot watch transcripts: {e}"))?;
    let mut watcher = watcher;
    watcher
        .watch(&hub, RecursiveMode::Recursive)
        .map_err(|e| format!("cannot watch {}: {e}", hub.display()))?;

    Ok(WatchHandle {
        watcher: TranscriptWatcher {
            _watcher: watcher,
            offsets,
        },
        root: hub,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{Duration, Instant};

    #[test]
    fn extract_new_lines_only_yields_complete_lines_in_order() {
        let mut offset = 0u64;
        let mut out = Vec::new();
        extract_new_lines(&mut offset, b"{\"a\":1}\n{\"b\":", &mut out);
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
        assert_eq!(offset, 8);
        extract_new_lines(&mut offset, b"{\"a\":1}\n{\"b\":2}\n{\"c\":", &mut out);
        assert_eq!(
            out,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
        assert_eq!(offset, 16);
    }

    #[test]
    fn watcher_streams_appended_lines_in_order() {
        use std::sync::mpsc;
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().to_path_buf();
        let (tx, rx) = mpsc::channel();
        let handle = watch_with(&agent_dir, move |line: TranscriptLine| {
            tx.send(line).expect("send");
        })
        .expect("watch");
        let file = agent_dir.join("agent-hub").join("9").join("scout-1.transcript.jsonl");
        std::fs::create_dir_all(file.parent().expect("parent")).expect("mkdir");

        // Notify needs the file to exist before append events carry data.
        std::fs::File::create(&file).expect("create");
        std::thread::sleep(Duration::from_millis(200));

        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .expect("open append");
        write!(f, "{{\"type\":\"agent_start\"}}\n").expect("write 1");
        f.flush().expect("flush 1");
        write!(f, "{{\"type\":\"turn_start\",\"turnIndex\":0}}\n").expect("write 2");
        f.flush().expect("flush 2");
        drop(f);

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut got: Vec<String> = Vec::new();
        while got.len() < 2 && Instant::now() < deadline {
            if let Ok(line) = rx.recv_timeout(Duration::from_secs(2)) {
                got.push(line.line);
            }
        }
        assert_eq!(
            got,
            vec![
                "{\"type\":\"agent_start\"}".to_string(),
                "{\"type\":\"turn_start\",\"turnIndex\":0}".to_string(),
            ]
        );
        drop(handle);
    }
}

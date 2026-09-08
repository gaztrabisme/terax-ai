use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::modules::fs::file::write_atomic;
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Event {
    Start,
    Output,
    Finish,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Exit {
    Code(i32),
    Status(String),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub v: u8,
    pub seq: u64,
    pub terminal_id: String,
    pub block_id: String,
    pub event: Event,
    pub command: String,
    pub command_truncated: bool,
    pub cwd: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub exit: Exit,
    pub output_path: String,
    pub output_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct StorageError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

fn error(path: &Path, message: impl std::fmt::Display) -> StorageError {
    StorageError {
        path: path.to_string_lossy().into_owned(),
        message: message.to_string(),
    }
}

type Result<T> = std::result::Result<T, StorageError>;

#[derive(Clone)]
pub struct ProjectRoot(PathBuf);

impl ProjectRoot {
    pub fn authorized(
        registry: &WorkspaceRegistry,
        project: &str,
        workspace: &WorkspaceEnv,
    ) -> Result<Self> {
        let path = resolve_path(project, workspace);
        let canonical = fs::canonicalize(&path).map_err(|e| error(&path, e))?;
        if !canonical.is_dir() || !registry.is_authorized(&canonical) {
            return Err(error(&path, "outside an authorized project root"));
        }
        Ok(Self(canonical))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    fn checked(&self, relative: &Path) -> Result<PathBuf> {
        let mut path = self.0.clone();
        for component in relative.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err(error(relative, "invalid terminal path"));
            }
            path.push(component);
            match fs::symlink_metadata(&path) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        return Err(error(&path, "terminal paths cannot be symlinks"));
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::MetadataExt;
                        if meta.is_file() && meta.nlink() > 1 {
                            return Err(error(&path, "terminal files cannot be hard links"));
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(error(&path, e)),
            }
        }
        Ok(path)
    }

    fn directory(&self, relative: &Path) -> Result<PathBuf> {
        let path = self.checked(relative)?;
        fs::create_dir_all(&path).map_err(|e| error(&path, e))?;
        self.checked(relative)
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub fn opaque_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos:x}-{:x}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn terminal_dir(id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(error(Path::new(id), "invalid terminal id"));
    }
    Ok(PathBuf::from(".pi/terminal").join(id))
}

fn output_path(terminal: &str, block: &str) -> String {
    format!(".pi/terminal/{terminal}/output/{block}.ansi")
}

pub fn flatten_command(text: &str) -> (String, bool) {
    let mut chars = text.chars();
    let command = chars
        .by_ref()
        .take(256)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    (command, chars.next().is_some())
}

fn utc(time: SystemTime) -> String {
    let time = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = time.as_secs();
    let mut days = secs / 86400;
    let leap = |y: u64| y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400));
    let mut year = 1970;
    loop {
        let count = if leap(year) { 366 } else { 365 };
        if days < count {
            break;
        }
        days -= count;
        year += 1;
    }
    let months = [
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
    let mut month = 0;
    while days >= months[month] {
        days -= months[month];
        month += 1;
    }
    format!(
        "{year:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        month + 1,
        days + 1,
        secs % 86400 / 3600,
        secs % 3600 / 60,
        secs % 60,
        time.subsec_millis()
    )
}

#[derive(Clone, Default)]
struct OscParser {
    mode: u8,
    start: u64,
    position: u64,
    body: Vec<u8>,
    oversized: bool,
}

struct Osc {
    body: String,
    start: u64,
    end: u64,
    oversized: bool,
}

impl OscParser {
    fn feed(&mut self, bytes: &[u8]) -> Vec<Osc> {
        let mut events = Vec::new();
        for &byte in bytes {
            let offset = self.position;
            self.position += 1;
            match (self.mode, byte) {
                (0, 0x1b) => {
                    self.mode = 1;
                    self.start = offset;
                }
                (1, b']') => {
                    self.mode = 2;
                    self.body.clear();
                    self.oversized = false;
                }
                (1, 0x1b) => self.start = offset,
                (1, _) => self.mode = 0,
                (2, 7) | (3, b'\\') => {
                    events.push(Osc {
                        body: String::from_utf8_lossy(&self.body).into_owned(),
                        start: self.start,
                        end: self.position,
                        oversized: self.oversized,
                    });
                    self.mode = 0;
                }
                (2, 0x1b) => self.mode = 3,
                (2, _) => {
                    if self.body.len() < 4096 {
                        self.body.push(byte);
                    } else {
                        self.oversized = true;
                    }
                }
                (3, _) => self.mode = 0,
                _ => {}
            }
        }
        events
    }

    fn safe_end(&self) -> u64 {
        if self.mode == 0 {
            self.position
        } else {
            self.start
        }
    }
}

fn cwd_from_osc(body: &str) -> Option<String> {
    let rest = body.strip_prefix("7;file://")?;
    let path = &rest[rest.find('/')?..];
    let mut bytes = Vec::new();
    let mut i = 0;
    while i < path.len() {
        if path.as_bytes()[i] == b'%' && i + 2 < path.len() {
            if let Ok(byte) = u8::from_str_radix(path.get(i + 1..i + 3)?, 16) {
                bytes.push(byte);
                i += 3;
                continue;
            }
        }
        bytes.push(path.as_bytes()[i]);
        i += 1;
    }
    let path = String::from_utf8(bytes).ok()?;
    if path.chars().any(char::is_control) {
        return None;
    }
    Some(if path.as_bytes().get(2) == Some(&b':') {
        path[1..].into()
    } else {
        path
    })
}

#[derive(Clone)]
struct Active {
    record: Record,
    start: u64,
    end: u64,
    clock: Option<Instant>,
}

#[derive(Clone, Default)]
struct State {
    seq: u64,
    log_bytes: u64,
    parser: OscParser,
    active: Option<Active>,
    cwd: String,
    in_command: bool,
    prompt_end: Option<u64>,
    truncated: bool,
}

enum Operation {
    Append {
        path: PathBuf,
        offset: u64,
        bytes: Vec<u8>,
    },
    Slice {
        path: PathBuf,
        start: u64,
        end: u64,
        offset: u64,
    },
    Empty(PathBuf),
}

struct Transaction {
    next: State,
    operations: VecDeque<Operation>,
    records: Vec<Record>,
}

pub struct Journal {
    pub root: ProjectRoot,
    pub terminal_id: String,
    dir: PathBuf,
    state: State,
    pending: Option<Transaction>,
}

impl Journal {
    pub fn new(root: ProjectRoot, terminal_id: String, cwd: String) -> Result<Self> {
        let dir = terminal_dir(&terminal_id)?;
        Ok(Self {
            root,
            terminal_id,
            dir,
            state: State {
                cwd,
                ..State::default()
            },
            pending: None,
        })
    }

    pub fn commit(&mut self, bytes: &[u8], eof: bool) -> Result<Vec<Record>> {
        if self.pending.is_none() {
            self.pending = Some(self.plan(bytes, eof)?);
        }
        self.root.directory(&self.dir.join("output"))?;
        let stream = self.root.checked(&self.dir.join("stream.ansi"))?;
        let transaction = self.pending.as_mut().expect("planned transaction");
        while let Some(operation) = transaction.operations.front() {
            match operation {
                Operation::Append {
                    path,
                    offset,
                    bytes,
                } => {
                    let path = self.root.checked(path)?;
                    append_at(&path, *offset, bytes)?;
                }
                Operation::Empty(path) => {
                    let path = self.root.checked(path)?;
                    if !path.exists() {
                        write_atomic(&path, &[]).map_err(|e| error(&path, e))?;
                    }
                }
                Operation::Slice {
                    path,
                    start,
                    end,
                    offset,
                } => {
                    let path = self.root.checked(path)?;
                    copy_slice(&stream, &path, *start, *end, *offset)?;
                }
            }
            transaction.operations.pop_front();
        }
        let transaction = self.pending.take().expect("committed transaction");
        self.state = transaction.next;
        Ok(transaction.records)
    }

    fn plan(&self, bytes: &[u8], eof: bool) -> Result<Transaction> {
        let mut tx = Transaction {
            next: self.state.clone(),
            operations: VecDeque::new(),
            records: Vec::new(),
        };
        tx.operations.push_back(Operation::Append {
            path: self.dir.join("stream.ansi"),
            offset: tx.next.parser.position,
            bytes: bytes.to_vec(),
        });
        tx.operations
            .push_back(Operation::Empty(self.dir.join("blocks.jsonl")));
        let events = tx.next.parser.feed(bytes);
        for osc in events {
            if osc.body == "133;C" || osc.body.starts_with("133;C;") {
                self.close(&mut tx, osc.start, None, true)?;
                let (command, truncated) =
                    flatten_command(osc.body.strip_prefix("133;C;").unwrap_or(""));
                let truncated = truncated || osc.oversized || tx.next.truncated;
                self.start(&mut tx, osc.end, command, truncated, true)?;
                tx.next.truncated = false;
                tx.next.in_command = true;
            } else if osc.body == "133;D" || osc.body.starts_with("133;D;") {
                if tx.next.active.is_none() {
                    if let Some(start) = tx.next.prompt_end {
                        self.start(&mut tx, start, String::new(), false, false)?;
                    }
                }
                let exit = osc
                    .body
                    .strip_prefix("133;D;")
                    .and_then(|s| s.parse::<i32>().ok());
                self.close(&mut tx, osc.start, exit, false)?;
                tx.next.in_command = false;
                tx.next.prompt_end = None;
            } else if osc.body == "133;A" {
                self.close(&mut tx, osc.start, None, true)?;
                tx.next.in_command = false;
                tx.next.prompt_end = None;
            } else if osc.body == "133;B" {
                tx.next.prompt_end = Some(osc.end);
                tx.next.in_command = true;
            } else if osc.body == "133;T;1" || osc.body == "133;T;0" {
                tx.next.truncated = osc.body.ends_with('1');
            } else if !tx.next.in_command {
                if let Some(cwd) = cwd_from_osc(&osc.body) {
                    tx.next.cwd = cwd;
                }
            }
        }
        let end = if eof {
            tx.next.parser.position
        } else {
            tx.next.parser.safe_end()
        };
        if eof {
            self.close(&mut tx, end, None, true)?;
        } else {
            self.output(&mut tx, end)?;
        }
        Ok(tx)
    }

    fn record(&self, tx: &mut Transaction, mut record: Record) -> Result<()> {
        tx.next.seq += 1;
        record.seq = tx.next.seq;
        let mut bytes =
            serde_json::to_vec(&record).map_err(|e| error(&self.dir.join("blocks.jsonl"), e))?;
        bytes.push(b'\n');
        let offset = tx.next.log_bytes;
        tx.next.log_bytes += bytes.len() as u64;
        tx.operations.push_back(Operation::Append {
            path: self.dir.join("blocks.jsonl"),
            offset,
            bytes,
        });
        tx.records.push(record);
        Ok(())
    }

    fn start(
        &self,
        tx: &mut Transaction,
        offset: u64,
        command: String,
        truncated: bool,
        timed: bool,
    ) -> Result<()> {
        let block_id = opaque_id();
        let record = Record {
            v: 1,
            seq: 0,
            terminal_id: self.terminal_id.clone(),
            output_path: output_path(&self.terminal_id, &block_id),
            block_id,
            event: Event::Start,
            command,
            command_truncated: truncated,
            cwd: tx.next.cwd.clone(),
            started_at: timed.then(|| utc(SystemTime::now())),
            ended_at: None,
            duration_ms: None,
            exit: Exit::Status("running".into()),
            output_bytes: 0,
        };
        tx.operations
            .push_back(Operation::Empty(PathBuf::from(&record.output_path)));
        self.record(tx, record.clone())?;
        tx.next.active = Some(Active {
            record,
            start: offset,
            end: offset,
            clock: timed.then(Instant::now),
        });
        Ok(())
    }

    fn output(&self, tx: &mut Transaction, end: u64) -> Result<()> {
        let Some(active) = tx.next.active.as_mut() else {
            return Ok(());
        };
        if end <= active.end {
            return Ok(());
        }
        tx.operations.push_back(Operation::Slice {
            path: PathBuf::from(&active.record.output_path),
            start: active.end,
            end,
            offset: active.end - active.start,
        });
        active.end = end;
        active.record.event = Event::Output;
        active.record.output_bytes = end - active.start;
        let record = active.record.clone();
        self.record(tx, record)
    }

    fn close(
        &self,
        tx: &mut Transaction,
        end: u64,
        exit: Option<i32>,
        interrupted: bool,
    ) -> Result<()> {
        self.output(tx, end)?;
        let Some(mut active) = tx.next.active.take() else {
            return Ok(());
        };
        active.record.event = if interrupted {
            Event::Interrupted
        } else {
            Event::Finish
        };
        active.record.ended_at = Some(utc(SystemTime::now()));
        active.record.duration_ms = if interrupted {
            None
        } else {
            active.clock.map(|c| c.elapsed().as_millis() as u64)
        };
        active.record.exit = exit
            .map(Exit::Code)
            .unwrap_or_else(|| Exit::Status("unknown".into()));
        // Re-read the whole range before publishing the final byte count.
        tx.operations.push_back(Operation::Slice {
            path: PathBuf::from(&active.record.output_path),
            start: active.start,
            end: active.end,
            offset: 0,
        });
        self.record(tx, active.record)
    }
}

fn append_at(path: &Path, offset: u64, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.read(true).append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|e| error(path, e))?;
    let len = file.metadata().map_err(|e| error(path, e))?.len();
    if len < offset || len > offset + bytes.len() as u64 {
        return Err(error(path, "unexpected append offset"));
    }
    let existing = (len - offset) as usize;
    let mut prefix = vec![0; existing];
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut prefix))
        .map_err(|e| error(path, e))?;
    if prefix != bytes[..existing] {
        return Err(error(path, "append verification failed"));
    }
    file.write_all(&bytes[existing..])
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|e| error(path, e))
}

fn copy_slice(stream: &Path, output: &Path, start: u64, end: u64, offset: u64) -> Result<()> {
    if end < start {
        return Err(error(output, "invalid stream range"));
    }
    let mut source = File::open(stream).map_err(|e| error(stream, e))?;
    if source.metadata().map_err(|e| error(stream, e))?.len() < end {
        return Err(error(stream, "stream range exceeds file"));
    }
    source
        .seek(SeekFrom::Start(start))
        .map_err(|e| error(stream, e))?;
    let mut done = 0;
    let mut buffer = [0; 64 * 1024];
    while done < end - start {
        let count = ((end - start - done) as usize).min(buffer.len());
        source
            .read_exact(&mut buffer[..count])
            .map_err(|e| error(stream, e))?;
        let target_offset = offset + done;
        let len = fs::metadata(output).map_err(|e| error(output, e))?.len();
        if len > target_offset + count as u64 {
            let mut target = File::open(output).map_err(|e| error(output, e))?;
            target
                .seek(SeekFrom::Start(target_offset))
                .map_err(|e| error(output, e))?;
            let mut actual = vec![0; count];
            target
                .read_exact(&mut actual)
                .map_err(|e| error(output, e))?;
            if actual != buffer[..count] {
                return Err(error(output, "slice verification failed"));
            }
        } else {
            append_at(output, target_offset, &buffer[..count])?;
        }
        done += count as u64;
    }
    let file = OpenOptions::new()
        .write(true)
        .open(output)
        .map_err(|e| error(output, e))?;
    if file.metadata().map_err(|e| error(output, e))?.len() != offset + end - start {
        return Err(error(output, "slice length verification failed"));
    }
    file.sync_all().map_err(|e| error(output, e))
}

pub fn read_records(root: &ProjectRoot, terminal: &str) -> Result<Vec<Record>> {
    let path = root.checked(&terminal_dir(terminal)?.join("blocks.jsonl"))?;
    let bytes = fs::read(&path).map_err(|e| error(&path, e))?;
    let mut records = Vec::new();
    let mut previous = 0;
    let mut open: Option<Record> = None;
    let mut closed = std::collections::HashSet::new();
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        if line.last() != Some(&b'\n') {
            return Err(error(&path, "incomplete journal record"));
        }
        let record: Record = serde_json::from_slice(line).map_err(|e| error(&path, e))?;
        if record.v != 1
            || record.seq != previous + 1
            || record.terminal_id != terminal
            || !valid_id(&record.block_id)
            || record.output_path != output_path(terminal, &record.block_id)
            || flatten_command(&record.command).0 != record.command
        {
            return Err(error(&path, "invalid journal record"));
        }
        let finished = matches!(record.event, Event::Finish | Event::Interrupted);
        if (finished && record.exit == Exit::Status("running".into()))
            || (!finished
                && (record.exit != Exit::Status("running".into())
                    || record.ended_at.is_some()
                    || record.duration_ms.is_some()))
            || (record.event == Event::Interrupted
                && (record.exit != Exit::Status("unknown".into()) || record.duration_ms.is_some()))
            || matches!(&record.exit, Exit::Status(s) if s != "running" && s != "unknown")
            || closed.contains(&record.block_id)
        {
            return Err(error(&path, "invalid journal status"));
        }
        if record.event == Event::Start {
            if open.is_some() || record.output_bytes != 0 {
                return Err(error(&path, "overlapping journal blocks"));
            }
        } else {
            let prior = open
                .as_ref()
                .ok_or_else(|| error(&path, "block start missing"))?;
            if prior.block_id != record.block_id
                || prior.command != record.command
                || prior.command_truncated != record.command_truncated
                || prior.cwd != record.cwd
                || prior.started_at != record.started_at
                || prior.output_bytes > record.output_bytes
            {
                return Err(error(&path, "inconsistent journal block"));
            }
        }
        open = if finished {
            closed.insert(record.block_id.clone());
            None
        } else {
            Some(record.clone())
        };
        previous = record.seq;
        records.push(record);
    }
    Ok(records)
}

struct Scan {
    ranges: Vec<(u64, u64)>,
    cwd: String,
}

fn scan_stream(path: &Path, initial_cwd: &str) -> Result<Scan> {
    let mut file = File::open(path).map_err(|e| error(path, e))?;
    let mut parser = OscParser::default();
    let mut scan = Scan {
        ranges: Vec::new(),
        cwd: initial_cwd.into(),
    };
    let mut active = None;
    let mut prompt = None;
    let mut in_command = false;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| error(path, e))?;
        if count == 0 {
            break;
        }
        for osc in parser.feed(&buffer[..count]) {
            if osc.body == "133;C" || osc.body.starts_with("133;C;") {
                if let Some(start) = active.take() {
                    scan.ranges.push((start, osc.start));
                }
                active = Some(osc.end);
                in_command = true;
            } else if osc.body == "133;D" || osc.body.starts_with("133;D;") {
                if let Some(start) = active.take().or(prompt) {
                    scan.ranges.push((start, osc.start));
                }
                prompt = None;
                in_command = false;
            } else if osc.body == "133;A" {
                if let Some(start) = active.take() {
                    scan.ranges.push((start, osc.start));
                }
                prompt = None;
                in_command = false;
            } else if osc.body == "133;B" {
                prompt = Some(osc.end);
                in_command = true;
            } else if !in_command {
                if let Some(cwd) = cwd_from_osc(&osc.body) {
                    scan.cwd = cwd;
                }
            }
        }
    }
    if let Some(start) = active {
        scan.ranges.push((start, parser.position));
    }
    Ok(scan)
}

fn repair_incomplete_tail(root: &ProjectRoot, terminal: &str) -> Result<()> {
    let path = root.checked(&terminal_dir(terminal)?.join("blocks.jsonl"))?;
    let bytes = fs::read(&path).map_err(|e| error(&path, e))?;
    if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
        let length = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        let mut file = OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|e| error(&path, e))?;
        file.set_len(length as u64)
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(|e| error(&path, e))?;
    }
    Ok(())
}

pub fn history(root: &ProjectRoot, terminal: &str, active: bool) -> Result<Vec<Record>> {
    if !active {
        repair_incomplete_tail(root, terminal)?;
    }
    let mut records = read_records(root, terminal)?;
    if !active {
        if let Some(last) = records
            .last()
            .filter(|r| matches!(r.event, Event::Start | Event::Output))
            .cloned()
        {
            let dir = terminal_dir(terminal)?;
            let stream = root.checked(&dir.join("stream.ansi"))?;
            let scan = scan_stream(&stream, &last.cwd)?;
            let index = records.iter().filter(|r| r.event == Event::Start).count() - 1;
            let (start, end) = *scan
                .ranges
                .get(index)
                .ok_or_else(|| error(&stream, "unfinished block range missing"))?;
            let output = root.checked(Path::new(&last.output_path))?;
            if !output.exists() {
                write_atomic(&output, &[]).map_err(|e| error(&output, e))?;
            }
            copy_slice(&stream, &output, start, end, 0)?;
            let record = Record {
                seq: last.seq + 1,
                event: Event::Interrupted,
                ended_at: Some(utc(SystemTime::now())),
                duration_ms: None,
                exit: Exit::Status("unknown".into()),
                output_bytes: end - start,
                ..last
            };
            let path = root.checked(&dir.join("blocks.jsonl"))?;
            let offset = fs::metadata(&path).map_err(|e| error(&path, e))?.len();
            let mut bytes = serde_json::to_vec(&record).map_err(|e| error(&path, e))?;
            bytes.push(b'\n');
            append_at(&path, offset, &bytes)?;
            records.push(record);
        }
    }
    Ok(records)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub terminal_id: String,
    pub cwd: String,
    pub time: String,
    pub stream_bytes: u64,
}

pub fn list(root: &ProjectRoot, active_ids: &[String]) -> Result<Vec<TerminalInfo>> {
    let path = root.checked(Path::new(".pi/terminal"))?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut terminals = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| error(&path, e))? {
        let entry = entry.map_err(|e| error(&path, e))?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&id) || active_ids.contains(&id) {
            continue;
        }
        let records = history(root, &id, false)?;
        let stream = root.checked(&terminal_dir(&id)?.join("stream.ansi"))?;
        let initial = records
            .last()
            .map(|r| r.cwd.as_str())
            .unwrap_or_else(|| root.0.to_str().unwrap_or(""));
        let scan = scan_stream(&stream, initial)?;
        let time = fs::metadata(&stream)
            .and_then(|m| m.modified())
            .map_err(|e| error(&stream, e))?;
        terminals.push(TerminalInfo {
            terminal_id: id,
            cwd: scan.cwd,
            time: utc(time),
            stream_bytes: fs::metadata(&stream).map_err(|e| error(&stream, e))?.len(),
        });
    }
    terminals.sort_by(|a, b| b.time.cmp(&a.time));
    Ok(terminals)
}

pub fn read_output(
    root: &ProjectRoot,
    terminal: &str,
    block: Option<&str>,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>> {
    if block.is_some_and(|id| !valid_id(id)) || length > 1024 * 1024 {
        return Err(error(root.path(), "invalid block range"));
    }
    let (path, committed_bytes) = if let Some(block) = block {
        let records = read_records(root, terminal)?;
        let record = records
            .iter()
            .rev()
            .find(|r| r.block_id == block)
            .ok_or_else(|| error(root.path(), "block not found"))?;
        (
            root.checked(Path::new(&record.output_path))?,
            record.output_bytes,
        )
    } else {
        let path = root.checked(&terminal_dir(terminal)?.join("stream.ansi"))?;
        let bytes = fs::metadata(&path).map_err(|e| error(&path, e))?.len();
        (path, bytes)
    };
    if offset > committed_bytes || length as u64 > committed_bytes - offset {
        return Err(error(&path, "range exceeds committed output"));
    }
    let mut file = File::open(&path).map_err(|e| error(&path, e))?;
    let mut bytes = vec![0; length];
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut bytes))
        .map_err(|e| error(&path, e))?;
    Ok(bytes)
}

pub fn export_output(root: &ProjectRoot, terminal: &str, block: &str) -> Result<String> {
    let records = read_records(root, terminal)?;
    let record = records
        .iter()
        .rev()
        .find(|r| r.block_id == block && matches!(r.event, Event::Finish | Event::Interrupted))
        .ok_or_else(|| error(root.path(), "finished block not found"))?;
    let source = root.checked(Path::new(&record.output_path))?;
    let mut bytes = Vec::new();
    File::open(&source)
        .and_then(|f| f.take(record.output_bytes).read_to_end(&mut bytes))
        .map_err(|e| error(&source, e))?;
    if bytes.len() as u64 != record.output_bytes {
        return Err(error(&source, "incomplete block file range"));
    }
    let raw = String::from_utf8_lossy(&bytes);
    let mut mode = 0;
    let mut text = String::new();
    for ch in raw.chars() {
        match (mode, ch) {
            (0, '\x1b') => mode = 1,
            (0, _) => text.push(ch),
            (1, '[') => mode = 2,
            (1, ']') => mode = 3,
            (1, '(' | ')') => mode = 5,
            (1 | 5, _) => mode = 0,
            (2, '@'..='~') => mode = 0,
            (3, '\x07') | (4, '\\') => mode = 0,
            (3, '\x1b') => mode = 4,
            (4, _) => mode = 3,
            _ => {}
        }
    }
    let relative = format!(".pi/terminal/{terminal}/output/{block}.txt");
    let path = root.checked(Path::new(&relative))?;
    write_atomic(&path, text.replace("\r\n", "\n").as_bytes()).map_err(|e| error(&path, e))?;
    Ok(relative)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Journal) {
        let dir = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(dir.path()).unwrap();
        let root = ProjectRoot::authorized(
            &registry,
            dir.path().to_str().unwrap(),
            &WorkspaceEnv::Local,
        )
        .unwrap();
        let journal =
            Journal::new(root, opaque_id(), dir.path().to_string_lossy().into_owned()).unwrap();
        (dir, journal)
    }

    fn records(journal: &Journal) -> Vec<Record> {
        read_records(&journal.root, &journal.terminal_id).unwrap()
    }

    #[test]
    fn record_shape_and_output_are_committed_before_publication() {
        let (_dir, mut journal) = fixture();
        let raw = b"prompt\x1b]133;C;echo hello\x1b\\hello\r\n\x1b]133;D;0\x1b\\next prompt\0\xff";
        let events = journal.commit(raw, false).unwrap();
        assert_eq!(
            events.iter().map(|r| r.event.clone()).collect::<Vec<_>>(),
            [Event::Start, Event::Output, Event::Finish]
        );
        assert_eq!(
            fs::read(journal.root.0.join(&journal.dir).join("stream.ansi")).unwrap(),
            raw
        );
        let record = events.last().unwrap();
        let value = serde_json::to_value(record).unwrap();
        let mut keys: Vec<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut expected = vec![
            "v",
            "seq",
            "terminalId",
            "blockId",
            "event",
            "command",
            "commandTruncated",
            "cwd",
            "startedAt",
            "endedAt",
            "durationMs",
            "exit",
            "outputPath",
            "outputBytes",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        assert_eq!(record.exit, Exit::Code(0));
        assert_eq!(record.output_bytes, 7);
        assert_eq!(
            fs::read(journal.root.0.join(&record.output_path)).unwrap(),
            b"hello\r\n"
        );
        assert!(record.started_at.as_ref().unwrap().ends_with('Z'));
        assert!(record.ended_at.as_ref().unwrap().ends_with('Z'));
        assert!(record.duration_ms.is_some());
        assert!(events[0].duration_ms.is_none());
        assert_eq!(records(&journal).len(), events.len());
    }

    #[test]
    fn flatten_caps_unicode_characters_and_preserves_semicolons() {
        assert_eq!(
            flatten_command("echo a;\nb\tc\r\u{0085}"),
            ("echo a; b c  ".into(), false)
        );
        assert_eq!(
            flatten_command(&"界".repeat(256)),
            ("界".repeat(256), false)
        );
        assert_eq!(flatten_command(&"界".repeat(257)), ("界".repeat(256), true));
    }

    #[test]
    fn hook_truncation_marker_survives_split_sequences() {
        let (_dir, mut journal) = fixture();
        for chunk in format!("\x1b]133;T;1\x1b\\\x1b]133;C;{}\x1b\\", "x".repeat(256))
            .as_bytes()
            .chunks(3)
        {
            journal.commit(chunk, false).unwrap();
        }
        journal.commit(b"output\x1b]133;D;1\x1b\\", false).unwrap();
        let record = records(&journal).pop().unwrap();
        assert!(record.command_truncated);
        assert_eq!(record.command.len(), 256);
        assert_eq!(record.exit, Exit::Code(1));
    }

    #[test]
    fn slices_exclude_split_finish_markers_and_include_all_binary_output() {
        let (_dir, mut journal) = fixture();
        journal
            .commit(b"\x1b]133;C;cat\x07a\0\xff\x1b]133;", false)
            .unwrap();
        let record = records(&journal).pop().unwrap();
        assert_eq!(record.output_bytes, 3);
        journal.commit(b"D;7\x1b\\prompt", false).unwrap();
        let record = records(&journal).pop().unwrap();
        assert_eq!(
            read_output(
                &journal.root,
                &journal.terminal_id,
                Some(&record.block_id),
                0,
                3
            )
            .unwrap(),
            b"a\0\xff"
        );
        assert!(read_output(
            &journal.root,
            &journal.terminal_id,
            Some(&record.block_id),
            2,
            2
        )
        .is_err());
    }

    #[test]
    fn slice_verification_refuses_corrupt_and_out_of_bounds_output() {
        let (_dir, mut journal) = fixture();
        journal
            .commit(b"\x1b]133;C;echo hello\x07hello", false)
            .unwrap();
        let record = records(&journal).pop().unwrap();
        let output = journal.root.0.join(&record.output_path);
        fs::write(&output, b"wrong").unwrap();
        let error = journal.commit(b"\x1b]133;D;0\x07", false).unwrap_err();
        assert_eq!(error.path, output.to_string_lossy());
        assert!(!records(&journal).iter().any(|r| r.event == Event::Finish));
        let stream = journal.root.0.join(&journal.dir).join("stream.ansi");
        assert!(copy_slice(&stream, &output, 0, u64::MAX, 0).is_err());
    }

    #[test]
    fn replay_marks_only_unfinished_block_interrupted_and_is_idempotent() {
        let (_dir, mut journal) = fixture();
        journal
            .commit(
                b"\x1b]133;C;true\x07yes\x1b]133;D;0\x07\x1b]133;C;sleep 99\x07waiting",
                false,
            )
            .unwrap();
        let before = records(&journal);
        let stream = journal.root.0.join(&journal.dir).join("stream.ansi");
        let mut raw = OpenOptions::new().append(true).open(stream).unwrap();
        raw.write_all(b" tail").unwrap();
        raw.sync_all().unwrap();
        let restored = history(&journal.root, &journal.terminal_id, false).unwrap();
        assert_eq!(restored.len(), before.len() + 1);
        let last = restored.last().unwrap();
        assert_eq!(last.event, Event::Interrupted);
        assert_eq!(last.exit, Exit::Status("unknown".into()));
        assert_eq!(last.duration_ms, None);
        assert_eq!(
            fs::read(journal.root.0.join(&last.output_path)).unwrap(),
            b"waiting tail"
        );
        assert_eq!(
            history(&journal.root, &journal.terminal_id, false)
                .unwrap()
                .len(),
            restored.len()
        );
        assert_eq!(
            restored.iter().filter(|r| r.event == Event::Finish).count(),
            1
        );
    }

    #[test]
    fn live_history_does_not_interrupt_and_eof_never_invents_success() {
        let (_dir, mut journal) = fixture();
        journal
            .commit(b"\x1b]133;C;read password\x07", false)
            .unwrap();
        let live = history(&journal.root, &journal.terminal_id, true).unwrap();
        assert_eq!(live.last().unwrap().exit, Exit::Status("running".into()));
        journal.commit(&[], true).unwrap();
        let last = records(&journal).pop().unwrap();
        assert_eq!(last.event, Event::Interrupted);
        assert_eq!(last.exit, Exit::Status("unknown".into()));
        assert_eq!(last.output_bytes, 0);
    }

    #[test]
    fn refuses_outside_authorized_project_and_unsafe_ids() {
        let allowed = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(allowed.path()).unwrap();
        assert!(ProjectRoot::authorized(
            &registry,
            outside.path().to_str().unwrap(),
            &WorkspaceEnv::Local
        )
        .err()
        .unwrap()
        .message
        .contains("authorized"));
        for id in ["../outside", "a/b", "a\\b", "", ".env"] {
            assert!(terminal_dir(id).is_err());
        }
        assert!(!outside.path().join(".pi").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_and_hard_link_escape() {
        let (_dir, mut journal) = fixture();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), journal.root.0.join(".pi")).unwrap();
        assert!(journal
            .commit(b"private", false)
            .unwrap_err()
            .message
            .contains("symlink"));
        assert!(!outside.path().join("terminal").exists());
        fs::remove_file(journal.root.0.join(".pi")).unwrap();
        journal.commit(b"private", false).unwrap();
        let stream = journal.root.0.join(&journal.dir).join("stream.ansi");
        fs::hard_link(&stream, outside.path().join("linked")).unwrap();
        assert!(journal
            .commit(b"more", false)
            .unwrap_err()
            .message
            .contains("hard link"));
    }

    #[test]
    fn append_failure_reports_path_and_retry_does_not_duplicate_bytes_or_records() {
        let (_dir, mut journal) = fixture();
        journal.commit(&[], false).unwrap();
        let path = journal.root.0.join(&journal.dir).join("blocks.jsonl");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let input = b"\x1b]133;C;echo hi\x07hi\x1b]133;D;0\x07";
        let error = journal.commit(input, false).unwrap_err();
        assert_eq!(error.path, path.to_string_lossy());
        assert!(!error.message.is_empty());
        let event = serde_json::to_value(super::super::session::JournalEvent::from(error)).unwrap();
        assert_eq!(event["kind"], "storage-error");
        assert_eq!(event["path"], path.to_string_lossy().as_ref());
        fs::remove_dir(&path).unwrap();
        journal.commit(input, false).unwrap();
        assert_eq!(records(&journal).len(), 3);
        assert_eq!(
            fs::read(journal.root.0.join(&journal.dir).join("stream.ansi")).unwrap(),
            input
        );
    }

    #[test]
    fn partial_append_retries_verified_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("append");
        fs::write(&path, b"prefix:pa").unwrap();
        append_at(&path, 7, b"payload\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"prefix:payload\n");
        assert!(append_at(&path, 7, b"different\n").is_err());
    }

    #[test]
    fn list_reports_last_cwd_and_keeps_history_beyond_render_ring() {
        let (_dir, mut journal) = fixture();
        for _ in 0..201 {
            journal
                .commit(b"\x1b]133;C;true\x07\x1b]133;D;0\x07", false)
                .unwrap();
        }
        journal
            .commit(
                b"\x1b]7;file://host/project/last%20cwd\x07\x1b]133;A\x07prompt",
                false,
            )
            .unwrap();
        let terminals = list(&journal.root, &[]).unwrap();
        assert_eq!(terminals[0].terminal_id, journal.terminal_id);
        assert_eq!(terminals[0].cwd, "/project/last cwd");
        assert!(terminals[0].time.ends_with('Z'));
        assert_eq!(
            history(&journal.root, &journal.terminal_id, false)
                .unwrap()
                .iter()
                .filter(|r| r.event == Event::Finish)
                .count(),
            201
        );
        assert!(list(&journal.root, &[journal.terminal_id.clone()])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn incomplete_record_tail_is_repaired_before_interruption() {
        let (_dir, mut journal) = fixture();
        journal
            .commit(b"\x1b]133;C;sleep 9\x07waiting", false)
            .unwrap();
        let path = journal.root.0.join(&journal.dir).join("blocks.jsonl");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"v\":1,\"seq\":").unwrap();
        file.sync_all().unwrap();
        assert!(read_records(&journal.root, &journal.terminal_id).is_err());
        let restored = history(&journal.root, &journal.terminal_id, false).unwrap();
        assert_eq!(restored.last().unwrap().event, Event::Interrupted);
        assert_eq!(
            restored.last().unwrap().exit,
            Exit::Status("unknown".into())
        );
        assert_eq!(restored.len(), records(&journal).len());
    }

    #[test]
    fn export_reads_saved_bytes_and_refuses_output_symlinks() {
        let (_dir, mut journal) = fixture();
        journal
            .commit(
                b"\x1b]133;C;echo hi\x07\x1b[31mhi\x1b[0m\r\n\x1b]133;D;0\x07",
                false,
            )
            .unwrap();
        let record = records(&journal).pop().unwrap();
        let output = export_output(&journal.root, &journal.terminal_id, &record.block_id).unwrap();
        assert_eq!(fs::read(journal.root.0.join(&output)).unwrap(), b"hi\n");
        #[cfg(unix)]
        {
            let outside = tempfile::NamedTempFile::new().unwrap();
            fs::remove_file(journal.root.0.join(&output)).unwrap();
            std::os::unix::fs::symlink(outside.path(), journal.root.0.join(&output)).unwrap();
            assert!(export_output(&journal.root, &journal.terminal_id, &record.block_id).is_err());
            assert_eq!(fs::read(outside.path()).unwrap(), b"");
        }
    }

    #[test]
    fn storage_failure_blocks_forwarding_until_retry_has_committed_every_file() {
        use super::super::session::JournalControl;
        use std::sync::atomic::AtomicBool;
        use std::sync::{mpsc, Arc};
        let (_dir, mut journal) = fixture();
        journal.commit(&[], false).unwrap();
        let path = journal.root.0.join(&journal.dir).join("blocks.jsonl");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let (sender, receiver) = mpsc::channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sender
                    .send(serde_json::from_str::<serde_json::Value>(&json).unwrap())
                    .unwrap();
            }
            Ok(())
        });
        let control = Arc::new(JournalControl::new(journal, channel));
        let worker_control = control.clone();
        let forwarded = Arc::new(AtomicBool::new(false));
        let worker_forwarded = forwarded.clone();
        let worker = std::thread::spawn(move || {
            if worker_control.persist(b"\x1b]133;C;echo hi\x07hi\x1b]133;D;0\x07", false) {
                worker_forwarded.store(true, Ordering::Release);
            }
        });
        let error = receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(error["kind"], "storage-error");
        assert!(!forwarded.load(Ordering::Acquire));
        assert!(receiver.try_recv().is_err());
        fs::remove_dir(&path).unwrap();
        control.retry();
        worker.join().unwrap();
        assert!(forwarded.load(Ordering::Acquire));
        let events: Vec<_> = receiver.try_iter().collect();
        assert_eq!(events.last().unwrap()["kind"], "saved");
        let journal = control.journal.lock().unwrap();
        let last = records(&journal).pop().unwrap();
        assert_eq!(last.event, Event::Finish);
        assert_eq!(
            fs::read(journal.root.0.join(last.output_path)).unwrap(),
            b"hi"
        );
    }

    #[test]
    fn utc_handles_epoch_and_leap_day() {
        assert_eq!(utc(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            utc(UNIX_EPOCH + std::time::Duration::from_millis(951782400500)),
            "2000-02-29T00:00:00.500Z"
        );
    }
}

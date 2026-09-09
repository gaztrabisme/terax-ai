import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

/**
 * Unit K11c: the two-file draft contract (docs/design.md section 3.4, rows
 * "Chat draft and queued images" and "Editor buffer"). Every draft lives at
 * <project>/.pi/drafts/<tab-id>.md plus <tab-id>.json, where <tab-id> is the
 * tab's stable opaque id (minted by src/modules/tabs/lib/sid.ts), never the
 * numeric list position. The chat record carries the queued-image fields
 * K13 consumes later plus the K8 terminal-block sources; the editor record
 * carries the path and the base hash the Save conflict check compares.
 */

export function draftsDir(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/.pi/drafts`;
}

export function draftPath(cwd: string, tabId: string): string {
  return `${draftsDir(cwd)}/${tabId}.md`;
}

export function draftMetaPath(cwd: string, tabId: string): string {
  return `${draftsDir(cwd)}/${tabId}.json`;
}

/** Legacy pre-K11c name: drafts keyed by the numeric tab position. */
export function numericDraftPath(cwd: string, tabId: number): string {
  return `${draftsDir(cwd)}/${tabId}.md`;
}

/** Legacy K8 sidecar name: <n>.md.json next to the numeric draft. */
export function numericLegacyMetaPath(cwd: string, tabId: number): string {
  return `${numericDraftPath(cwd, tabId)}.json`;
}

async function ensureDraftDir(cwd: string): Promise<void> {
  try {
    await invoke("fs_create_dir", {
      path: draftsDir(cwd),
      workspace: currentWorkspaceEnv(),
    });
  } catch {
    // The draft dir already existing is the normal steady state.
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    const res = await invoke<{ kind: string; content?: string }>(
      "fs_read_file",
      { path, workspace: currentWorkspaceEnv() },
    );
    return res.kind === "text" && typeof res.content === "string"
      ? res.content
      : null;
  } catch {
    return null;
  }
}

async function deleteOrNull(path: string): Promise<void> {
  try {
    await invoke("fs_delete", { path, workspace: currentWorkspaceEnv() });
  } catch {
    // Nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/// K8 sidecar fields: where each transferred terminal block quotation came
/// from. Evidence only, never load-bearing for sending.
export type DraftSourceMeta = {
  blockId: number;
  terminalId: number;
  sha256: string;
  insertedAt: string;
};

/** Queued-image fields per the design row; K13 fills them at send time. */
export type DraftAttachmentMeta = {
  id: string;
  path: string;
  sha256: string;
  mime: string;
  state: string;
};

export type ChatDraftMeta = {
  v: 1;
  submissionId: string | null;
  attachments: DraftAttachmentMeta[];
  sources: DraftSourceMeta[];
};

export type EditorDraftMeta = {
  v: 1;
  kind: "editor";
  path: string;
  baseSha256: string;
};

export type DraftMeta = ChatDraftMeta | EditorDraftMeta;

/** The record a fresh chat draft starts from. */
export function emptyChatMeta(): ChatDraftMeta {
  return { v: 1, submissionId: null, attachments: [], sources: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChatMeta(raw: string): ChatDraftMeta | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.v !== 1 || data.kind === "editor") return null;
  const meta = emptyChatMeta();
  if (typeof data.submissionId === "string") {
    meta.submissionId = data.submissionId;
  }
  if (Array.isArray(data.attachments)) {
    meta.attachments = data.attachments.filter(
      (a): a is DraftAttachmentMeta =>
        isRecord(a) &&
        typeof a.id === "string" &&
        typeof a.path === "string" &&
        typeof a.sha256 === "string" &&
        typeof a.mime === "string" &&
        typeof a.state === "string",
    );
  }
  if (Array.isArray(data.sources)) {
    meta.sources = data.sources.filter(
      (s): s is DraftSourceMeta =>
        isRecord(s) &&
        typeof s.blockId === "number" &&
        typeof s.terminalId === "number" &&
        typeof s.sha256 === "string" &&
        typeof s.insertedAt === "string",
    );
  }
  return meta;
}

function parseEditorMeta(raw: string): EditorDraftMeta | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(data) ||
    data.v !== 1 ||
    data.kind !== "editor" ||
    typeof data.path !== "string" ||
    data.path.length === 0 ||
    typeof data.baseSha256 !== "string" ||
    data.baseSha256.length === 0
  ) {
    return null;
  }
  return {
    v: 1,
    kind: "editor",
    path: data.path,
    baseSha256: data.baseSha256,
  };
}

export function isMissingDraftFile(error: unknown): boolean {
  return /no such file|not found|os error [23]\b/i.test(String(error));
}

async function readRecoveryText(path: string): Promise<string | null> {
  try {
    const res = await invoke<{ kind: string; content?: string }>("fs_read_file", {
      path, workspace: currentWorkspaceEnv(),
    });
    if (res.kind !== "text" || typeof res.content !== "string") {
      throw new Error("Expected a text file");
    }
    return res.content;
  } catch (error) {
    if (isMissingDraftFile(error)) return null;
    throw new Error(`${path}: ${String(error)}`);
  }
}

export type RecoverableDraft = { sid: string; firstLine: string; error?: string };
export type DraftRecord = {
  sid: string;
  markdown: string;
} & (
  | { kind: "chat"; meta: ChatDraftMeta }
  | { kind: "editor"; meta: EditorDraftMeta }
);

// ---------------------------------------------------------------------------
// Recoverable listing (U4)
// ---------------------------------------------------------------------------

/** A queued attachment counts toward the offer only while its file exists. */
async function attachmentFileExists(cwd: string, path: string): Promise<boolean> {
  try {
    await invoke("fs_stat", {
      path: `${cwd.replace(/[\\/]+$/, "")}/${path}`,
      workspace: currentWorkspaceEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * U4 offer gate: the text must say something, or the record must still hold a
 * queued image whose file exists, or a K8 source. Anything else recovers
 * nothing and is deleted quietly by listRecoverableDrafts.
 */
async function draftIsWorthOffering(cwd: string, record: DraftRecord): Promise<boolean> {
  if (record.markdown.trim() !== "") return true;
  if (record.kind !== "chat") return false;
  if (record.meta.sources.length > 0) return true;
  const existing = await Promise.all(
    record.meta.attachments.map((attachment) => attachmentFileExists(cwd, attachment.path)),
  );
  return existing.some(Boolean);
}

function draftFirstLine(markdown: string): string {
  return markdown.split(/\r?\n/, 1)[0] ?? "";
}

function isFenceLine(line: string): boolean {
  return /^\s*`{3,}/.test(line);
}

/**
 * The first content line of the first fenced block: the command line of a K8
 * transfer quotation (buildQuotation puts it right under the opening fence).
 */
function quotationFirstLine(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const open = lines.findIndex((line) => isFenceLine(line));
  for (let i = open + 1; open !== -1 && i < lines.length; i += 1) {
    if (isFenceLine(lines[i])) break;
    if (lines[i].trim() !== "") return lines[i];
  }
  return "";
}

function queuedImagesLabel(meta: ChatDraftMeta): string {
  const n = meta.attachments.length;
  return `${n} queued image${n === 1 ? "" : "s"}`;
}

function chatDraftLabel(markdown: string, meta: ChatDraftMeta): string {
  const first = draftFirstLine(markdown);
  if (first.trim() !== "" && !isFenceLine(first)) return first;
  if (meta.sources.length > 0) {
    const quoted = quotationFirstLine(markdown);
    if (quoted !== "") return quoted;
  }
  if (meta.attachments.length > 0) return queuedImagesLabel(meta);
  if (meta.sources.length > 0) return "Transferred terminal block";
  return first;
}

function editorDraftLabel(markdown: string, meta: EditorDraftMeta): string {
  const first = draftFirstLine(markdown);
  return first.trim() !== "" ? first : meta.path;
}

export async function loadDraftRecord(cwd: string, sid: string): Promise<DraftRecord | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sid)) throw new Error(`Invalid draft id: ${sid}`);
  const [markdown, rawMeta] = await Promise.all([
    readRecoveryText(draftPath(cwd, sid)),
    readRecoveryText(draftMetaPath(cwd, sid)),
  ]);
  if (markdown === null && rawMeta === null) return null;
  if (rawMeta !== null) {
    const editorMeta = parseEditorMeta(rawMeta);
    if (editorMeta) {
      if (markdown === null) throw new Error(`${draftPath(cwd, sid)}: Editor buffer is missing`);
      return { sid, kind: "editor", markdown, meta: editorMeta };
    }
    const meta = parseChatMeta(rawMeta);
    if (!meta) throw new Error(`${draftMetaPath(cwd, sid)}: Invalid draft record`);
    const raw = JSON.parse(rawMeta) as Record<string, unknown>;
    if ((raw.attachments !== undefined && !Array.isArray(raw.attachments)) ||
        (Array.isArray(raw.attachments) && raw.attachments.length !== meta.attachments.length) ||
        new Set(meta.attachments.map((attachment) => attachment.id)).size !== meta.attachments.length ||
        meta.attachments.some((attachment) => !attachment.id || !attachment.sha256 ||
          !attachment.mime.startsWith("image/") ||
          !/^\.pi\/(drafts|attachments)\/[a-zA-Z0-9_.-]+$/.test(attachment.path))) {
      throw new Error(`${draftMetaPath(cwd, sid)}: Invalid attachment record`);
    }
    return { sid, kind: "chat", markdown: markdown ?? "", meta };
  }
  return { sid, kind: "chat", markdown: markdown ?? "", meta: emptyChatMeta() };
}

export async function listRecoverableDrafts(cwd: string, openSids: readonly string[]): Promise<RecoverableDraft[]> {
  let entries: { name: string; kind: string }[];
  try {
    entries = await invoke("fs_read_dir", {
      path: draftsDir(cwd), showHidden: true, workspace: currentWorkspaceEnv(),
    });
  } catch (error) {
    if (isMissingDraftFile(error)) return [];
    throw new Error(`${draftsDir(cwd)}: ${String(error)}`);
  }
  const open = new Set(openSids);
  const sids = new Set(entries.flatMap((entry) => {
    const match = entry.kind === "file" && /^([a-zA-Z0-9_-]+)\.(md|json)$/.exec(entry.name);
    return match && !open.has(match[1]) ? [match[1]] : [];
  }));
  const drafts = await Promise.all([...sids].sort().map(async (sid): Promise<RecoverableDraft | null> => {
    try {
      const record = await loadDraftRecord(cwd, sid);
      if (!record) return null;
      // U4: an empty, attachment-free draft offers nothing to recover; clear
      // both files quietly so the row never comes back. Drafts bound to open
      // tabs never reach this loop.
      if (!(await draftIsWorthOffering(cwd, record))) {
        await deleteOrNull(draftPath(cwd, sid));
        await deleteOrNull(draftMetaPath(cwd, sid));
        return null;
      }
      const firstLine = record.kind === "editor"
        ? editorDraftLabel(record.markdown, record.meta)
        : chatDraftLabel(record.markdown, record.meta);
      return { sid, firstLine };
    } catch (error) {
      return { sid, firstLine: sid, error: String(error) };
    }
  }));
  return drafts.filter((draft): draft is RecoverableDraft => draft !== null);
}

// ---------------------------------------------------------------------------
// Chat drafts
// ---------------------------------------------------------------------------

export async function saveDraft(
  cwd: string,
  tabId: string,
  markdown: string,
): Promise<void> {
  await ensureDraftDir(cwd);
  await invoke("fs_write_file", {
    path: draftPath(cwd, tabId),
    content: markdown,
    workspace: currentWorkspaceEnv(),
  });
}

export async function loadDraft(
  cwd: string,
  tabId: string,
  opts?: { migrateFrom?: number },
): Promise<string | null> {
  let md = await readTextOrNull(draftPath(cwd, tabId));
  if (md === null && opts && typeof opts.migrateFrom === "number") {
    const migrated = await migrateNumericDraft(cwd, opts.migrateFrom, tabId);
    if (migrated) md = await readTextOrNull(draftPath(cwd, tabId));
  }
  return md;
}

export async function clearDraft(cwd: string, tabId: string): Promise<void> {
  for (const path of [draftPath(cwd, tabId), draftMetaPath(cwd, tabId)]) {
    await deleteOrNull(path);
  }
}

export async function saveDraftMeta(
  cwd: string,
  tabId: string,
  meta: ChatDraftMeta,
): Promise<void> {
  await ensureDraftDir(cwd);
  await invoke("fs_write_file", {
    path: draftMetaPath(cwd, tabId),
    content: JSON.stringify(meta),
    workspace: currentWorkspaceEnv(),
  });
}

/** Chat record reader; an editor record under the same id yields null. */
export async function loadDraftMeta(
  cwd: string,
  tabId: string,
): Promise<ChatDraftMeta | null> {
  const raw = await readTextOrNull(draftMetaPath(cwd, tabId));
  return raw === null ? null : parseChatMeta(raw);
}

// ---------------------------------------------------------------------------
// Editor drafts (K11c)
// ---------------------------------------------------------------------------

export async function saveEditorDraft(
  cwd: string,
  tabId: string,
  meta: EditorDraftMeta,
  markdown: string,
): Promise<void> {
  await ensureDraftDir(cwd);
  await invoke("fs_write_file", {
    path: draftMetaPath(cwd, tabId),
    content: JSON.stringify(meta),
    workspace: currentWorkspaceEnv(),
  });
  await invoke("fs_write_file", {
    path: draftPath(cwd, tabId),
    content: markdown,
    workspace: currentWorkspaceEnv(),
  });
}

export async function loadEditorDraft(
  cwd: string,
  tabId: string,
): Promise<{ meta: EditorDraftMeta; markdown: string } | null> {
  const rawMeta = await readTextOrNull(draftMetaPath(cwd, tabId));
  if (rawMeta === null) return null;
  const meta = parseEditorMeta(rawMeta);
  if (!meta) return null;
  const markdown = await readTextOrNull(draftPath(cwd, tabId));
  return markdown === null ? null : { meta, markdown };
}

export type FoundEditorDraft = {
  sid: string;
  meta: EditorDraftMeta;
  markdown: string;
};

/**
 * Recovery lookup for an editor file: scan the draft dir for an editor record
 * whose path matches. A missing or unreadable dir yields null, never a throw.
 */
export async function findEditorDraft(
  cwd: string,
  path: string,
): Promise<FoundEditorDraft | null> {
  let entries: { name: string; kind: string }[] = [];
  try {
    entries = await invoke<{ name: string; kind: string }[]>("fs_read_dir", {
      path: draftsDir(cwd),
      showHidden: true,
      workspace: currentWorkspaceEnv(),
    });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    const sid = entry.name.slice(0, -".json".length);
    if (sid.length === 0) continue;
    const rawMeta = await readTextOrNull(draftMetaPath(cwd, sid));
    if (rawMeta === null) continue;
    const meta = parseEditorMeta(rawMeta);
    if (!meta || meta.path !== path) continue;
    const markdown = await readTextOrNull(draftPath(cwd, sid));
    if (markdown === null) continue;
    return { sid, meta, markdown };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Migration from the numeric-named drafts
// ---------------------------------------------------------------------------

/**
 * One-time migration: adopt a legacy numeric-named draft for this tab. Reads
 * <n>.md (and its K8 sidecar when present), writes them under the stable id,
 * then removes the numeric files so the migration can never run twice. A
 * no-op when the stable draft already exists or the id already is the number.
 * Migration decision: a numeric file is adopted by the first tab that loads
 * drafts with that numeric id after the upgrade; numeric files beyond the
 * tabs of the new session stay orphaned on disk.
 */
export async function migrateNumericDraft(
  cwd: string,
  numericId: number,
  tabId: string,
): Promise<boolean> {
  if (String(numericId) === tabId) return false;
  const existing = await readTextOrNull(draftPath(cwd, tabId));
  if (existing !== null) return false;
  const markdown = await readTextOrNull(numericDraftPath(cwd, numericId));
  if (markdown === null) return false;
  // The legacy sidecar carried only sources; everything else starts empty.
  const legacy = await readTextOrNull(`${numericLegacyMetaPath(cwd, numericId)}`);
  const meta = legacy === null ? emptyChatMeta() : parseChatMeta(legacy);
  await ensureDraftDir(cwd);
  await invoke("fs_write_file", {
    path: draftPath(cwd, tabId),
    content: markdown,
    workspace: currentWorkspaceEnv(),
  });
  await invoke("fs_write_file", {
    path: draftMetaPath(cwd, tabId),
    content: JSON.stringify(meta ?? emptyChatMeta()),
    workspace: currentWorkspaceEnv(),
  });
  await deleteOrNull(numericDraftPath(cwd, numericId));
  await deleteOrNull(numericLegacyMetaPath(cwd, numericId));
  return true;
}

// ---------------------------------------------------------------------------
// Shared hashing
// ---------------------------------------------------------------------------

/** Hex SHA-256 over a string (the editor buffer's base hash, K11c). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

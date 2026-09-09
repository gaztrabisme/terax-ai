import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  clearDraft,
  draftPath,
  findEditorDraft,
  loadEditorDraft,
  loadDraftRecord,
  saveEditorDraft,
  sha256Hex,
} from "@/modules/pi/lib/drafts";

/**
 * Unit K11c: editor buffer persistence. An unsaved editor buffer mirrors to
 * <project>/.pi/drafts/<stable-id>.md plus <stable-id>.json with the record
 * {v:1,kind:"editor",path,baseSha256}, debounced; on reopen the draft
 * restores the buffer with a visible recovered marker, and Save commits to
 * the file and clears the draft. When the file on disk changed since
 * baseSha256, Save refuses with a visible conflict naming both paths.
 */

export type EditorConflict = {
  /** The project file Save refused to overwrite. */
  path: string;
  /** Where the unsaved buffer still lives. */
  draftPath: string;
};

export type EditorDraftUiState = {
  /** The buffer was restored from a draft and is still unsaved. */
  recovered: boolean;
  /** The last Save hit an on-disk change and was refused. */
  conflict: EditorConflict | null;
};

/** Payload useDocument's recover hook returns to open with a draft buffer. */
export type RecoveryPayload = {
  content: string;
  baseSha256: string;
  draftId: string;
};

/**
 * The project the editor's drafts belong to: the first project-scoped cwd in
 * tab order (pi, board and run-graph tabs carry the project; a terminal's
 * cwd is a shell location). Null when the window has no project open.
 */
export function windowProjectCwd(
  tabs: readonly {
    kind: string;
    cwd?: string;
    [field: string]: unknown;
  }[],
): string | null {
  for (const t of tabs) {
    if (
      (t.kind === "pi" || t.kind === "board" || t.kind === "run-graph") &&
      typeof t.cwd === "string" &&
      t.cwd.length > 0
    ) {
      return t.cwd;
    }
  }
  return null;
}

const DRAFT_SAVE_DEBOUNCE_MS = 500;

type Options = {
  cwd: string;
  path: string;
  sid: string;
  isDirty: () => boolean;
  onState: (state: EditorDraftUiState) => void;
};

/**
 * The persistence behaviour EditorPane wires into useDocument: recover on
 * load, refuse writes on conflict, clear on write-through, debounce a draft
 * mirror while typing. One instance per (sid, cwd, path); a path change
 * builds a fresh one.
 */
export function createEditorDraftController({
  cwd,
  path,
  sid,
  isDirty,
  onState,
}: Options) {
  let activeSid = sid;
  let baseSha256: string | null = null;
  let loaded = false;
  let keepDraft = false;
  let recovered = false;
  let conflict: EditorConflict | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const push = () => onState({ recovered, conflict });

  /** useDocument recover hook: always captures the base hash, then offers a
   * draft buffer when one exists for this file. */
  const recover = async (diskContent: string): Promise<RecoveryPayload | null> => {
    activeSid = sid;
    baseSha256 = await sha256Hex(diskContent);
    const own = await loadDraftRecord(cwd, sid);
    if (own && (own.kind !== "editor" || own.meta.path !== path)) {
      throw new Error(`Draft recovery failed: ${draftPath(cwd, sid)} does not belong to ${path}`);
    }
    const found = own?.kind === "editor" ? own : await findEditorDraft(cwd, path);
    loaded = true;
    if (!found) return null;
    if (found.markdown === diskContent) {
      // The draft matches the file on disk: nothing unsaved to restore.
      await clearDraft(cwd, found.sid);
      return null;
    }
    activeSid = found.sid;
    baseSha256 = found.meta.baseSha256;
    recovered = true;
    push();
    return {
      content: found.markdown,
      baseSha256: found.meta.baseSha256,
      draftId: found.sid,
    };
  };

  /** useDocument beforeWrite hook: refuse when the file moved under us. */
  const beforeWrite = async (buffer?: string): Promise<boolean> => {
    if (buffer !== undefined && baseSha256 !== null) {
      stop();
      await saveEditorDraft(cwd, activeSid, { v: 1, kind: "editor", path, baseSha256 }, buffer);
    }
    let diskContent: string | null = null;
    try {
      const res = await invoke<{ kind: string; content?: string }>(
        "fs_read_file",
        { path, workspace: currentWorkspaceEnv() },
      );
      if (res.kind === "text" && typeof res.content === "string") {
        diskContent = res.content;
      }
    } catch {
      diskContent = null;
    }
    if (diskContent === null) {
      // Unreadable or binary: refuse rather than clobber an unreadable file.
      conflict = { path, draftPath: draftPath(cwd, activeSid) };
      push();
      return false;
    }
    const diskSha256 = await sha256Hex(diskContent);
    // First write-through after a clean load: adopt what is on disk now.
    baseSha256 = baseSha256 ?? diskSha256;
    if (diskSha256 !== baseSha256) {
      conflict = { path, draftPath: draftPath(cwd, activeSid) };
      push();
      return false;
    }
    return true;
  };

  /** useDocument onWritten hook: the file holds the buffer; drop the draft. */
  const onWritten = async (): Promise<void> => {
    await clearDraft(cwd, activeSid);
    recovered = false;
    conflict = null;
    push();
  };

  /** Debounced draft mirror for ongoing edits. */
  const scheduleSave = (buffer: string): void => {
    keepDraft = false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void (async () => {
        if (!isDirty() || baseSha256 === null) return;
        const meta = { v: 1, kind: "editor", path, baseSha256 } as const;
        await saveEditorDraft(cwd, activeSid, meta, buffer).catch(() => {
          // A failed mirror keeps the in-memory buffer authoritative.
        });
      })();
    }, DRAFT_SAVE_DEBOUNCE_MS);
  };

  /** The buffer reached the saved state (saved, autosaved or reverted):
   * stop the timer, drop the draft, drop the marker and conflict. */
  const onClean = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!loaded || keepDraft) return;
    await clearDraft(cwd, activeSid);
    recovered = false;
    conflict = null;
    push();
  };

  /** Stop a pending mirror without touching state (unmount). */
  const stop = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const retainForReload = async (buffer: string, disk: string): Promise<void> => {
    stop();
    if (baseSha256 === null) throw new Error("Editor base is unavailable");
    await saveEditorDraft(cwd, activeSid, { v: 1, kind: "editor", path, baseSha256 }, buffer);
    keepDraft = true;
    activeSid = `${sid}-reload-${Date.now().toString(36)}`;
    baseSha256 = await sha256Hex(disk);
    recovered = false;
    conflict = null;
    push();
  };
  return { recover, beforeWrite, onWritten, scheduleSave, onClean, stop, retainForReload };
}

export type EditorDraftController = ReturnType<
  typeof createEditorDraftController
>;

/** Load a draft directly by stable id (tests and recovery tooling). */
export function readEditorDraft(cwd: string, sid: string) {
  return loadEditorDraft(cwd, sid);
}

export function answerTabTitle(path: string, markdown: string): string | null {
  if (!path.replace(/\\/g, "/").includes("/.pi/answers/")) return null;
  const lines = markdown.split(/\r?\n/);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const heading = lines[i].match(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/)?.[1];
    if (heading) return heading;
    if (i > 0 && /^ {0,3}(=+|-+)\s*$/.test(lines[i]) && lines[i - 1].trim()) return lines[i - 1].trim();
  }
  return lines[0].trim().slice(0, 40) || `Answer ${path.split(/[\\/]/).pop()!.slice(0, 8)}`;
}

export async function readDiskVersion(path: string): Promise<string> {
  const result = await invoke<{ kind: string; content?: string }>("fs_read_file", { path, workspace: currentWorkspaceEnv() });
  if (result.kind !== "text" || typeof result.content !== "string") throw new Error(`Cannot read text from ${path}`);
  return result.content;
}

export async function saveEditorCopy(path: string, content: string): Promise<string> {
  const copy = `${path.replace(/\.[^./\\]+$/, "")}.${Date.now().toString(36)}.md`;
  await invoke("fs_create_file", { path: copy, workspace: currentWorkspaceEnv() });
  await invoke("fs_write_file", { path: copy, content, workspace: currentWorkspaceEnv(), source: "editor" });
  return copy;
}

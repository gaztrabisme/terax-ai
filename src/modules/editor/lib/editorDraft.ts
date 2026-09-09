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
  const beforeWrite = async (): Promise<boolean> => {
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
    if (!loaded) return;
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

  return { recover, beforeWrite, onWritten, scheduleSave, onClean, stop };
}

export type EditorDraftController = ReturnType<
  typeof createEditorDraftController
>;

/** Load a draft directly by stable id (tests and recovery tooling). */
export function readEditorDraft(cwd: string, sid: string) {
  return loadEditorDraft(cwd, sid);
}

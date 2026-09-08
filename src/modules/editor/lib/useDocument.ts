import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number; recovered?: boolean }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

/** K11c: what the recover hook may hand back to open with a draft buffer. */
export type RecoveryPayload = {
  content: string;
  baseSha256: string;
  draftId: string;
};

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  /** After the file loads: offer the disk text, get a draft buffer back. */
  recover?: (diskContent: string) => Promise<RecoveryPayload | null>;
  /** Gate every write-through to disk; false refuses (K11c conflict). */
  beforeWrite?: () => Promise<boolean>;
  /** The buffer reached disk: the draft mirror is now stale. */
  onWritten?: () => void;
};

export function useDocument({
  path,
  onDirtyChange,
  recover,
  beforeWrite,
  onWritten,
}: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);

  const autoSave = usePreferencesStore((s) => s.editorAutoSave);
  const autoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);

  // Track the saved buffer so we can detect changes cheaply.
  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const autoSaveRef = useRef({ autoSave, autoSaveDelay });
  autoSaveRef.current = { autoSave, autoSaveDelay };

  const recoverRef = useRef(recover);
  recoverRef.current = recover;
  const beforeWriteRef = useRef(beforeWrite);
  beforeWriteRef.current = beforeWrite;
  const onWrittenRef = useRef(onWritten);
  onWrittenRef.current = onWritten;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoSaveTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const saveNow = useCallback(async () => {
    const content = bufferRef.current;
    await invoke("fs_write_file", {
      path,
      content,
      workspace: currentWorkspaceEnv(),
      source: "editor",
    });
    savedRef.current = content;
    setDirty(false);
  }, [path]);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  // Load on path change or explicit reload.
  useEffect(() => {
    let cancelled = false;
    setDoc({ status: "loading" });
    setDirty(false);

    invoke<ReadResult>("fs_read_file", { path, workspace: currentWorkspaceEnv() })
      .then(async (res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          // K11c: a draft for this file replaces the opening buffer; the
          // saved reference stays at the disk text so the buffer is dirty.
          let content = res.content;
          let recovered = false;
          const hook = recoverRef.current;
          if (hook) {
            const rec = await hook(res.content).catch(() => null);
            if (cancelled) return;
            if (rec) {
              content = rec.content;
              recovered = rec.content !== res.content;
            }
          }
          savedRef.current = res.content;
          bufferRef.current = content;
          setDirty(recovered);
          setDoc({
            status: "ready",
            content,
            size: res.size,
            ...(recovered && { recovered: true }),
          });
        } else if (res.kind === "binary") {
          setDoc({ status: "binary", size: res.size });
        } else if (res.kind === "toolarge") {
          setDoc({
            status: "toolarge",
            size: res.size,
            limit: res.limit,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setDoc({ status: "error", message: String(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  // Skipped while dirty (never clobber unsaved edits) and when disk already
  // matches the buffer (self-save / duplicate watcher event → no re-render).
  const reload = useCallback((): boolean => {
    if (dirtyRef.current) return false;
    void invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((res) => {
        if (res.kind === "text") {
          if (res.content === savedRef.current) return;
          savedRef.current = res.content;
          bufferRef.current = res.content;
          setDirty(false);
          setDoc({ status: "ready", content: res.content, size: res.size });
        } else if (res.kind === "binary") {
          setDoc({ status: "binary", size: res.size });
        } else if (res.kind === "toolarge") {
          setDoc({ status: "toolarge", size: res.size, limit: res.limit });
        }
      })
      .catch((e) => setDoc({ status: "error", message: String(e) }));
    return true;
  }, [path]);

  const save = useCallback(async (): Promise<boolean> => {
    clearAutoSaveTimer();
    if (!dirtyRef.current) return false;
    // K11c: every write-through passes the gate; a refused save keeps the
    // buffer dirty (conflict surfaced by the caller).
    if (beforeWriteRef.current && !(await beforeWriteRef.current())) {
      return false;
    }
    await saveNow();
    onWrittenRef.current?.();
    return true;
  }, [clearAutoSaveTimer, saveNow]);

  const saveRef = useRef(save);
  saveRef.current = save;

  const onChange = useCallback(
    (next: string) => {
      bufferRef.current = next;
      const isDirty = next !== savedRef.current;
      setDirty(isDirty);

      clearAutoSaveTimer();

      const { autoSave: active, autoSaveDelay: delay } = autoSaveRef.current;
      if (active && isDirty) {
        timeoutRef.current = setTimeout(() => {
          saveRef.current().catch((e) => console.error("[autosave]", e));
        }, delay);
      }
    },
    [clearAutoSaveTimer],
  );

  useEffect(() => clearAutoSaveTimer, [path, clearAutoSaveTimer]);

  return { doc, dirty, onChange, save, reload };
}

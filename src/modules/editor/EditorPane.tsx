import { redo, undo } from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { usePreferencesStore } from "@/modules/settings/preferences";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EDITOR_THEME_EXT } from "./lib/themes";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Prec, type Extension } from "@codemirror/state";
import { vim } from "@replit/codemirror-vim";
import {
  buildSharedExtensions,
  languageCompartment,
  vimCompartment,
} from "./lib/extensions";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";

initVimGlobals();
import { resolveLanguage } from "./lib/languageResolver";
import {
  createEditorDraftController,
  readDiskVersion,
  saveEditorCopy,
  type EditorDraftUiState,
} from "./lib/editorDraft";
import { useDocument } from "./lib/useDocument";

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
  /** Apply CodeMirror's undo/redo commands. */
  undo: () => void;
  redo: () => void;
};

type Props = {
  path: string;
  /** Stable tab id (K11c); without it no draft mirror is kept. */
  sid?: string;
  /** Project the draft files belong to; null disables persistence. */
  projectCwd?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const EditorPane = forwardRef<EditorPaneHandle, Props>(
  function EditorPane(
    { path, sid, projectCwd, onDirtyChange, onSaved, onClose },
    ref,
  ) {
    // K11c: one persistence controller per (tab, project, path). A path
    // change (preview slot reuse) rebuilds it with fresh state.
    const [draftState, setDraftState] = useState<EditorDraftUiState>({
      recovered: false,
      conflict: null,
    });
    const onDirtyChangeRef = useRef(onDirtyChange);
    onDirtyChangeRef.current = onDirtyChange;
    const dirtyRef = useRef(false);
    const controller = useMemo(
      () =>
        sid && projectCwd
          ? createEditorDraftController({
              cwd: projectCwd,
              path,
              sid,
              isDirty: () => dirtyRef.current,
              onState: (next) => setDraftState(next),
            })
          : null,
      [sid, projectCwd, path],
    );
    useEffect(() => () => controller?.stop(), [controller]);

    const handleDirty = useCallback(
      (dirty: boolean) => {
        dirtyRef.current = dirty;
        if (!dirty) void controller?.onClean();
        onDirtyChangeRef.current?.(dirty);
      },
      [controller],
    );

    const { doc, onChange, save, reload, replaceFromDisk, getBuffer } = useDocument({
      path,
      onDirtyChange: handleDirty,
      recover: controller?.recover,
      beforeWrite: controller?.beforeWrite,
      onWritten: controller?.onWritten,
    });
    const [diskVersion, setDiskVersion] = useState<string | null>(null);
    const [reloadConfirm, setReloadConfirm] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionBusy, setActionBusy] = useState(false);
    const runConflictAction = async (action: () => Promise<void>) => {
      setActionBusy(true); setActionError(null);
      try { await action(); } catch (error) { setActionError(String(error)); }
      finally { setActionBusy(false); }
    };
    useEffect(() => {
      if (doc.status === "ready") window.dispatchEvent(new CustomEvent("editor:loaded", { detail: { path, content: doc.content } }));
    }, [path, doc]);
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const editorThemeId = usePreferencesStore((s) => s.editorTheme);
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const languageRef = useRef<string | null>(null);
    const themeExt = EDITOR_THEME_EXT[editorThemeId] ?? EDITOR_THEME_EXT.atomone;

    // Stabilize save + onSaved via refs so the extensions array never changes
    // identity — a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    const pathRef = useRef(path);
    pathRef.current = path;

    const extensions = useMemo(
      () => [
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        vimHandlersExtension(() => ({
          save: () => {
            void (async () => {
              await saveRef.current();
              onSavedRef.current?.();
            })();
          },
          close: () => onCloseRef.current?.(),
        })),
        ...buildSharedExtensions(),
        languageCompartment.of([]),
        EditorView.contentAttributes.of({
          "aria-label": "Editor input",
          "data-uat": "editor-input",
        }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void (async () => {
                await saveRef.current();
                onSavedRef.current?.();
              })();
              return true;
            },
          },
        ]),
      ],
      [],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.reconfigure(
          vimMode ? Prec.highest(vim()) : [],
        ),
      });
    }, [vimMode]);

    useEffect(() => {
      let cancelled = false;
      const ext = path.split(".").pop()?.toLowerCase() ?? null;
      languageRef.current = ext;
      const resolve = async (): Promise<Extension> => {
        if (path.toLowerCase().endsWith(".terax-theme")) {
          const [{ json }, { colorSwatches }] = await Promise.all([
            import("@codemirror/lang-json"),
            import("./lib/colorSwatches"),
          ]);
          return [json(), colorSwatches()];
        }
        return (await resolveLanguage(path)) ?? [];
      };
      void resolve().then((extension) => {
        if (cancelled) return;
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: languageCompartment.reconfigure(extension),
        });
      });
      return () => {
        cancelled = true;
      };
    }, [path, doc.status]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (q: string) => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(
              new SearchQuery({ search: q, caseSensitive: false }),
            ),
          });
          if (q) findNext(view);
        },
        findNext: () => {
          const view = cmRef.current?.view;
          if (view) findNext(view);
        },
        findPrevious: () => {
          const view = cmRef.current?.view;
          if (view) findPrevious(view);
        },
        clearQuery: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: "" })),
          });
        },
        focus: () => {
          cmRef.current?.view?.focus();
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getPath: () => path,
        reload: () => reloadRef.current(),
        undo: () => {
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo: () => {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
      }),
      [path],
    );

    const onDocChange = useCallback(
      (next: string) => {
        controller?.scheduleSave(next);
        onChange(next);
      },
      [controller, onChange],
    );

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {path}: {doc.message}
        </div>
      );
    }
    if (doc.status === "binary") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">Binary file</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} · preview not supported
          </div>
        </div>
      );
    }
    if (doc.status === "toolarge") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">File too large</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} exceeds the {formatBytes(doc.limit)} limit.
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        {(draftState.recovered || draftState.conflict) && (
          <div className="shrink-0 border-b border-border/60 px-2 py-1 text-xs">
            {draftState.recovered && (
              <div
                data-uat="editor-recovered"
                className="text-amber-600 dark:text-amber-400"
              >
                Unsaved, recovered
              </div>
            )}
            {draftState.conflict && (
              <div
                data-uat="editor-conflict"
                className="text-destructive"
                role="alert"
              >
                Save refused: {draftState.conflict.path} changed on disk since
                this buffer was last saved; the unsaved buffer is kept at{" "}
                {draftState.conflict.draftPath}.
                <div className="mt-2 flex flex-wrap gap-2 text-foreground">
                  <button data-uat="editor-compare" type="button" disabled={actionBusy} onClick={() => void runConflictAction(async () => setDiskVersion(await readDiskVersion(path)))}>Compare with disk</button>
                  <button data-uat="editor-save-copy" type="button" disabled={actionBusy} onClick={() => void runConflictAction(async () => {
                    const copy = await saveEditorCopy(path, getBuffer());
                    window.dispatchEvent(new CustomEvent("pi:open-file", { detail: { path: copy } }));
                  })}>Save a copy</button>
                  <button data-uat="editor-reload" type="button" disabled={actionBusy} onClick={() => setReloadConfirm(true)}>Reload from disk</button>
                </div>
                {reloadConfirm ? <div role="alertdialog" aria-label="Confirm reload" className="mt-2 text-foreground">
                  Reload from disk? Your draft will be kept at {draftState.conflict.draftPath}.
                  <div className="flex gap-2">
                    <button data-uat="editor-reload-confirm" type="button" disabled={actionBusy} onClick={() => void runConflictAction(async () => {
                      const disk = await readDiskVersion(path);
                      await controller!.retainForReload(getBuffer(), disk);
                      replaceFromDisk(disk); setReloadConfirm(false); setDiskVersion(null);
                    })}>Confirm reload</button>
                    <button data-uat="editor-keep-editing" type="button" onClick={() => setReloadConfirm(false)}>Keep editing</button>
                  </div>
                </div> : null}
              </div>
            )}
          </div>
        )}
        {actionError ? <div role="alert" className="p-2 text-xs text-destructive">{actionError}</div> : null}
        <div className="flex min-h-0 flex-1">
        {diskVersion !== null ? <section aria-label="Disk version (read only)" className="w-1/2 min-w-0 overflow-auto border-r p-2 text-xs">
          <div className="flex justify-between gap-2"><span>Disk version (read only)</span><button type="button" onClick={() => setDiskVersion(null)}>Close comparison</button></div>
          <pre className="whitespace-pre-wrap break-words">{diskVersion}</pre>
        </section> : null}
        <CodeMirror
          ref={cmRef}
          value={doc.content}
          onChange={onDocChange}
          theme={themeExt}
          extensions={extensions}
          height="100%"
          className="flex-1 min-h-0 overflow-hidden"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            searchKeymap: true,
          }}
        />
        </div>
      </div>
    );
  },
);

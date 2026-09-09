import { Refresh01Icon, CopyIcon, FileEditIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { viewerDocument, type ArtifactDoc, type ArtifactDocKind } from "../lib/artifacts";

/** Sandbox for the artifact iframe: forms and downloads only. K13 removed
 *  execution and save-before-view semantics; no allow-scripts, no
 *  allow-same-origin (the document keeps an opaque origin). */
export const ARTIFACT_SANDBOX = "allow-forms allow-downloads";

/** Saved-path display relative to the workspace root. */
export function relativePath(path: string, cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  if (path.startsWith(`${base}\\`)) return path.slice(base.length + 1);
  return path;
}

/** Reply shape of `pi_read_artifact`. */
type ReadArtifactReply = {
  mime: string;
  sha256: string;
  content: string | null;
  base64: string | null;
};

/** The document kind the viewer builds from a file's mime and extension. */
function kindForReply(reply: ReadArtifactReply, path: string): ArtifactDocKind {
  switch (reply.mime) {
    case "text/html":
      return "html";
    case "image/svg+xml":
      return "svg";
    case "text/markdown":
      return "md";
    default:
      if (reply.mime.startsWith("image/")) return "image";
      return path.endsWith(".md") || path.endsWith(".txt") ? "md" : "html";
  }
}

/** The file-backed document the pane renders: the file is the truth. */
type LoadedArtifact = {
  kind: ArtifactDocKind;
  title: string;
  source: string;
  sha256: string;
  /** Exact path this document was read from; a kept frame only ever shows
   * this file, and its load time drives the stale marker (UX-19). */
  path: string;
  loadedAt: string;
};

type Props = {
  doc: ArtifactDoc | null;
  cwd?: string;
};

const toolbarBtn =
  "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";

/**
 * The artifact viewer over an existing file (K13): the authoritative input
 * is the file plus its path and hash, read back through pi_read_artifact on
 * every selection and every refresh. The path links to the editor, Copy
 * path copies the absolute path, and a missing or unreadable file shows a
 * path-bearing error. Opening the viewer causes no save operation.
 */
export function ArtifactPane({ doc, cwd }: Props) {
  const [loaded, setLoaded] = useState<LoadedArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const absolute = doc?.path ?? null;

  const read = useCallback(async () => {
    if (!absolute) {
      setLoaded(null);
      setError(null);
      return;
    }
    try {
      const reply = await invoke<ReadArtifactReply>("pi_read_artifact", {
        cwd: cwd ?? "",
        path: absolute,
        workspace: currentWorkspaceEnv(),
      });
      setError(null);
      setLoaded({
        kind: kindForReply(reply, absolute),
        title: doc?.title ?? absolute.split(/[\\/]/).pop() ?? absolute,
        source:
          reply.content ??
          `data:${reply.mime};base64,${reply.base64 ?? ""}`,
        sha256: reply.sha256,
        path: absolute,
        loadedAt: new Date().toLocaleTimeString(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A load failure is unmistakable (design.md section 7.1): a frame for
      // this same file is kept only deliberately, marked stale since its last
      // successful load. Anything else replaces the frame with the error.
      setLoaded((current) =>
        current && current.path === absolute ? current : null,
      );
    }
  }, [absolute, cwd, doc?.title]);

  // The file is read on selection; Refresh re-reads it, and a changed hash
  // reloads the viewer with the file's new contents.
  useEffect(() => {
    void read();
  }, [read]);

  if (!doc || !absolute) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        No artifact yet: a completed artifact file shows here.
      </div>
    );
  }

  const openInEditor = () => {
    window.dispatchEvent(
      new CustomEvent("pi:open-file", { detail: { path: absolute } }),
    );
  };

  const chip = cwd ? relativePath(absolute, cwd) : absolute;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 px-1.5">
        <button
          type="button"
          data-uat="artifact-path"
          title={`Open ${absolute} in the editor`}
          onClick={openInEditor}
          className={cn(
            "min-w-0 truncate rounded px-1 text-xs text-muted-foreground",
            "underline-offset-2 hover:text-foreground hover:underline",
          )}
        >
          {chip}
        </button>
        <button
          type="button"
          data-uat="artifact-copy-path"
          aria-label="Copy path"
          title="Copy path"
          onClick={() => {
            void navigator.clipboard?.writeText(absolute).catch(() => {});
          }}
          className={toolbarBtn}
        >
          <HugeiconsIcon icon={CopyIcon} size={12} strokeWidth={1.75} />
          Copy path
        </button>
        <button
          type="button"
          aria-label="Refresh artifact"
          title="Refresh artifact"
          onClick={() => void read()}
          className={toolbarBtn}
        >
          <HugeiconsIcon
            icon={Refresh01Icon}
            size={12}
            strokeWidth={1.75}
          />
          Refresh
        </button>
        <span className="flex-1" />
        <button
          type="button"
          title={`Open ${absolute} in the editor`}
          onClick={openInEditor}
          className={toolbarBtn}
        >
          <HugeiconsIcon icon={FileEditIcon} size={12} strokeWidth={1.75} />
        </button>
      </div>
      {error && loaded ? (
        <div
          data-uat="artifact-error"
          role="alert"
          className="shrink-0 border-b border-border/60 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word">
              {error}
            </p>
            <button
              type="button"
              aria-label="Retry artifact load"
              onClick={() => void read()}
              className={cn(
                toolbarBtn,
                "text-destructive hover:text-destructive",
              )}
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}
      {error && !loaded ? (
        <div
          data-uat="artifact-error"
          role="alert"
          className="flex min-h-0 flex-1 flex-col items-start gap-2 overflow-y-auto p-3 text-xs"
        >
          <p className="whitespace-pre-wrap wrap-break-word text-destructive">
            {error}
          </p>
          <p className="select-text break-all whitespace-pre-wrap text-muted-foreground">
            {absolute}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Copy path"
              onClick={() => {
                void navigator.clipboard?.writeText(absolute).catch(() => {});
              }}
              className={toolbarBtn}
            >
              <HugeiconsIcon icon={CopyIcon} size={12} strokeWidth={1.75} />
              Copy path
            </button>
            <button
              type="button"
              aria-label="Retry artifact load"
              onClick={() => void read()}
              className={cn(
                toolbarBtn,
                "text-destructive hover:text-destructive",
              )}
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}
      {!error && !loaded ? <div className="min-h-0 flex-1" /> : null}
      {loaded ? (
        <div className="flex min-h-0 flex-1 flex-col bg-white">
          {error ? (
            <div
              data-uat="artifact-stale"
              className="shrink-0 bg-amber-500/15 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
            >
              stale since {loaded.loadedAt}: the last successful load; the file
              could not be re-read
            </div>
          ) : null}
          <iframe
            title={loaded.title}
            data-uat="artifact-frame"
            srcDoc={viewerDocument({
              kind: loaded.kind,
              title: loaded.title,
              source: loaded.source,
            })}
            sandbox={ARTIFACT_SANDBOX}
            className="min-h-0 w-full flex-1 border-0"
          />
        </div>
      ) : null}
    </div>
  );
}

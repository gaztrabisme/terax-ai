import { Download01Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  artifactFileName,
  htmlDataUrl,
  viewerDocument,
  type ArtifactDoc,
} from "../lib/artifacts";

/** Sandbox for the artifact iframe by default: forms and downloads only.
 *  No allow-scripts (nothing executes until the user consents per artifact)
 *  and no allow-same-origin (the document keeps an opaque origin). */
export const ARTIFACT_SANDBOX = "allow-forms allow-downloads";
/** Sandbox after the consent: scripts may run, still without same-origin.
 *  The document's own meta CSP keeps the network on data: and blob: only. */
export const ARTIFACT_SANDBOX_SCRIPTS =
  "allow-forms allow-downloads allow-scripts";

/** Saved-path display relative to the workspace root. */
export function relativePath(path: string, cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  if (path.startsWith(`${base}\\`)) return path.slice(base.length + 1);
  return path;
}

type Props = {
  doc: ArtifactDoc | null;
  cwd?: string;
};

const toolbarBtn =
  "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";

/**
 * The artifact viewer: a sandboxed iframe over the document, a per-artifact
 * scripts consent, and a Save that lands the artifact as a project file
 * under .pi/artifacts. The file is the truth; the iframe is only a view.
 */
export function ArtifactPane({ doc, cwd }: Props) {
  const [scriptsAllowed, setScriptsAllowed] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Consent is per artifact: a new document turns scripts back off.
  useEffect(() => {
    setScriptsAllowed(false);
    setConsentOpen(false);
    setSavedPath(doc?.path ?? null);
    setError(null);
  }, [doc]);

  const save = useCallback(async () => {
    if (!doc || !cwd || doc.path || doc.kind === "image") return;
    setError(null);
    const dir = `${cwd.replace(/[\\/]+$/, "")}/.pi/artifacts`;
    try {
      await invoke("fs_create_dir", {
        path: dir,
        workspace: currentWorkspaceEnv(),
      });
    } catch {
      // The artifacts dir already existing is the normal steady state.
    }
    try {
      const path = `${dir}/${artifactFileName(doc.turn ?? 0, doc.n ?? 0, doc.kind)}`;
      await invoke("fs_write_file", {
        path,
        content: doc.source,
        workspace: currentWorkspaceEnv(),
      });
      setSavedPath(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cwd, doc]);

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        No artifact yet: answers with html or svg code blocks show here.
      </div>
    );
  }

  const openSavedInEditor = () => {
    if (!savedPath) return;
    // Same bridge as the transcript's answer export: the shell opens an
    // editor tab for the path.
    window.dispatchEvent(
      new CustomEvent("pi:open-file", { detail: { path: savedPath } }),
    );
  };

  // Consented scripts need the data: URL render: a srcdoc document inherits
  // the app's own CSP, whose script-src blocks inline script; a data:
  // document carries an empty policy container, so only the injected meta
  // applies there. The sandbox attribute guards both renders.
  const chip = savedPath ? relativePath(savedPath, cwd ?? "") : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 px-1.5">
        <button
          type="button"
          onClick={() => {
            if (scriptsAllowed) {
              setScriptsAllowed(false);
              return;
            }
            setConsentOpen(true);
          }}
          className={toolbarBtn}
        >
          <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={1.75} />
          {scriptsAllowed ? "Scripts on" : "Run scripts"}
        </button>
        {cwd && !doc.path && doc.kind !== "image" ? (
          <button
            type="button"
            onClick={() => void save()}
            className={toolbarBtn}
          >
            <HugeiconsIcon icon={Download01Icon} size={12} strokeWidth={1.75} />
            Save
          </button>
        ) : null}
        {chip ? (
          <button
            type="button"
            title={`Open ${savedPath} in the editor`}
            onClick={openSavedInEditor}
            className={cn(
              "min-w-0 truncate rounded px-1 text-xs text-muted-foreground",
              "underline-offset-2 hover:text-foreground hover:underline",
            )}
          >
            {chip}
          </button>
        ) : null}
        <span className="flex-1" />
        {error ? (
          <span className="truncate text-xs text-destructive">{error}</span>
        ) : null}
      </div>
      {consentOpen ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            Scripts in this artifact run with the network blocked.
          </span>
          <button
            type="button"
            onClick={() => {
              setConsentOpen(false);
              setScriptsAllowed(true);
            }}
            className={toolbarBtn}
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => setConsentOpen(false)}
            className={toolbarBtn}
          >
            Cancel
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 bg-white">
        {scriptsAllowed ? (
          <iframe
            title={doc.title}
            src={htmlDataUrl(viewerDocument(doc))}
            sandbox={ARTIFACT_SANDBOX_SCRIPTS}
            className="h-full w-full border-0"
          />
        ) : (
          <iframe
            title={doc.title}
            srcDoc={viewerDocument(doc)}
            sandbox={ARTIFACT_SANDBOX}
            className="h-full w-full border-0"
          />
        )}
      </div>
    </div>
  );
}

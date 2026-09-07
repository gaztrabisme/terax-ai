import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { useEffect, useState } from "react";
import type { PiPartRendererProps } from "./registry";

type FileStat = { size: number; mtime: number; kind: string };

/** The fallback card ImageRenderer rendered before bitmaps were renderable:
 *  name, size when known, and the path. */
function ImageChip({
  path,
  stat,
  missing,
}: {
  path: string;
  stat: FileStat | null;
  missing: boolean;
}) {
  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <div className="my-1 flex items-center gap-2 rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{name}</span>
      {stat ? <span>{stat.size.toLocaleString()} bytes</span> : null}
      {missing ? <span>file missing</span> : null}
      <span className="truncate font-mono text-xs">{path}</span>
    </div>
  );
}

/** Asset protocol URL for a local path, or null outside Tauri (tests, plain
 *  browser) where convertFileSrc has nothing to talk to. */
export function assetUrlFor(path: string): string | null {
  if (!path) return null;
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

function openInEditor(path: string): void {
  window.dispatchEvent(new CustomEvent("pi:open-file", { detail: { path } }));
}

// pi writes tool artifacts under <agent dir>/tool-output-artifacts/ and the
// asset protocol scope is granted at spawn/prepare time, so this renders the
// bitmap inline through convertFileSrc. The chip stays as the fallback when
// the file is missing, outside any granted directory (the img fails to load),
// or no asset URL can be built. Click opens the file in the editor tab.
export function ImageRenderer({ part }: PiPartRendererProps) {
  const path = (part.text ?? "").trim();
  const [stat, setStat] = useState<FileStat | null>(null);
  const [missing, setMissing] = useState(false);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setBroken(false);
    invoke<FileStat>("fs_stat", { path, workspace: currentWorkspaceEnv() })
      .then((s) => {
        if (alive) setStat(s);
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  const src = assetUrlFor(path);
  if (!path || !src || missing || broken) {
    return <ImageChip path={path} stat={stat} missing={missing} />;
  }
  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <figure className="my-1 inline-flex max-w-full flex-col items-start gap-1">
      <img
        src={src}
        alt={name}
        title={`Open ${path}`}
        onError={() => setBroken(true)}
        onClick={() => openInEditor(path)}
        className="max-h-64 max-w-full cursor-pointer rounded border border-border/60 object-contain"
      />
      <figcaption className="font-mono text-xs text-muted-foreground">
        {name}
        {stat ? ` - ${stat.size.toLocaleString()} bytes` : ""}
      </figcaption>
    </figure>
  );
}

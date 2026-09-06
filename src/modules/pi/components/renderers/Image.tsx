import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { useEffect, useState } from "react";
import type { PiPartRendererProps } from "./registry";

type FileStat = { size: number; mtime: number; kind: string };

// pi writes tool artifacts under <agent dir>/tool-output-artifacts/. Terax
// has no asset protocol grant for arbitrary paths, so this resolves metadata
// only and renders a fallback card instead of an inline bitmap.
export function ImageRenderer({ part }: PiPartRendererProps) {
  const path = (part.text ?? "").trim();
  const [stat, setStat] = useState<FileStat | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!path) return;
    let alive = true;
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

  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <div className="my-1 flex items-center gap-2 rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">{name}</span>
      {stat ? <span>{stat.size.toLocaleString()} bytes</span> : null}
      {missing ? <span>file missing</span> : null}
      <span className="truncate font-mono text-[10px]">{path}</span>
    </div>
  );
}

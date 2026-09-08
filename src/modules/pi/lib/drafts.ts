import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

export function draftPath(cwd: string, tabId: number): string {
  const base = cwd.replace(/[\\/]+$/, "");
  return `${base}/.pi/drafts/${tabId}.md`;
}

async function ensureDraftDir(cwd: string): Promise<void> {
  const dir = draftPath(cwd, 0).replace(/[^/\\]+\.md$/, "");
  try {
    await invoke("fs_create_dir", {
      path: dir.replace(/[\\/]+$/, ""),
      workspace: currentWorkspaceEnv(),
    });
  } catch {
    // The draft dir already existing is the normal steady state.
  }
}

export async function saveDraft(
  cwd: string,
  tabId: number,
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
  tabId: number,
): Promise<string | null> {
  try {
    const res = await invoke<{ kind: string; content?: string }>(
      "fs_read_file",
      { path: draftPath(cwd, tabId), workspace: currentWorkspaceEnv() },
    );
    return res.kind === "text" && typeof res.content === "string"
      ? res.content
      : null;
  } catch {
    return null;
  }
}

export async function clearDraft(cwd: string, tabId: number): Promise<void> {
  for (const path of [draftPath(cwd, tabId), draftMetaPath(cwd, tabId)]) {
    try {
      await invoke("fs_delete", { path, workspace: currentWorkspaceEnv() });
    } catch {
      // Nothing to clear.
    }
  }
}

/// ---------------------------------------------------------------------------
/// Draft sidecar (K8): where each transferred terminal block quotation came
/// from. <draft path>.json holds {v:1, sources:[...]} next to the draft text;
/// evidence only, never load-bearing for sending.
/// ---------------------------------------------------------------------------

export type DraftSourceMeta = {
  blockId: number;
  terminalId: number;
  sha256: string;
  insertedAt: string;
};

export type DraftMeta = { v: 1; sources: DraftSourceMeta[] };

export function draftMetaPath(cwd: string, tabId: number): string {
  return `${draftPath(cwd, tabId)}.json`;
}

export async function saveDraftMeta(
  cwd: string,
  tabId: number,
  meta: DraftMeta,
): Promise<void> {
  await ensureDraftDir(cwd);
  await invoke("fs_write_file", {
    path: draftMetaPath(cwd, tabId),
    content: JSON.stringify(meta),
    workspace: currentWorkspaceEnv(),
  });
}

export async function loadDraftMeta(
  cwd: string,
  tabId: number,
): Promise<DraftMeta | null> {
  try {
    const res = await invoke<{ kind: string; content?: string }>(
      "fs_read_file",
      { path: draftMetaPath(cwd, tabId), workspace: currentWorkspaceEnv() },
    );
    if (res.kind !== "text" || typeof res.content !== "string") return null;
    const parsed = JSON.parse(res.content) as { v?: unknown; sources?: unknown };
    if (parsed?.v !== 1 || !Array.isArray(parsed.sources)) return null;
    const sources = parsed.sources.filter(
      (s): s is DraftSourceMeta =>
        !!s &&
        typeof s === "object" &&
        typeof (s as DraftSourceMeta).blockId === "number" &&
        typeof (s as DraftSourceMeta).terminalId === "number" &&
        typeof (s as DraftSourceMeta).sha256 === "string" &&
        typeof (s as DraftSourceMeta).insertedAt === "string",
    );
    return { v: 1, sources };
  } catch {
    return null;
  }
}

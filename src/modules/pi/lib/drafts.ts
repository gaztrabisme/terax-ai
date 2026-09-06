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
  try {
    await invoke("fs_delete", {
      path: draftPath(cwd, tabId),
      workspace: currentWorkspaceEnv(),
    });
  } catch {
    // Nothing to clear.
  }
}

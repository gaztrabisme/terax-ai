import { open } from "@tauri-apps/plugin-dialog";
import { native } from "@/lib/native";

/**
 * Ask for the folder a new pi session should run in. Resolves the picked
 * path, or null when the dialog is cancelled.
 */
export async function pickPiFolder(
  defaultPath?: string,
): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    defaultPath,
  });
  if (typeof picked !== "string") return null;
  // Match the cwd shape the rest of the app stores (launchDir does the same
  // backslash-to-slash normalization on Windows).
  return picked.replace(/\\/g, "/");
}

export type PiFolderPick =
  | { status: "picked"; dir: string }
  | { status: "unauthorized"; error: string }
  | { status: "cancelled" };

/**
 * Pick a folder and register it with the workspace authorization registry so
 * the board's shell commands can run under it. The registry's canonical form
 * (macOS /tmp -> /private/tmp) is what the tab stores as cwd, matching the
 * --pi launch path. A failed authorization is reported instead of opening a
 * tab whose board would be offline.
 */
export async function pickPiSessionFolder(
  defaultPath?: string,
): Promise<PiFolderPick> {
  const picked = await pickPiFolder(defaultPath);
  if (!picked) return { status: "cancelled" };
  try {
    return { status: "picked", dir: await native.workspaceAuthorize(picked) };
  } catch (e) {
    return { status: "unauthorized", error: String(e) };
  }
}

import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;

export async function initLaunchDir(): Promise<void> {
  const dir =
    (await invoke<string | null>("get_launch_dir").catch(() => null)) ??
    (await invoke<string>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

// Backend drains the flag on first read; a failed call is treated as absent.
export async function consumeLaunchPi(): Promise<boolean> {
  try {
    return (await invoke<boolean>("get_launch_pi")) === true;
  } catch {
    return false;
  }
}

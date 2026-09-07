import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { create } from "zustand";
import {
  answerAsk as answerAskIn,
  applyEvent,
  askResponseLine,
  dismissAsk as dismissAskIn,
  initialPiSessionState,
  promptLine,
  resetAsk as resetAskIn,
  type PiAskAnswer,
  type PiImageAttachment,
  type PiSessionState,
} from "./parse";
import { piSpawnEnv, resolvePiPrefs, type PiRuntimePrefs } from "./providers";
import { openPiSession, type PiSessionHandle } from "./rpc-client";
import { PI_MODULE_PREFS_DEFAULTS } from "./settingsSchema";

export type PiOpenOptions = {
  cwd?: string;
  launcherDir?: string;
  program?: string;
  args?: string[];
  env?: Record<string, string>;
};

/** Resolved model roles for the session; ChatPane reads this for its
 *  data-pi-model / data-pi-smol root attributes. */
export type PiRoles = { provider: string; model: string; smol: string };

type PiTabEntry = {
  /** Open generation; a later open for the same tab supersedes this one. */
  gen: number;
  state: PiSessionState;
  session: PiSessionHandle | null;
  exited: boolean;
  exitCode: number | null;
  error: string | null;
  roles: PiRoles;
};

type PiStore = {
  tabs: Record<number, PiTabEntry>;
  openSession: (tabId: number, opts: PiOpenOptions) => Promise<void>;
  sendPrompt: (
    tabId: number,
    text: string,
    images?: PiImageAttachment[],
  ) => Promise<void>;
  answerAsk: (
    tabId: number,
    requestId: string,
    answers: PiAskAnswer[],
  ) => Promise<void>;
  dismissAsk: (tabId: number, requestId: string) => Promise<void>;
  kill: (tabId: number) => Promise<void>;
  close: (tabId: number) => void;
};

// Returns a store partial, not the map: zustand merges what `set` returns
// into the root state, so returning the map would write entries beside
// `tabs` and leave `tabs` untouched.
function patchEntry(
  tabs: Record<number, PiTabEntry>,
  tabId: number,
  patch: (entry: PiTabEntry) => PiTabEntry,
): { tabs: Record<number, PiTabEntry> } {
  const entry = tabs[tabId];
  if (!entry) return { tabs };
  return { tabs: { ...tabs, [tabId]: patch(entry) } };
}

let openGen = 0;

/** Global pi prefs from the LazyStore (defaults when not yet hydrated). */
function globalPiPrefs(): Partial<PiRuntimePrefs> {
  const p = usePreferencesStore.getState();
  return {
    launcherDir: p.piLauncherDir,
    boardBin: p.piBoardBin,
    agentBin: p.piAgentBin,
    agentDir: p.piAgentDir,
    provider: p.piProvider,
    model: p.piModel,
    thinking: p.piThinking,
    smol: p.piSmol,
    bppcHost: p.piBppcHost,
  };
}

/** Parses `<cwd>/.pi/terax.json`; unreadable or missing file resolves to null. */
async function readWorkspaceOverrides(cwd?: string): Promise<unknown> {
  if (!cwd) return null;
  try {
    const res = await invoke<{ kind: string; content?: string }>(
      "fs_read_file",
      { path: `${cwd}/.pi/terax.json`, workspace: currentWorkspaceEnv() },
    );
    if (res.kind !== "text" || !res.content) return null;
    return JSON.parse(res.content) as unknown;
  } catch {
    return null;
  }
}

async function resolvePrefsForCwd(cwd?: string): Promise<PiRuntimePrefs> {
  const overrides = await readWorkspaceOverrides(cwd);
  return resolvePiPrefs(globalPiPrefs(), overrides);
}

export const usePiStore = create<PiStore>()((set, get) => ({
  tabs: {},

  openSession: async (tabId, opts) => {
    // A second open for the same tab replaces the first; the stale in-flight
    // open is killed the moment it resolves.
    const gen = ++openGen;
    const resolved = await resolvePrefsForCwd(opts.cwd);
    // The PiTab default param equals the module default; an explicit caller
    // override wins, otherwise the user's launcherDir pref applies.
    const launcherDir =
      opts.launcherDir &&
      opts.launcherDir !== PI_MODULE_PREFS_DEFAULTS.launcherDir
        ? opts.launcherDir
        : resolved.launcherDir;
    const entry: PiTabEntry = {
      gen,
      state: initialPiSessionState(),
      session: null,
      exited: false,
      exitCode: null,
      error: null,
      roles: {
        provider: resolved.provider,
        model: resolved.model,
        smol: resolved.smol,
      },
    };
    set((s) => ({ tabs: { ...s.tabs, [tabId]: entry } }));
    try {
      const session = await openPiSession({
        ...opts,
        launcherDir,
        env: {
          // Both spawn paths (checkout launcher, direct pi) inherit this env:
          // the bppc host rides from the pref (workspace override included),
          // and Rust injects the stored oMLX key caller-wins, so the
          // models.json render and pi itself see the same values.
          ...piSpawnEnv(resolved, resolved.agentDir, {
            bppcHost: resolved.bppcHost,
          }),
          ...opts.env,
        },
        onEvent: (line) =>
          set((s) =>
            patchEntry(s.tabs, tabId, (e) => ({
              ...e,
              state: applyEvent(e.state, line),
            })),
          ),
        onExit: (code) =>
          set((s) =>
            patchEntry(s.tabs, tabId, (e) => ({
              ...e,
              session: null,
              exited: true,
              exitCode: code,
            })),
          ),
      });
      // Events may have patched the entry before open resolved, so compare
      // the generation, not the object.
      if (get().tabs[tabId]?.gen !== gen) {
        void session.kill();
        return;
      }
      set((s) => patchEntry(s.tabs, tabId, (e) => ({ ...e, session })));
    } catch (e) {
      set((s) =>
        patchEntry(s.tabs, tabId, (err) => ({
          ...err,
          error: e instanceof Error ? e.message : String(e),
        })),
      );
    }
  },

  sendPrompt: async (tabId, text, images) => {
    const session = get().tabs[tabId]?.session;
    if (!session) return;
    await session.send(promptLine(text, images));
  },

  answerAsk: async (tabId, requestId, answers) => {
    const entry = get().tabs[tabId];
    if (!entry) return;
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => ({
        ...e,
        state: answerAskIn(e.state, requestId, answers),
      })),
    );
    try {
      await entry.session?.send(askResponseLine(requestId, answers));
    } catch (e) {
      set((s) =>
        patchEntry(s.tabs, tabId, (err) => ({
          ...err,
          state: resetAskIn(err.state, requestId),
          error: e instanceof Error ? e.message : String(e),
        })),
      );
    }
  },

  dismissAsk: async (tabId, requestId) => {
    const entry = get().tabs[tabId];
    if (!entry) return;
    set((s) =>
      patchEntry(s.tabs, tabId, (e) => ({
        ...e,
        state: dismissAskIn(e.state, requestId),
      })),
    );
    try {
      await entry.session?.send(
        JSON.stringify({ type: "ask_response", requestId, dismissed: true }),
      );
    } catch (e) {
      set((s) =>
        patchEntry(s.tabs, tabId, (err) => ({
          ...err,
          state: resetAskIn(err.state, requestId),
          error: e instanceof Error ? e.message : String(e),
        })),
      );
    }
  },

  kill: async (tabId) => {
    const session = get().tabs[tabId]?.session;
    if (!session) return;
    await session.kill();
  },

  close: (tabId) => {
    const entry = get().tabs[tabId];
    if (!entry) return;
    set((s) => {
      if (!s.tabs[tabId]) return s;
      const tabs = { ...s.tabs };
      delete tabs[tabId];
      return { tabs };
    });
    void entry.session?.kill();
  },
}));

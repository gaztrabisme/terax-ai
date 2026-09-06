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
  type PiSessionState,
} from "./parse";
import { openPiSession, type PiSessionHandle } from "./rpc-client";

export type PiOpenOptions = {
  cwd?: string;
  launcherDir?: string;
  program?: string;
  args?: string[];
  env?: Record<string, string>;
};

type PiTabEntry = {
  state: PiSessionState;
  session: PiSessionHandle | null;
  exited: boolean;
  exitCode: number | null;
  error: string | null;
};

type PiStore = {
  tabs: Record<number, PiTabEntry>;
  openSession: (tabId: number, opts: PiOpenOptions) => Promise<void>;
  sendPrompt: (tabId: number, text: string) => Promise<void>;
  answerAsk: (
    tabId: number,
    requestId: string,
    answers: PiAskAnswer[],
  ) => Promise<void>;
  dismissAsk: (tabId: number, requestId: string) => Promise<void>;
  kill: (tabId: number) => Promise<void>;
  close: (tabId: number) => void;
};

function patchEntry(
  tabs: Record<number, PiTabEntry>,
  tabId: number,
  patch: (entry: PiTabEntry) => PiTabEntry,
): Record<number, PiTabEntry> {
  const entry = tabs[tabId];
  if (!entry) return tabs;
  return { ...tabs, [tabId]: patch(entry) };
}

export const usePiStore = create<PiStore>()((set, get) => ({
  tabs: {},

  openSession: async (tabId, opts) => {
    // React strict mode mounts effects twice: a second open replaces the
    // first, and a stale in-flight open is killed the moment it resolves.
    const entry: PiTabEntry = {
      state: initialPiSessionState(),
      session: null,
      exited: false,
      exitCode: null,
      error: null,
    };
    set((s) => ({ tabs: { ...s.tabs, [tabId]: entry } }));
    try {
      const session = await openPiSession({
        ...opts,
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
      if (get().tabs[tabId] !== entry) {
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

  sendPrompt: async (tabId, text) => {
    const session = get().tabs[tabId]?.session;
    if (!session) return;
    await session.send(promptLine(text));
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

import { create } from "zustand";
import { readProjectText } from "@/modules/pi/lib/ledgerStore";
import { watchTranscripts, type TranscriptWatch } from "@/modules/pi/lib/rpc-client";
import {
  applyEvent,
  initialPiSessionState,
  type PiSessionState,
} from "./parse";

type ChildStore = {
  /** Child transcript file -> reduced child session state. */
  children: Record<string, PiSessionState>;
  owners: Record<string, string>;
  errors: Record<string, string>;
  applyLine: (file: string, line: string) => void;
  reset: () => void;
};

/** One reducer instance per child transcript file, reusing the B6a parser. */
export const useChildStore = create<ChildStore>()((set) => ({
  children: {},
  owners: {},
  errors: {},
  applyLine: (file, line) =>
    set((s) => {
      try { transcriptEvent(line); }
      catch (error) { return { errors: { ...s.errors, [file]: `Transcript parse: ${String(error)} (${file})` } }; }
      const prev = s.children[file] ?? initialPiSessionState();
      const next = applyEvent(prev, line);
      if (next === prev) return s;
      return { children: { ...s.children, [file]: next } };
    }),
  reset: () => {
    transcripts.clear();
    set({ children: {}, owners: {}, errors: {} });
  },
}));

function transcriptEvent(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  const event: unknown = JSON.parse(line);
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof (event as { type?: unknown }).type !== "string") {
    throw new Error("invalid transcript event");
  }
  return event as Record<string, unknown>;
}

export function replayTranscript(text: string): PiSessionState {
  let state = initialPiSessionState();
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  for (const [index, line] of complete.split("\n").entries()) {
    try {
      const event = transcriptEvent(line);
      if (!event) continue;
      state = applyEvent(state, line, typeof event.timestamp === "number" ? event.timestamp : 0);
    } catch (error) { throw new Error(`line ${index + 1}: ${String(error)}`); }
  }
  return state;
}

type TranscriptRead = { text?: string; pending?: Promise<void>; again: boolean };
const transcripts = new Map<string, TranscriptRead>();

export function loadChildTranscript(file: string, owner?: string): Promise<void> {
  if (owner) useChildStore.setState((s) => s.owners[file] ? s : { owners: { ...s.owners, [file]: owner } });
  let reader = transcripts.get(file);
  if (!reader) { reader = { again: false }; transcripts.set(file, reader); }
  const current = reader;
  if (current.pending) { current.again = true; return current.pending; }
  current.pending = (async () => {
    do {
      current.again = false;
      try {
        const text = await readProjectText(file);
        if (transcripts.get(file) !== current) return;
        const state = text === current.text ? null : replayTranscript(text);
        current.text = text;
        useChildStore.setState((s) => {
          const errors = { ...s.errors };
          delete errors[file];
          return { children: state ? { ...s.children, [file]: state } : s.children, errors };
        });
      } catch (error) {
        if (transcripts.get(file) !== current) return;
        useChildStore.setState((s) => ({ errors: { ...s.errors, [file]: `Transcript read: ${String(error)} (${file})` } }));
      }
    } while (current.again);
  })().finally(() => { current.pending = undefined; });
  return current.pending;
}

type WatchOwner = () => string | null;
type HubWatch = { clients: Map<symbol, WatchOwner>; watch?: TranscriptWatch };
const hubs = new Map<string, HubWatch>();

export function watchChildTranscripts(cwd: string, owner: WatchOwner): () => void {
  let hub = hubs.get(cwd);
  if (!hub) {
    hub = { clients: new Map() };
    hubs.set(cwd, hub);
    const current = hub;
    const errorPath = `${cwd.replace(/[\\/]+$/, "")}/.pi/agent-hub`;
    const fail = (error: unknown) => {
      if (hubs.get(cwd) !== current) return;
      useChildStore.setState((s) => ({ errors: { ...s.errors, [errorPath]: `pi_watch_transcripts: ${String(error)} (${errorPath}; .pi/logs/graph.jsonl)` } }));
    };
    void watchTranscripts(cwd, ({ file }) => {
      if (hubs.get(cwd) !== current || !file.endsWith(".transcript.jsonl")) return;
      const owners = new Set([...current.clients.values()].map((get) => get()).filter((value): value is string => !!value));
      void loadChildTranscript(file, owners.size === 1 ? [...owners][0] : undefined);
    }, fail).then((watch) => {
      if (hubs.get(cwd) !== current) { void watch.close().catch(fail); return; }
      current.watch = watch;
      useChildStore.setState((s) => {
        const errors = { ...s.errors }; delete errors[errorPath]; return { errors };
      });
    }).catch(fail);
  }
  const client = Symbol();
  hub.clients.set(client, owner);
  const current = hub;
  return () => {
    current.clients.delete(client);
    if (current.clients.size) return;
    hubs.delete(cwd);
    void current.watch?.close().catch((error: unknown) => {
      useChildStore.setState((s) => ({ errors: { ...s.errors, [cwd]: `pi_unwatch: ${String(error)} (${cwd}/.pi/logs/graph.jsonl)` } }));
    });
  };
}

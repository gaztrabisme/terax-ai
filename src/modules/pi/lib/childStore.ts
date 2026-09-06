import { create } from "zustand";
import {
  applyEvent,
  initialPiSessionState,
  type PiSessionState,
} from "./parse";

type ChildStore = {
  /** Child transcript file -> reduced child session state. */
  children: Record<string, PiSessionState>;
  applyLine: (file: string, line: string) => void;
  reset: () => void;
};

/** One reducer instance per child transcript file, reusing the B6a parser. */
export const useChildStore = create<ChildStore>()((set) => ({
  children: {},
  applyLine: (file, line) =>
    set((s) => {
      const prev = s.children[file] ?? initialPiSessionState();
      const next = applyEvent(prev, line);
      if (next === prev) return s;
      return { children: { ...s.children, [file]: next } };
    }),
  reset: () => set({ children: {} }),
}));

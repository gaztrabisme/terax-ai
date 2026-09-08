import { useEffect, useRef } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  hasLocalKeyPriority,
  isModalTarget,
  isTerminalTarget,
} from "./eventPriority";
import { SHORTCUTS, matchBinding, type ShortcutId } from "../shortcuts";

export type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

export type UseGlobalShortcutsOptions = {
  enabled?: boolean;
  isDisabled?: (id: ShortcutId, e: KeyboardEvent) => boolean;
};

export function useGlobalShortcuts(
  handlers: ShortcutHandlers,
  options?: UseGlobalShortcutsOptions,
) {
  const latest = useRef({ handlers, options });
  latest.current = { handlers, options };

  // Access the shortcuts from the store
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const enabled = options?.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isModalTarget(e.target))
        return;
      if (
        isTerminalTarget(e.target) &&
        ["Tab", "Enter", "Escape"].includes(e.key)
      )
        return;
      const { handlers, options } = latest.current;
      for (const s of SHORTCUTS) {
        if (e.repeat && !s.allowRepeat) continue;
        const bindings = userShortcuts[s.id] || s.defaultBindings;
        const isMatch = bindings.some((b) => matchBinding(e, b, s.id));
        if (!isMatch) continue;
        if (s.group === "Pi" && isTerminalTarget(e.target)) return;
        if (options?.isDisabled?.(s.id, e)) return;
        const h = handlers[s.id];
        if (!h) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        h(e);
        return;
      }
    };
    const capture = (event: KeyboardEvent) => {
      if (!hasLocalKeyPriority(event.target)) onKey(event);
    };
    const bubble = (event: KeyboardEvent) => {
      if (hasLocalKeyPriority(event.target)) onKey(event);
    };
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", bubble);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", bubble);
    };
  }, [enabled, userShortcuts]);
}

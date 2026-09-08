import { usePreferencesStore } from "@/modules/settings/preferences";
import { setTerminalComposer } from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import type { SearchAddon } from "@xterm/addon-search";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { BlockChrome } from "./components/BlockChrome";
import { TerminalComposer } from "./components/TerminalComposer";
import type { BlockStore } from "./lib/blocks";
import { useTerminalSession, writeToSession } from "./lib/useTerminalSession";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
};

type Props = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab — receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(
  function TerminalPane(
    {
      leafId,
      visible,
      focused = true,
      initialCwd,
      onSearchReady,
      onExit,
      onCwd,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { resolvedMode, themeId, customThemes } = useTheme();
    // Route A: the composer is opt-in (default false). The pane button and
    // the Settings row are two views of the one persisted preference, so
    // every mounted pane follows the committed value, including updates
    // written from another window.
    const composerEnabled = usePreferencesStore((s) => s.terminalComposer);
    const [blockStore, setBlockStore] = useState<BlockStore | null>(null);

    const session = useTerminalSession({
      leafId,
      container: containerRef,
      visible,
      focused,
      initialCwd,
      onSearchReady: (a) => onSearchReady?.(leafId, a),
      onExit: (c) => onExit?.(leafId, c),
      onCwd: (c) => onCwd?.(leafId, c),
      onBlockStore: setBlockStore,
    });

    useEffect(() => {
      // Defer one frame so CSS-variable token resolution sees the new class.
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedMode, themeId, customThemes, session]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => session.write(data),
        focus: () => session.focus(),
        getBuffer: (max?: number) => session.getBuffer(max),
        getSelection: () => session.getSelection(),
      }),
      [session],
    );

    return (
      <div
        data-uat="terminal-tab"
        data-uat-key={String(leafId)}
        className="zoom-exempt group relative flex h-full w-full flex-col"
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
      >
        {/* The pooled slot host is appended into this inner node. */}
        <div
          ref={containerRef}
          data-uat="terminal-emulator"
          data-uat-key={String(leafId)}
          className="relative min-h-0 w-full flex-1"
        />
        {composerEnabled ? (
          <TerminalComposer
            leafId={leafId}
            bound={blockStore !== null}
            onWrite={(data) => writeToSession(leafId, data)}
            onFocusEmulator={session.focus}
          />
        ) : null}
        <BlockChrome leafId={leafId} store={blockStore} />
        <button
          type="button"
          data-uat="composer-toggle"
          onClick={() => void setTerminalComposer(!composerEnabled)}
          aria-pressed={composerEnabled}
          title={composerEnabled ? "Hide composer" : "Show composer"}
          className="absolute right-2 top-1 z-20 rounded-md border border-border/60 bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          {composerEnabled ? "Composer on" : "Composer off"}
        </button>
      </div>
    );
  },
);

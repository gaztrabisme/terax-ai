/**
 * Unit K4: canonical UAT ids from design.md section 3.7 whose owner column
 * says K4 (plus the K2-built `terminal-composer-default` checkbox). One entry
 * per in-scope id, with the component file that carries the attribute.
 * `tab-active` and `tab` share one element per tab: the active tab carries
 * `tab-active`, the others `tab`, both keyed by tab id.
 */
export type UatIdEntry = { id: string; file: string };

/** Ids on controls this tree renders in a state unit tests can reach. */
export const UAT_IDS_K4: UatIdEntry[] = [
  { id: "header", file: "src/modules/header/Header.tsx" },
  { id: "sidebar-toggle", file: "src/modules/header/Header.tsx" },
  { id: "settings-button", file: "src/modules/header/Header.tsx" },
  { id: "tab-bar", file: "src/modules/tabs/TabBar.tsx" },
  { id: "tab", file: "src/modules/tabs/TabBar.tsx" },
  { id: "tab-active", file: "src/modules/tabs/TabBar.tsx" },
  { id: "new-tab", file: "src/modules/tabs/TabBar.tsx" },
  { id: "new-pi-session", file: "src/modules/tabs/TabBar.tsx" },
  { id: "sidebar", file: "src/app/App.tsx" },
  { id: "statusbar", file: "src/modules/statusbar/StatusBar.tsx" },
  { id: "cwd-breadcrumb", file: "src/modules/statusbar/CwdBreadcrumb.tsx" },
  { id: "pi-tab", file: "src/modules/pi/PiTab.tsx" },
  { id: "session-strip", file: "src/modules/pi/components/ChatPane.tsx" },
  { id: "session-status", file: "src/modules/pi/components/ChatPane.tsx" },
  { id: "turn-tokens", file: "src/modules/pi/components/ChatPane.tsx" },
  { id: "session-cost", file: "src/modules/pi/components/ChatPane.tsx" },
  { id: "session-id", file: "src/modules/pi/components/ChatPane.tsx" },
  { id: "stop-button", file: "src/modules/pi/components/ChatPane.tsx" },
  { id: "new-session", file: "src/modules/pi/components/ChatPane.tsx" },
  { id: "transcript", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "pi-turn", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "turn-user", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "attachment-chip", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "turn-fold", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "usage-footer", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "cache-share", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "cache-qualifier", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "answer-body", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "answer-actions", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "copy", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "copy-markdown", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "open-in-editor", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "open-artifact", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "child-card", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "open-transcript", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "error-card", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "retry-card", file: "src/modules/pi/components/Transcript.tsx" },
  { id: "tool-row", file: "src/modules/pi/components/blocks/ToolRow.tsx" },
  {
    id: "keystone-card",
    file: "src/modules/pi/components/blocks/KeystoneCard.tsx",
  },
  {
    id: "keystone-option",
    file: "src/modules/pi/components/blocks/KeystoneCard.tsx",
  },
  {
    id: "keystone-approve",
    file: "src/modules/pi/components/blocks/KeystoneCard.tsx",
  },
  {
    id: "keystone-reject",
    file: "src/modules/pi/components/blocks/KeystoneCard.tsx",
  },
  { id: "composer-input", file: "src/modules/pi/components/Composer.tsx" },
  { id: "attach-images", file: "src/modules/pi/components/Composer.tsx" },
  { id: "model-chip", file: "src/modules/pi/components/Composer.tsx" },
  { id: "send-button", file: "src/modules/pi/components/Composer.tsx" },
  { id: "prompt-menu", file: "src/modules/pi/components/PromptMenu.tsx" },
  {
    id: "sessions-search",
    file: "src/modules/pi/components/SessionSearch.tsx",
  },
  { id: "sessions-list", file: "src/modules/pi/components/SessionSearch.tsx" },
  { id: "session-row", file: "src/modules/pi/components/SessionSearch.tsx" },
  { id: "board-columns", file: "src/modules/pi/components/board/Kanban.tsx" },
  {
    id: "board-ticket",
    file: "src/modules/pi/components/board/TicketCard.tsx",
  },
  {
    id: "ticket-sheet",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
  },
  {
    id: "board-align",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
  },
  { id: "board-land", file: "src/modules/pi/components/board/TicketSheet.tsx" },
  {
    id: "board-close",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
  },
  {
    id: "board-rework",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
  },
  { id: "artifact-frame", file: "src/modules/pi/components/ArtifactPane.tsx" },
  {
    id: "child-tab",
    file: "src/modules/pi/components/AgentTranscriptPane.tsx",
  },
  {
    id: "child-transcript",
    file: "src/modules/pi/components/AgentTranscriptPane.tsx",
  },
  {
    id: "terminal-composer",
    file: "src/modules/terminal/components/TerminalComposer.tsx",
  },
  { id: "pi-check-panel", file: "src/settings/sections/PiFirstRun.tsx" },
  { id: "check-row", file: "src/settings/sections/PiFirstRun.tsx" },
  { id: "pi-first-run-check", file: "src/settings/sections/PiFirstRun.tsx" },
  { id: "provider-table", file: "src/settings/sections/PiSection.tsx" },
  { id: "settings-secret", file: "src/settings/sections/PiSection.tsx" },
  {
    id: "terminal-composer-default",
    file: "src/settings/sections/GeneralSection.tsx",
  },
];

/**
 * Ids whose element exists in source but only in a state an isolated render
 * cannot reach; `state` names the state that reveals the element.
 */
export type UatStatefulEntry = { id: string; file: string; state: string };

export const UAT_IDS_K4_STATEFUL: UatStatefulEntry[] = [
  {
    id: "terminal-history-reopen",
    file: "src/modules/terminal/components/TerminalHistory.tsx",
    state: "the terminal history list contains recorded work, including the active terminal",
  },
  {
    id: "terminal-tab",
    file: "src/modules/terminal/TerminalPane.tsx",
    state: "a mounted terminal pane backed by a live pty session",
  },
  {
    id: "terminal-emulator",
    file: "src/modules/terminal/TerminalPane.tsx",
    state: "a mounted terminal pane with its pooled xterm emulator bound",
  },
  {
    id: "composer-toggle",
    file: "src/modules/terminal/TerminalPane.tsx",
    state: "a terminal pane with a bound session (the button rides the pane)",
  },
  {
    id: "terminal-block",
    file: "src/modules/terminal/components/BlockChrome.tsx",
    state: "a command block in the persistent live overlay or recovered history",
  },
  {
    id: "exit-dot-ok",
    file: "src/modules/terminal/components/BlockChrome.tsx",
    state: "a block whose command exited 0",
  },
  {
    id: "exit-dot-fail",
    file: "src/modules/terminal/components/BlockChrome.tsx",
    state: "a block whose command exited nonzero",
  },
  {
    id: "exit-dot-unknown",
    file: "src/modules/terminal/components/BlockChrome.tsx",
    state: "a block closed without a parseable exit code",
  },
  {
    id: "block-actions",
    file: "src/modules/terminal/components/BlockChrome.tsx",
    state: "a focusable action menu on a live or recovered block",
  },
  {
    id: "block-copy",
    file: "src/modules/terminal/components/BlockChrome.tsx",
    state: "a block's persistent action group, revealed by Block actions or hover",
  },
  {
    id: "block-copy-ansi",
    file: "src/modules/terminal/components/BlockChrome.tsx",
    state: "a block's persistent action group, revealed by Block actions or hover",
  },
  {
    id: "block-rerun",
    file: "src/modules/terminal/components/BlockChrome.tsx",
    state: "a block with a known command in the persistent action group",
  },
  {
    id: "block-send-to-chat",
    file: "src/modules/terminal/components/BlockChrome.tsx",
    state: "a command block in the persistent live overlay or recovered history",
  },
  {
    id: "graph-node-orchestrator",
    file: "src/modules/pi/components/RunGraph.tsx",
    state:
      "the run graph mounted on the active pi tab (lazy React Flow canvas)",
  },
  {
    id: "graph-node-child",
    file: "src/modules/pi/components/RunGraph.tsx",
    state: "the run graph with at least one child agent node",
  },
  {
    id: "editor-tab",
    file: "src/modules/editor/EditorStack.tsx",
    state: "an open editor tab with its document loaded",
  },
  {
    id: "draft-recover",
    file: "src/modules/tabs/RecoverableDrafts.tsx",
    state: "a project draft whose stable id belongs to no open tab",
  },
  {
    id: "editor-input",
    file: "src/modules/editor/EditorPane.tsx",
    state: "an open editor tab with its document loaded",
  },
  {
    id: "editor-recovered",
    file: "src/modules/editor/EditorPane.tsx",
    state:
      "an editor tab whose unsaved buffer was restored from its draft (K11c recovery marker)",
  },
  {
    id: "turn-queued",
    file: "src/modules/pi/components/Transcript.tsx",
    state: "a chat entry with a queued follow-up prompt",
  },
  {
    id: "queued-remove",
    file: "src/modules/pi/components/Transcript.tsx",
    state: "a chat entry with a queued follow-up prompt",
  },
  {
    id: "submission-retry",
    file: "src/modules/pi/components/Transcript.tsx",
    state: "a failed submission standing (K13: unacknowledged send with its error)",
  },
  {
    id: "artifact-path",
    file: "src/modules/pi/components/ArtifactPane.tsx",
    state: "the artifact viewer showing a completed file-backed artifact (K13)",
  },
  {
    id: "artifact-copy-path",
    file: "src/modules/pi/components/ArtifactPane.tsx",
    state: "the artifact viewer showing a completed file-backed artifact (K13)",
  },
  {
    id: "artifact-error",
    file: "src/modules/pi/components/ArtifactPane.tsx",
    state: "the artifact viewer whose file is missing or unreadable (K13)",
  },
  {
    id: "artifact-stale",
    file: "src/modules/pi/components/ArtifactPane.tsx",
    state:
      "the artifact viewer keeping its last good frame after a failed re-read (stale since marker, UX-19)",
  },
];

/**
 * Inventory rows whose owner column says K4 but whose control does not exist
 * in this tree. Nothing asserts them; naming them here keeps the audit
 * explicit instead of inventing UI. `command-palette`: the header has no
 * command button. `board-verify`: the ticket sheet
 * exposes no Verify verb (`board-confirm` and `board-cancel` exist while a
 * verb is armed, listed as stateful). `editor-path`, `editor-save`: the editor pane renders no path
 * element and no Save button (Mod-S only).
 */
export const UAT_IDS_K4_ABSENT: { id: string; reason: string }[] = [
  { id: "command-palette", reason: "no header command button exists" },
  { id: "board-verify", reason: "ticket sheet has no Verify verb button" },
  { id: "editor-path", reason: "editor pane renders no path element" },
  { id: "editor-save", reason: "editor has no Save button (Mod-S only)" },
];

/** K6 replaces rail navigation with the strip and mutually exclusive modes. */
export const UAT_IDS_K6: UatIdEntry[] = [
  { id: "mode-strip", file: "src/modules/pi/components/ModeStrip.tsx" },
  { id: "board-button", file: "src/modules/pi/components/ModeStrip.tsx" },
  { id: "graph-button", file: "src/modules/pi/components/ModeStrip.tsx" },
  { id: "sessions-button", file: "src/modules/pi/components/ModeStrip.tsx" },
  { id: "artifact-button", file: "src/modules/pi/components/ModeStrip.tsx" },
  { id: "sessions-popover", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "sessions-panel", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "sessions-fullscreen", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "sessions-expand", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "board-panel", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "board-fullscreen", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "graph-panel", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "graph-fullscreen", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "artifact-panel", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "artifact-fullscreen", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "panel-resize", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "view-close", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "view-fullscreen", file: "src/modules/pi/components/ChatView.tsx" },
  { id: "view-back", file: "src/modules/pi/components/ChatView.tsx" },
];

/**
 * K11b stateful ids: the storage-error banner renders only while a ui-state
 * write is failing, with Retry re-flushing the pending write. No `saved`
 * state stands while the banner is up (design.md section 3.5).
 */
export const UAT_IDS_K11_STATEFUL: UatStatefulEntry[] = [
  {
    id: "storage-error",
    file: "src/modules/pi/PiTab.tsx",
    state: "a ui-state write failure standing (storage error banner visible)",
  },
  {
    id: "storage-retry",
    file: "src/modules/pi/PiTab.tsx",
    state: "a ui-state write failure standing (storage error banner visible)",
  },
];

/**
 * K14 stateful ids: the launch-error banner and its Open log button render
 * only while a launch preparation failure stands (design.md section 3.5 row
 * "Launch preparation fails": an entry error with no session behind it;
 * Open log opens `<project>/.pi/launcher.log`, New session retries).
 */
export const UAT_IDS_K14_STATEFUL: UatStatefulEntry[] = [
  {
    id: "launch-error",
    file: "src/modules/pi/components/ChatPane.tsx",
    state: "a launch preparation failure standing (entry error, no session)",
  },
  {
    id: "open-launcher-log",
    file: "src/modules/pi/components/ChatPane.tsx",
    state: "a launch preparation failure standing (entry error, no session)",
  },
];

/**
 * K12e stateful ids (design.md section 3.7): the ticket sheet's acceptance
 * section, gate rows and wiki-close verdict render only with a loaded ticket
 * behind the sheet; board-error renders only while a board poll or command
 * has failed, naming the failed command and `.pi/logs/board.jsonl`.
 */
export const UAT_IDS_K12_STATEFUL: UatStatefulEntry[] = [
  {
    id: "ticket-acceptance",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
    state: "the ticket sheet open on a loaded ticket",
  },
  {
    id: "ticket-gate",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
    state: "the ticket sheet open on a loaded ticket",
  },
  {
    id: "ticket-wiki-close",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
    state: "the ticket sheet open on a loaded ticket",
  },
  {
    id: "board-error",
    file: "src/modules/pi/components/BoardPane.tsx",
    state: "a board poll or command failure standing (stale content beneath)",
  },
];

export const UAT_IDS_K12F_STATEFUL: UatStatefulEntry[] = [
  ...["action-row", "action-role", "action-agent", "action-ticket", "action-tokens", "action-cost", "action-duration"].map((id) => ({
    id,
    file: "src/modules/pi/components/blocks/ActionRow.tsx",
    state: "an expanded action in the turn fold or run graph with a persisted ledger record",
  })),
  {
    id: "graph-error",
    file: "src/modules/pi/components/RunGraph.tsx",
    state: "a ledger read, transcript watcher, transcript parse or graph layout failure",
  },
  ...["child-return-chat", "child-open-ticket"].map((id) => ({
    id,
    file: "src/modules/pi/components/AgentTranscriptPane.tsx",
    state: "a child transcript tab, with navigation enabled by its owning delegation",
  })),
];

/**
 * F9 stateful ids: the restore offer renders only when a chat tab reopens on
 * an interrupted exit that recorded an open view; the run summary and its
 * transcript link render only on an open ticket sheet; the confirmation
 * area, Confirm and Cancel exist only while a board verb is armed.
 */
export const UAT_IDS_F9_STATEFUL: UatStatefulEntry[] = [
  {
    id: "layout-offer",
    file: "src/modules/pi/PiTab.tsx",
    state:
      "a chat tab reopening on an interrupted exit that recorded an open view",
  },
  {
    id: "layout-restore",
    file: "src/modules/pi/PiTab.tsx",
    state:
      "a chat tab reopening on an interrupted exit that recorded an open view",
  },
  {
    id: "layout-dismiss",
    file: "src/modules/pi/PiTab.tsx",
    state:
      "a chat tab reopening on an interrupted exit that recorded an open view",
  },
  {
    id: "ticket-run-summary",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
    state: "the ticket sheet open on a ticket",
  },
  {
    id: "child-open-transcript-link",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
    state:
      "the ticket sheet whose latest delegation record names a child transcript",
  },
  {
    id: "board-confirm-area",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
    state: "an armed board verb waiting on its confirmation area",
  },
  {
    id: "board-confirm",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
    state: "an armed board verb waiting on its confirmation area",
  },
  {
    id: "board-cancel",
    file: "src/modules/pi/components/board/TicketSheet.tsx",
    state: "an armed board verb waiting on its confirmation area",
  },
];

import { SearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState, type Ref } from "react";
import {
  piSessionsList,
  piSessionsSearch,
  resolveSessionsAgentDir,
  type PiSessionHit,
  type PiSessionSummary,
} from "../lib/sessions";
import { loadSessionFile, pathMatchesSessionId } from "../lib/sessionFile";
import { usePiStore } from "../lib/piStore";
import { formatHistoryTime } from "@/modules/terminal/lib/historyTime";

const SEARCH_LIMIT = 20;
const DEBOUNCE_MS = 200;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const sessionLabel = formatHistoryTime;

/** The searchable core of a snippet: cut edges and runs of dots off, all
 *  whitespace folded, capped. The transcript renders the same text, so this
 *  is what a scroll-to-turn can look for. */
export function snippetProbe(snippet: string): string {
  return snippet
    .replace(/^[. ]+/, "")
    .replace(/[. ]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function findTextElement(root: ParentNode, needle: string): Element | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeValue && node.nodeValue.toLowerCase().includes(needle)) {
      return node.parentElement;
    }
  }
  return null;
}

/**
 * Scrolls the tab's transcript to the turn a snippet belongs to and flashes
 * it. True when a turn was found (the snippet text must be rendered in this
 * tab's chat column, found via its data-pi-chat marker).
 */
export function scrollToSnippet(snippet: string, tabId: number): boolean {
  const probe = snippetProbe(snippet);
  if (!probe) return false;
  const chat = document.querySelector(`[data-pi-chat="${tabId}"]`);
  if (!chat) return false;
  const target = findTextElement(chat, probe.toLowerCase());
  if (!target) return false;
  target.scrollIntoView({ block: "center" });
  target.setAttribute("tabindex", "-1");
  (target as HTMLElement).focus({ preventScroll: true });
  const prev = target.getAttribute("style") ?? "";
  target.setAttribute(
    "style",
    `${prev};outline: 2px solid var(--ring)`.replace(/^;/, ""),
  );
  window.setTimeout(() => {
    target.setAttribute("style", prev);
  }, 1500);
  return true;
}

export function sessionIdFromPath(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.jsonl$/, "");
  return name.replace(/^\d{4}-\d{2}-\d{2}T[^_]+_/, "");
}

/**
 * Conversation search over pi's session store (philosophy 1: the disk is the
 * truth). Without a query it lists the tab cwd's sessions; with one, it shows
 * the first hit per session. Clicking a hit in the session already open in
 * this tab only scrolls the transcript to that turn. Clicking a past hit
 * loads the session file first, then commits the switch atomically (the
 * store stages the parsed history and swaps it in on pi's switch_session
 * ack), so the chat never shows an emptied transcript.
 */
export function SessionSearch({
  tabId,
  cwd,
  query: savedQuery,
  onQueryChange,
  inputRef,
  onActivate,
}: {
  tabId: number;
  cwd?: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  onActivate?: (hit: PiSessionHit) => void;
}) {
  const [agentDir, setAgentDir] = useState<string | null>(null);
  const [localQuery, setQuery] = useState("");
  const query = savedQuery ?? localQuery;
  const [sessions, setSessions] = useState<PiSessionSummary[] | null>(null);
  const [hits, setHits] = useState<PiSessionHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const [activating, setActivating] = useState<PiSessionHit | null>(null);
  const entry = usePiStore((state) => state.tabs[tabId]);
  useEffect(() => {
    if (!activating || entry?.pendingSwitch || entry?.locatorPending) return;
    if (entry?.switchError) {
      setError(entry.switchError);
      setActivating(null);
    } else if (entry?.sessionPath === activating.path) {
      onActivate?.(activating);
      setActivating(null);
    }
  }, [activating, entry, onActivate]);

  // The runtime agent dir comes from pi_paths once per cwd.
  useEffect(() => {
    mounted.current = true;
    setAgentDir(null);
    setSessions(null);
    setHits(null);
    setError(null);
    if (!cwd) return;
    resolveSessionsAgentDir()
      .then((dir) => {
        if (mounted.current) setAgentDir(dir);
      })
      .catch((e: unknown) => {
        if (mounted.current) setError(errorMessage(e));
      });
    return () => {
      mounted.current = false;
    };
  }, [cwd]);

  // List mode with no query, debounced search otherwise; stale answers drop.
  useEffect(() => {
    if (!cwd || !agentDir) return;
    let alive = true;
    const trimmed = query.trim();
    const timer = window.setTimeout(() => {
      const load =
        trimmed === ""
          ? piSessionsList(cwd, agentDir).then((r) => {
              if (alive) {
                setSessions(r);
                setHits(null);
              }
            })
          : Promise.all([
              piSessionsSearch(cwd, agentDir, trimmed, SEARCH_LIMIT),
              sessions ?? piSessionsList(cwd, agentDir),
            ]).then(([r, summaries]) => {
              if (alive) {
                setHits(r);
                setSessions(summaries);
              }
            });
      load.catch((e: unknown) => {
        if (alive) setError(errorMessage(e));
      });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [cwd, agentDir, query]);

  const openHit = (hit: PiSessionHit) => {
    setError(null);
    const entry = usePiStore.getState().tabs[tabId];
    if (entry?.pendingSwitch || entry?.locatorPending) return;
    const sessionId = entry?.state.sessionId ?? null;
    // A hit in the session already open here only scrolls. pi names session
    // files <timestamp>_<first-8-id-chars>.jsonl (the full id never appears
    // in the name), so the match is by short id.
    if (sessionId !== null && !entry?.switchError && (entry?.sessionPath ? entry.sessionPath === hit.path : pathMatchesSessionId(hit.path, sessionId))) {
      if (scrollToSnippet(hit.snippet, tabId)) onActivate?.(hit);
      else setError(`${hit.path}: matching turn is not rendered in this session.`);
      return;
    }
    // A past hit loads and parses the session file BEFORE anything is sent
    // (F1b): pi's switch_session replays no history, so the store stages the
    // parsed transcript and swaps it in on pi's ack, keeping this
    // conversation visible until then. A read or parse failure names the
    // file and changes nothing.
    if (!cwd) return;
    void (async () => {
      try {
        const parsed = await loadSessionFile(hit.path);
        await usePiStore.getState().switchToSession(tabId, {
          ...parsed,
          path: hit.path,
          snippet: hit.snippet,
        });
        // The wire command was accepted: arm the tab's pending hit so the
        // popover closes when pi's ack swaps the restored transcript in.
        if (mounted.current) setActivating(hit);
      } catch (e) {
        if (mounted.current) setError(errorMessage(e));
      }
    })();
  };

  const openSummary = (summary: PiSessionSummary) => {
    openHit({
      path: summary.path,
      startedAt: summary.startedAt,
      role: "user",
      snippet: summary.firstPrompt,
    });
  };

  const copyId = (path: string) => {
    void navigator.clipboard.writeText(sessionIdFromPath(path)).catch((e: unknown) => {
      if (mounted.current) setError(`Copy id failed: ${errorMessage(e)}`);
    });
  };

  const input =
    "w-full rounded-md border border-border/60 bg-transparent px-2 py-1 text-xs outline-hidden placeholder:text-muted-foreground/60 focus-visible:border-ring";

  // Zero-based position in the rendered result list, shared by the grouped
  // hit rows and the flat session rows; JSX builds in order, so a counter
  // taken at render time is the row's collection index.
  let sessionRowIndex = 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-2">
      <div className="relative shrink-0">
        <HugeiconsIcon
          icon={SearchIcon}
          size={12}
          strokeWidth={1.75}
          className="pointer-events-none absolute top-1/2 start-2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onQueryChange?.(e.target.value);
          }}
          placeholder="Search sessions"
          aria-label="Search pi sessions"
          data-uat="sessions-search"
          className={`${input} ps-7`}
        />
      </div>
      {error ? (
        <div className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 p-1.5 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {!cwd ? (
        <p className="px-1 text-xs text-muted-foreground">
          Open the tab in a project directory to list its sessions.
        </p>
      ) : null}
      <div
        data-uat="sessions-list"
        className="min-h-0 flex-1 overflow-y-auto text-xs"
      >
        {hits !== null
          ? groupHits(hits).flatMap(([path, group]) => group.map((hit, i) => (
              <SessionRow
                key={`${path}-${i}`}
                summary={sessions?.find((summary) => summary.path === path)}
                hit={hit}
                index={sessionRowIndex++}
                rowKey={`${path}-${i}`}
                onOpen={() => openHit(hit)}
                onCopy={() => copyId(path)}
              />
            )))
          : null}
        {hits !== null && hits.length === 0 && query.trim() !== "" ? (
          <p className="px-1 text-muted-foreground">No matches.</p>
        ) : null}
        {hits === null && sessions !== null
          ? sessions.map((session) => (
              <SessionRow
                key={session.path}
                summary={session}
                index={sessionRowIndex++}
                rowKey={session.path}
                onOpen={() => openSummary(session)}
                onCopy={() => copyId(session.path)}
              />
            ))
          : null}
        {sessions !== null && sessions.length === 0 && query.trim() === "" ? (
          <p className="px-1 text-muted-foreground">No sessions yet.</p>
        ) : null}
        {agentDir === null && !error ? (
          <p className="px-1 text-muted-foreground">Loading...</p>
        ) : null}
      </div>
    </div>
  );
}

function SessionRow({ summary, hit, index, rowKey, onOpen, onCopy }: {
  summary?: PiSessionSummary;
  hit?: PiSessionHit;
  index: number;
  rowKey: string;
  onOpen: () => void;
  onCopy: () => void;
}) {
  const path = summary?.path ?? hit!.path;
  const startedAt = summary?.startedAt ?? hit!.startedAt;
  const id = sessionIdFromPath(path);
  const title = `${path}\nSession id: ${id}`;
  const prompt = (summary?.firstPrompt || hit?.snippet || "(no prompt)").replace(/\s+/g, " ").trim();
  return (
    <div className="flex items-start gap-2" title={title}>
      <button
        type="button"
        data-uat="session-row"
        data-uat-key={rowKey}
        data-uat-index={index}
        title={title}
        aria-description={`Session id: ${id}. File: ${path}`}
        onClick={onOpen}
        className="block min-w-0 flex-1 rounded-md px-1 py-1 text-left hover:bg-accent hover:text-foreground"
      >
        <span className="block truncate text-foreground">{prompt}</span>
        <span className="block text-muted-foreground">
          <time dateTime={startedAt}>{sessionLabel(startedAt)}</time>
          {" - "}{summary ? `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}` : "Turn count unavailable"}
        </span>
        {hit && <span className="block truncate text-foreground">
          <span className="me-1.5 rounded border border-border/60 px-1 text-[10px] text-muted-foreground">{hit.role}</span>
          {hit.snippet !== prompt ? hit.snippet : null}
        </span>}
      </button>
      <button type="button" aria-label="Copy id" title={title} onClick={onCopy}
        className="shrink-0 rounded px-1 py-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-ring">
        Copy id
      </button>
    </div>
  );
}

/** Hits grouped per session, backend order (newest first) preserved. */
export function groupHits(hits: PiSessionHit[]): [string, PiSessionHit[]][] {
  const groups = new Map<string, PiSessionHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.path);
    if (group) group.push(hit);
    else groups.set(hit.path, [hit]);
  }
  return [...groups.entries()];
}

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
import { usePiStore } from "../lib/piStore";

const SEARCH_LIMIT = 20;
const DEBOUNCE_MS = 200;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "2026-06-08T15:07:02.400Z" as "2026-06-08 15:07": stable, no locale. */
export function sessionLabel(startedAt: string): string {
  return startedAt.slice(0, 16).replace("T", " ");
}

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
  const target = findTextElement(chat ?? document, probe.toLowerCase());
  if (!target) return false;
  target.scrollIntoView({ block: "center" });
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

/** basename of a session file path, for compact group headers. */
function pathLabel(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Conversation search over pi's session store (philosophy 1: the disk is the
 * truth). Without a query it lists the tab cwd's sessions; with one, it shows
 * the first hit per session. Clicking a result switches the tab's pi rpc
 * session to it (switch_session), or, when the hit is in the session already
 * open in this tab, scrolls the transcript to that turn instead.
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
          : piSessionsSearch(cwd, agentDir, trimmed, SEARCH_LIMIT).then((r) => {
              if (alive) {
                setHits(r);
                setSessions(null);
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
    const entry = usePiStore.getState().tabs[tabId];
    const sessionId = entry?.state.sessionId ?? null;
    // The current session's file name ends with the id pi reported at
    // agent_start: <timestamp>_<id>.jsonl.
    if (sessionId !== null && hit.path.endsWith(`_${sessionId}.jsonl`)) {
      if (scrollToSnippet(hit.snippet, tabId)) onActivate?.(hit);
      else setError("Matching turn is not available in this session.");
      return;
    }
    const session = entry?.session;
    if (!session) return;
    void session
      .send(JSON.stringify({ type: "switch_session", sessionPath: hit.path }))
      .then(() => {
        if (mounted.current) onActivate?.(hit);
      })
      .catch((e: unknown) => {
        if (mounted.current) setError(errorMessage(e));
      });
  };

  const openSummary = (summary: PiSessionSummary) => {
    openHit({
      path: summary.path,
      startedAt: summary.startedAt,
      role: "user",
      snippet: summary.firstPrompt,
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
          ? groupHits(hits).map(([path, group]) => (
              <div key={path} className="mb-2">
                <div className="sticky top-0 bg-card px-1 py-0.5 text-muted-foreground">
                  {sessionLabel(group[0].startedAt)} {pathLabel(path)}
                </div>
                {group.map((hit, i) => (
                  <button
                    key={`${path}-${i}`}
                    type="button"
                    data-uat="session-row"
                    data-uat-key={`${path}-${i}`}
                    data-uat-index={sessionRowIndex++}
                    onClick={() => openHit(hit)}
                    className="block w-full rounded-md px-1 py-0.5 text-left hover:bg-accent hover:text-foreground"
                  >
                    <span className="me-1.5 rounded border border-border/60 px-1 text-[10px] text-muted-foreground">
                      {hit.role}
                    </span>
                    <span className="text-foreground">{hit.snippet}</span>
                  </button>
                ))}
              </div>
            ))
          : null}
        {hits !== null && hits.length === 0 && query.trim() !== "" ? (
          <p className="px-1 text-muted-foreground">No matches.</p>
        ) : null}
        {sessions !== null
          ? sessions.map((session) => (
              <button
                key={session.path}
                type="button"
                data-uat="session-row"
                data-uat-key={session.path}
                data-uat-index={sessionRowIndex++}
                onClick={() => openSummary(session)}
                className="block w-full rounded-md px-1 py-1 text-left hover:bg-accent hover:text-foreground"
              >
                <span className="block truncate text-foreground">
                  {session.firstPrompt || "(no prompt)"}
                </span>
                <span className="block text-muted-foreground">
                  {sessionLabel(session.startedAt)} - {session.turns} turns -{" "}
                  {session.tokens.toLocaleString()} tok
                </span>
              </button>
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

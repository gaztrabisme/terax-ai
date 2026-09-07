// Prompt library helpers behind the composer slash menu (unit A6). pi ships
// prompt templates as markdown files and expands "/name args" lines itself on
// the rpc path (vendor pi_agent_rust src/rpc.rs prompt handler calls
// ResourceLoader::expand_input), so this module lists the templates and
// mirrors only the line-level rules the menu needs: splitting a typed slash
// line, filtering, completion, and the argument grammar pi applies during
// expansion (docs/prompt-templates.md, src/resources.rs parse_command_args
// and substitute_args).

import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { PiResolvedPaths } from "./providers";

export type PiPromptSource = "agent" | "project";

/** One listed template; Rust twin: PromptEntry in
 *  src-tauri/src/modules/pi/prompts.rs. */
export type PiPromptEntry = {
  name: string;
  description: string;
  path: string;
  source: PiPromptSource;
};

/**
 * Lists the agent dir and project prompt templates for the menu. The agent
 * dir comes from pi_paths (the same runtime resolution the spawn uses), the
 * list itself from pi_prompts_list. Any failure resolves to an empty list:
 * a missing store or dir must never block typing.
 */
export async function loadPrompts(cwd?: string): Promise<PiPromptEntry[]> {
  try {
    const p = usePreferencesStore.getState();
    const paths = await invoke<PiResolvedPaths>("pi_paths", {
      prefs: {
        piBin: "",
        agentBin: p.piAgentBin,
        agentDir: p.piAgentDir,
        launcherDir: p.piLauncherDir,
      },
    });
    const agentDir = paths.runtimeAgentDir.path;
    if (!agentDir) return [];
    const listed = await invoke<PiPromptEntry[]>("pi_prompts_list", {
      agentDir,
      cwd: cwd ?? "",
      workspace: currentWorkspaceEnv(),
    });
    return listed.map((entry) => ({
      ...entry,
      source: entry.source === "project" ? "project" : "agent",
    }));
  } catch {
    return [];
  }
}

/// ---------------------------------------------------------------------------
/// The typed slash line
/// ---------------------------------------------------------------------------

/** A composer line that is still a slash command: "/rev rest of the args". */
export type SlashDraft = {
  /** The token being typed after the slash: the fuzzy filter input. */
  nameToken: string;
  /** Everything after the first whitespace, "" when no args yet. */
  rest: string;
};

/**
 * Parses the composer markdown as a slash line: it must start with "/" and
 * stay on one line (pi's expand_prompt_template only treats a leading slash
 * as a command; a newline would make it a quote or list). Anything else is
 * normal text and returns null.
 */
export function slashDraft(text: string): SlashDraft | null {
  if (!text.startsWith("/") || text.includes("\n")) return null;
  const split = text.slice(1).match(/^(\S*)(\s*[\s\S]*)$/);
  if (!split) return null;
  return { nameToken: split[1], rest: split[2].trimStart() };
}

/**
 * Completes the typed name in place: "/rev src/x" plus "review" becomes
 * "/review src/x". The app sends the line unchanged and pi expands it.
 */
export function completeSlashLine(text: string, name: string): string {
  const draft = slashDraft(text);
  if (!draft) return text;
  const rest = draft.rest.trim();
  return rest ? `/${name} ${rest}` : `/${name}`;
}

/// ---------------------------------------------------------------------------
/// Fuzzy filter (menu list)
/// ---------------------------------------------------------------------------

/**
 * Case-insensitive fuzzy filter over the prompt names: an exact match ranks
 * first, then a prefix, a substring, and finally an in-order subsequence.
 * Ties keep the list order (prompts arrive name-sorted from Rust).
 */
export function filterPrompts(
  prompts: PiPromptEntry[],
  query: string,
): PiPromptEntry[] {
  const q = query.toLowerCase();
  const scored: { prompt: PiPromptEntry; score: number }[] = [];
  for (const prompt of prompts) {
    const name = prompt.name.toLowerCase();
    let score: number | null = null;
    if (name === q) score = 0;
    else if (q && name.startsWith(q)) score = 1;
    else if (q && name.includes(q)) score = 2;
    else if (isSubsequence(q, name)) score = 3;
    if (score !== null) scored.push({ prompt, score });
  }
  // Stable sort by score: Array.prototype.sort is stable, so equal scores
  // keep the Rust list order.
  return scored
    .sort((a, b) => a.score - b.score)
    .map((s) => s.prompt);
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let at = 0;
  for (const ch of haystack) {
    if (ch === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return false;
}

/// ---------------------------------------------------------------------------
/// The placeholder rule (mirror of pi's expansion grammar)
/// ---------------------------------------------------------------------------

/**
 * Splits the args tail the way pi's parse_command_args does: whitespace
 * separates tokens, and single or double quotes group a token only when they
 * open it (an apostrophe inside a word stays literal, so "don't stop" is two
 * args).
 */
export function parseCommandArgs(args: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let justClosedQuote = false;
  for (const ch of args) {
    if (inQuote !== null) {
      if (ch === inQuote) {
        inQuote = null;
        justClosedQuote = true;
      } else {
        current += ch;
      }
      continue;
    }
    if ((ch === '"' || ch === "'") && current === "") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current !== "" || justClosedQuote) {
        out.push(current);
        current = "";
      }
      justClosedQuote = false;
    } else {
      current += ch;
      justClosedQuote = false;
    }
  }
  if (current !== "" || justClosedQuote) out.push(current);
  return out;
}

/**
 * Applies pi's substitute_args grammar to a template body: $1, $2, ... are
 * positional args (missing ones and $0 expand to an empty string), ${@:N}
 * spreads the args from N on (1-based), ${@:N:L} takes L of them, and
 * $ARGUMENTS or $@ become all args joined by spaces.
 */
export function substituteArgs(content: string, args: string[]): string {
  let result = content.replace(/\$(\d+)/g, (_match, digits: string) => {
    const idx = Number.parseInt(digits, 10) || 0;
    return idx === 0 ? "" : (args[idx - 1] ?? "");
  });
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_match, startRaw: string, lenRaw?: string) => {
      let start = Number.parseInt(startRaw, 10) || 1;
      if (start === 0) start = 1;
      const startIdx = start - 1;
      if (lenRaw === undefined) return args.slice(startIdx).join(" ");
      const len = Number.parseInt(lenRaw, 10) || 0;
      return args.slice(startIdx, startIdx + len).join(" ");
    },
  );
  const all = args.join(" ");
  return result.split("$ARGUMENTS").join(all).split("$@").join(all);
}

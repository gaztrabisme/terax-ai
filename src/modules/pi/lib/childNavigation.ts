import { actionTranscriptPath, childAgentId } from "@/modules/pi/lib/runGraph";
import { ledgerPath, type ActionRecord, type LedgerSnapshot } from "@/modules/pi/lib/ledgerStore";

export const CHILD_NAVIGATION_EVENT = "pi:child-navigation";
export const SHOW_USAGE_EVENT = "pi:show-usage";
export type ChildNavigation = { tabId: number; ticketId: string | null };
export type ChildOwner = ChildNavigation & { cwd: string; sessionId: string; delegation: ActionRecord | null };

export function findChildOwner(
  path: string,
  tabs: Record<number, { cwd?: string; state: { sessionId: string | null } }>,
  sessions: Record<string, LedgerSnapshot>,
  recordedOwner?: string,
): ChildOwner | null {
  const matches: ChildOwner[] = [];
  for (const [id, tab] of Object.entries(tabs)) {
    const sessionId = tab.state.sessionId;
    if (!tab.cwd || !sessionId) continue;
    const key = ledgerPath(tab.cwd, sessionId);
    if (recordedOwner && recordedOwner !== key) continue;
    const delegations = Object.values(sessions[key]?.actions ?? {}).filter((action) =>
      action.kind === "delegation" && (actionTranscriptPath(action, tab.cwd) === path ||
        (action.agentId !== null && action.agentId === childAgentId(path))),
    );
    const delegation = delegations.length === 1 ? delegations[0] : null;
    if (!delegation && recordedOwner !== key) continue;
    matches.push({ tabId: Number(id), cwd: tab.cwd, sessionId, delegation, ticketId: delegation?.ticketId ?? null });
  }
  return matches.length === 1 ? matches[0] : null;
}

export function activatePiTab(tabId: number): void {
  // The tab owner is outside pi's edit scope. Radix activates its existing
  // public tab trigger on focus, including when the owner is kept hidden.
  document.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${tabId}"]`)?.focus();
}

export function navigateChild(owner: ChildOwner, openTicket: boolean): void {
  activatePiTab(owner.tabId);
  window.dispatchEvent(new CustomEvent<ChildNavigation>(CHILD_NAVIGATION_EVENT, {
    detail: { tabId: owner.tabId, ticketId: openTicket ? owner.ticketId : null },
  }));
}

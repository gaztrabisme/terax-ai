import { useEffect, useState } from "react";
import { listRecoverableDrafts, type RecoverableDraft } from "@/modules/pi/lib/drafts";

export type DraftRecoveryProps = {
  openDraftIds?: readonly string[];
  onRecoverDraft?: (cwd: string, sid: string) => Promise<void>;
};

export function RecoverableDrafts({ cwd, openDraftIds, onRecoverDraft }: DraftRecoveryProps & { cwd: string }) {
  const [drafts, setDrafts] = useState<RecoverableDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const openKey = JSON.stringify(openDraftIds ?? []);

  useEffect(() => {
    let alive = true;
    setError(null);
    void listRecoverableDrafts(cwd, JSON.parse(openKey) as string[]).then((next) => {
      if (alive) setDrafts(next);
    }).catch((reason) => {
      if (alive) setError(String(reason));
    });
    return () => { alive = false; };
  }, [cwd, openKey]);

  const recover = async (sid: string) => {
    if (!onRecoverDraft) return;
    setPending(sid);
    setError(null);
    try {
      await onRecoverDraft(cwd, sid);
      setDrafts((previous) => previous.filter((draft) => draft.sid !== sid));
    } catch (reason) {
      setError(`${cwd}/.pi/drafts/${sid}.md: ${String(reason)}`);
    } finally {
      setPending(null);
    }
  };

  if (!drafts.length && !error) return null;
  return (
    <div className="shrink-0 border-t border-border/60 px-3 py-1 text-xs">
      {drafts.length > 0 && <p className="text-muted-foreground">Recoverable drafts</p>}
      {drafts.map((draft) => (
        <div key={draft.sid} className="flex items-center gap-2 py-0.5" title={`${cwd}/.pi/drafts/${draft.sid}.md`}>
          <span className="min-w-0 flex-1 truncate">{draft.firstLine}</span>
          <button type="button" data-uat="draft-recover" data-uat-key={draft.sid}
            disabled={pending !== null || !onRecoverDraft} className="shrink-0 underline disabled:opacity-50"
            onClick={() => void recover(draft.sid)}>
            {pending === draft.sid ? "Recovering..." : "Recover"}
          </button>
          {draft.error && <span role="alert" className="text-destructive">Draft recovery failed: {draft.error}</span>}
        </div>
      ))}
      {error && <p role="alert" className="text-destructive">Draft recovery failed: {error}</p>}
    </div>
  );
}

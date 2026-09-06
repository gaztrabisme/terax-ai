import { useState } from "react";

type Props = {
  text: string;
  /** Fork-based re-run; absent until the store grows a fork path. */
  onRerun?: (text: string) => void;
};

export function UserBlock({ text, onRerun }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  return (
    <div className="rounded-md bg-accent/50 px-2 py-1.5">
      <div className="mb-0.5 flex items-center gap-2 text-[10px] font-medium uppercase text-muted-foreground">
        <span>you</span>
        <span className="flex-1" />
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(text);
              }}
              className="rounded px-1 normal-case hover:text-foreground"
            >
              cancel
            </button>
            <button
              type="button"
              disabled={!onRerun}
              title={
                onRerun
                  ? undefined
                  : "Re-run arrives with fork support (later unit)"
              }
              onClick={() => {
                setEditing(false);
                onRerun?.(draft);
              }}
              className="rounded px-1 normal-case hover:text-foreground disabled:opacity-50"
            >
              edit and re-run
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(text);
              setEditing(true);
            }}
            className="rounded px-1 normal-case hover:text-foreground"
          >
            edit
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-16 w-full resize-y rounded border border-border/60 bg-background p-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
      ) : (
        <div className="whitespace-pre-wrap">{text}</div>
      )}
    </div>
  );
}

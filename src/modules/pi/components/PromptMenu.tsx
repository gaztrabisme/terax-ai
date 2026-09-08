import { cn } from "@/lib/utils";
import { filterPrompts, type PiPromptEntry } from "@/modules/pi/lib/prompts";

type Props = {
  /** Every known prompt; the query filters it (fuzzy over the names). */
  prompts: PiPromptEntry[];
  /** The token typed after the slash, "" for a bare "/". */
  query: string;
  /** Highlighted row index into the filtered list; owned by the composer,
   *  which serves Enter and the arrow keys on the editor itself. */
  highlighted: number;
  onHighlight: (index: number) => void;
  onSelect: (prompt: PiPromptEntry) => void;
};

/**
 * The slash command list above the composer: pi's prompt templates with a
 * fuzzy filter, a source badge ("project" beats "agent" on a name collision,
 * mirroring pi's load order), and click or Enter to select. Selecting does
 * not insert the body: pi expands the "/name args" line itself in rpc mode
 * and echoes the expanded body back as the user message.
 */
export function PromptMenu({
  prompts,
  query,
  highlighted,
  onHighlight,
  onSelect,
}: Props) {
  const filtered = filterPrompts(prompts, query);

  return (
    <div
      role="listbox"
      aria-label="Prompt templates"
      data-uat="prompt-menu"
      className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-56 overflow-y-auto rounded-md border border-border/60 bg-popover p-1 shadow-md"
    >
      {filtered.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          No matching prompts
        </div>
      ) : (
        filtered.map((prompt, index) => (
          <button
            key={`${prompt.source}:${prompt.path}`}
            type="button"
            role="option"
            aria-selected={index === highlighted}
            title={prompt.path}
            onMouseEnter={() => onHighlight(index)}
            // onMouseDown so the editor never blurs before the click lands.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(prompt);
            }}
            className={cn(
              "flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-xs",
              index === highlighted
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50",
            )}
          >
            <span className="shrink-0 font-mono">/{prompt.name}</span>
            <span className="truncate text-muted-foreground">
              {prompt.description}
            </span>
            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
              {prompt.source}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

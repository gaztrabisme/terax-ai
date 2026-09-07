import { cn } from "@/lib/utils";
import {
  effectiveQuestionId,
  type PiAskAnswer,
  type PiAskBlock,
} from "@/modules/pi/lib/parse";

type Props = {
  block: PiAskBlock;
  onAnswer: (answers: PiAskAnswer[]) => void;
  onDismiss: () => void;
};

/** Approve = the recommended option per question (falls back to the first). */
export function recommendedAnswers(block: PiAskBlock): PiAskAnswer[] {
  return block.questions.map((q, qi) => {
    const index = q.recommended !== null ? q.recommended : 0;
    return {
      questionId: effectiveQuestionId(q, qi),
      selected: [q.options[index]?.label ?? ""],
    };
  });
}

export function KeystoneCard({ block, onAnswer, onDismiss }: Props) {
  if (block.state !== "pending") {
    return (
      <div className="rounded-md border border-border/60 rounded-md px-2 py-1 text-xs text-muted-foreground">
        ask {block.state}
      </div>
    );
  }
  return (
    <div className="space-y-1.5 rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2">
      {block.questions.map((q, qi) => {
        const questionId = effectiveQuestionId(q, qi);
        return (
          <div key={questionId}>
            <div className="text-xs font-medium">
              {q.header ? `${q.header}: ` : ""}
              {q.question}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {q.options.map((opt, oi) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() =>
                    onAnswer([{ questionId, selected: [opt.label] }])
                  }
                  className={cn(
                    "rounded-md border border-border/60 px-2 py-0.5 hover:bg-accent hover:text-foreground",
                    q.recommended === oi && "border-yellow-500/60 font-medium",
                  )}
                  title={opt.description}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => onAnswer(recommendedAnswers(block))}
          className="rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

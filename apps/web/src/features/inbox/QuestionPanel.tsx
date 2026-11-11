import { useId, useState } from "react";
import { Button, cx, ErrorNote } from "../../ui";
import { useDecide } from "./ApprovalActions";

/**
 * Answer an agent's question, or stop the agent (MESH-006). The answer goes
 * back to the agent, which carries on.
 */
export function QuestionPanel({ approvalId, runId, canAnswer = true, layout = "stack" }: { approvalId: string; runId: string | null; canAnswer?: boolean; layout?: "stack" | "row" }) {
  const decide = useDecide(approvalId, runId);
  const [answer, setAnswer] = useState("");
  const id = useId();
  if (!canAnswer) return <p className="m-0 text-[13px] text-muted">Waiting for someone who can answer in this workspace.</p>;
  return (
    <form
      className={cx("flex gap-2", layout === "stack" ? "flex-col" : "flex-wrap items-center")}
      onSubmit={(e) => {
        e.preventDefault();
        if (answer.trim()) decide.mutate({ decision: "approve", note: answer.trim() }, { onSuccess: () => setAnswer("") });
      }}
    >
      <label htmlFor={id} className="sr-only">
        Your answer
      </label>
      <textarea
        id={id}
        rows={layout === "stack" ? 3 : 1}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Your answer…"
        className={cx("min-w-0 rounded-[9px] border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-muted", layout === "row" && "min-w-[240px] flex-1")}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!answer.trim() || decide.isPending}>
          Send answer
        </Button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => {
            if (confirm("Stop the agent instead of answering? The step fails.")) decide.mutate({ decision: "reject" });
          }}
          className="text-[13px] font-semibold text-bad hover:underline"
        >
          Stop the agent
        </button>
      </div>
      <ErrorNote error={decide.error} />
    </form>
  );
}

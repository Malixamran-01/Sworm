import type { RunDetailDto } from "@conclave/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { Button, cx, ErrorNote } from "../../ui";

export function useDecide(approvalId: string, runId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ decision, note }: { decision: "approve" | "reject" | "changes"; note?: string }) => api.decide(approvalId, decision, note),
    onSuccess: (run: RunDetailDto) => {
      qc.setQueryData(["task", run.id], run);
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      if (runId) void qc.invalidateQueries({ queryKey: ["task", runId] });
    },
  });
}

/**
 * Approve, or ask for changes in plain words (TASK-004). Only the steps the
 * change affects re-run. Works without opening the task (NOTE-002).
 */
export function ApprovalPanel({ approvalId, runId, layout = "stack", canDecide = true }: { approvalId: string; runId: string | null; layout?: "stack" | "row"; canDecide?: boolean }) {
  const decide = useDecide(approvalId, runId);
  const [note, setNote] = useState("");
  if (!canDecide) return <p className="m-0 text-[13px] text-muted">Waiting for someone who can approve in this workspace.</p>;
  const send = () => {
    if (note.trim()) decide.mutate({ decision: "changes", note: note.trim() }, { onSuccess: () => setNote("") });
  };

  return (
    <div className={cx("flex gap-2", layout === "stack" ? "flex-col" : "flex-wrap items-center")}>
      <Button variant="success" size={layout === "stack" ? "lg" : "md"} disabled={decide.isPending} onClick={() => decide.mutate({ decision: "approve" })} className={layout === "stack" ? "w-full" : ""}>
        Approve
      </Button>
      <form
        className={cx("flex gap-2", layout === "row" && "min-w-[240px] flex-1")}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor={`changes-${approvalId}`}>
          Ask for changes
        </label>
        <input
          id={`changes-${approvalId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Ask for changes…"
          className="h-[38px] min-w-0 flex-1 rounded-[9px] border border-line-strong bg-surface px-3 text-[13px] text-ink placeholder:text-muted"
        />
        {note.trim() ? (
          <Button type="submit" variant="secondary" disabled={decide.isPending} className="!h-[38px]">
            Send
          </Button>
        ) : null}
      </form>
      <button
        type="button"
        disabled={decide.isPending}
        onClick={() => {
          if (confirm("Reject this result? The task will stop.")) decide.mutate({ decision: "reject" });
        }}
        className={cx("self-start text-[13px] font-semibold text-bad hover:underline", layout === "row" && "self-center")}
      >
        Reject
      </button>
      <ErrorNote error={decide.error} />
    </div>
  );
}

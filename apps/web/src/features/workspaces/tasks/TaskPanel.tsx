import { topics, type RunDetailDto, type StepDto } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../../lib/api";
import { clock, money, stepLabel } from "../../../lib/format";
import { useDelta, useTopics } from "../../../lib/realtime";
import { useWorkspaceCan } from "../../../lib/auth";
import { useWorkspace } from "../WorkspaceLayout";
import { Button, cx, ErrorNote, StatusPill } from "../../../ui";
import { CheckIcon, ChevronIcon, CloseIcon } from "../../../ui/icons";
import { ApprovalPanel } from "../../inbox/ApprovalActions";

function StepMarker({ step, n }: { step: StepDto; n: number }) {
  const base = "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-xs font-bold";
  if (step.status === "succeeded") return <span className={cx(base, "bg-good-soft text-good")} aria-label="Done"><CheckIcon /></span>;
  if (step.status === "failed") return <span className={cx(base, "bg-bad-soft text-bad")} aria-label="Failed"><CloseIcon /></span>;
  if (step.status === "running") return <span className={cx(base, "pulse bg-accent-tint text-accent-ink")} aria-label="Running">{n}</span>;
  if (step.status === "skipped") return <span className={cx(base, "border border-dashed border-line-dashed text-muted")} aria-label="Skipped">–</span>;
  if (step.status === "not_taken") return <span className={cx(base, "border border-dashed border-line-dashed text-muted")} aria-label="Not taken, another way was">⤳</span>;
  if (step.status === "waiting") return <span className={cx(base, "bg-warn-line text-[#4a3000]")} aria-label="Waiting for you">{n}</span>;
  return <span className={cx(base, "bg-line-soft text-muted")}>{n}</span>;
}

function StepRow({ run, step, n }: { run: RunDetailDto; step: StepDto; n: number }) {
  const live = useDelta(run.id, step.key);
  const [open, setOpen] = useState(step.status === "running");
  const text = step.status === "running" ? live : step.output;
  const role = step.nodeLabel?.split(" · ")[0];
  const node = step.nodeLabel?.split(" · ").slice(1).join(" · ");
  const highlight = step.status === "waiting" || step.status === "running";

  return (
    <li className={cx(highlight && "-mx-2.5 rounded-lg bg-warn-row px-2.5", step.status === "running" && "!bg-selected")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!text && !step.error}
        className="flex w-full items-center gap-2.5 py-2 text-left disabled:cursor-default"
      >
        <StepMarker step={step} n={n} />
        <span className="min-w-0 flex-1 text-[13px]">
          <strong>{step.kind === "approval" ? "Review" : stepLabel(step.key)}</strong>
          <span className="text-muted">
            {step.kind === "approval" ? " · you" : role ? ` · ${role}${node ? ` (${node})` : ""}` : ""}
            {step.round > 1 ? ` · round ${step.round}` : ""}
            {step.attempt > 1 && step.round <= 1 ? ` · attempt ${step.attempt}` : ""}
          </span>
        </span>
        <span className="text-xs text-muted">{step.status === "not_taken" ? "not taken" : step.status === "skipped" ? "skipped" : step.kind !== "approval" && step.status === "succeeded" ? money(step.costUsd) : step.kind === "approval" ? "" : "—"}</span>
        {text || step.error ? <ChevronIcon open={open} /> : <span className="w-3.5" />}
      </button>
      {step.children?.length ? (
        // Sub-tasks a workspace step started (WF-008); each opens in its own workspace.
        <ul className="m-0 mb-2 ml-8 flex list-none flex-col gap-1 p-0" aria-label={`Sub-tasks of ${stepLabel(step.key)}`}>
          {step.children.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-[13px]">
              <Link to={`/workspaces/${c.workspaceId}/tasks/${c.id}`} className="min-w-0 flex-1 truncate">
                {c.title}
              </Link>
              <span className="text-xs text-muted">{c.workspaceName}</span>
              <StatusPill status={c.status} />
            </li>
          ))}
        </ul>
      ) : null}
      {open && step.error ? <p className="m-0 mb-2 ml-8 text-[13px] text-bad">{step.error}</p> : null}
      {open && text ? (
        <div className="output-text mb-2 ml-8 max-h-80 overflow-y-auto rounded-[10px] border border-line-soft bg-surface p-3">
          {text}
          {step.kind === "role" && step.status === "succeeded" ? (
            <p className="m-0 mt-2 border-t border-line-soft pt-2 text-xs text-muted">
              {step.inputTokens.toLocaleString()} in · {step.outputTokens.toLocaleString()} out · {money(step.costUsd)} {step.costSource}
              {step.latencyMs ? ` · ${(step.latencyMs / 1000).toFixed(1)} s` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The selected-task panel from the Tasks mockup: header, the approval box, steps, and the task limit. */
export function TaskPanel({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const { ws } = useWorkspace();
  const canDecide = useWorkspaceCan(ws.data, "approval:decide");
  const canRun = useWorkspaceCan(ws.data, "task:run");
  const task = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId) });
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: api.inbox });
  useTopics([topics.run(taskId)]);
  const cancel = useMutation({ mutationFn: () => api.cancelTask(taskId), onSuccess: (run) => qc.setQueryData(["task", run.id], run) });

  if (task.isLoading) return <p className="text-muted">Loading…</p>;
  if (task.error || !task.data) return <ErrorNote error={task.error ?? new Error("Task not found.")} />;
  const run = task.data;
  const approvalId = inbox.data?.find((i) => i.runId === run.id && i.kind === "approval" && !i.resolved)?.approvalId ?? null;
  const waitingStep = run.steps.find((s) => s.status === "waiting");
  const active = ["queued", "running", "waiting"].includes(run.status);
  // Show the live attempt of each step; revised ones collapse behind it.
  const latest = new Map<string, StepDto>();
  for (const s of run.steps) if (s.status !== "superseded") latest.set(s.key, s);
  const revised = run.steps.filter((s) => s.status === "superseded").length;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-start gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs text-muted">
            {run.taskTypeName} · started {clock(run.createdAt)}
            {run.parent ? (
              <>
                {" "}
                by a step of{" "}
                <Link to={`/workspaces/${run.parent.workspaceId}/tasks/${run.parent.id}`} className="font-semibold">
                  {run.parent.title}
                </Link>
              </>
            ) : null}
          </span>
          <h2 className="m-0 text-[19px] font-bold">{run.title}</h2>
        </div>
        <StatusPill status={run.status} />
      </div>

      {run.error && run.status === "failed" ? <ErrorNote error={new Error(run.error)} /> : null}

      {waitingStep && approvalId ? (
        <div className="flex flex-col gap-3 rounded-xl border border-warn-line bg-warn-row p-3.5">
          <span className="text-[13px] font-semibold text-warn-ink">Ready for your review</span>
          {waitingStep.output ? <div className="output-text max-h-60 overflow-y-auto rounded-[10px] bg-surface p-3">{waitingStep.output}</div> : null}
          <ApprovalPanel approvalId={approvalId} runId={run.id} canDecide={canDecide} />
        </div>
      ) : null}

      {run.status === "succeeded" && run.output ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="m-0 text-sm font-semibold">Result</h3>
            <button type="button" className="text-xs font-semibold text-accent-ink hover:underline" onClick={() => void navigator.clipboard.writeText(run.output ?? "")}>
              Copy
            </button>
          </div>
          <div className="output-text max-h-72 overflow-y-auto rounded-[10px] border border-line p-3">{run.output}</div>
        </div>
      ) : null}

      <h3 className="m-0 mt-1 text-sm font-semibold">Steps</h3>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {[...latest.values()].map((s, i) => (
          <StepRow key={s.id} run={run} step={s} n={i + 1} />
        ))}
        {run.steps.length === 0 ? <li className="py-2 text-[13px] text-muted">Starting…</li> : null}
      </ol>
      {revised > 0 ? <p className="m-0 text-xs text-muted">{revised} earlier version{revised === 1 ? "" : "s"} replaced, by a loop round or your feedback.</p> : null}

      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        {Object.entries(run.brief).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted capitalize">{k}</dt>
            <dd className="m-0 text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-auto flex items-center justify-between border-t border-line-soft pt-3 text-[13px] text-muted">
        <span>
          {money(run.costUsd)} of {money(run.budgetUsd)} task limit
        </span>
        {active && canRun ? (
          <Button variant="ghost" size="sm" className="!text-bad" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel task
          </Button>
        ) : null}
      </div>
    </div>
  );
}

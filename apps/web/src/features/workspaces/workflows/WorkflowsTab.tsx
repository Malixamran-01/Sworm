import type { Step, WorkspaceDetailDto } from "@conclave/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../../../lib/api";
import { useWorkspaceCan } from "../../../lib/auth";
import { Card, cx, Pill } from "../../../ui";
import { useWorkspace } from "../WorkspaceLayout";
import { KIND_LOOK } from "./editor/graph";

const label = (s: Step) => (s.kind === "approval" ? s.title : s.key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));

/** Each task type's workflow, step by step. Open one in the node editor to change it (WF-007). */
export function WorkflowsTab() {
  const { ws } = useWorkspace();
  const editable = useWorkspaceCan(ws.data, "workspace:edit");
  const targets = useQuery({ queryKey: ["call-targets"], queryFn: api.callTargets });
  if (!ws.data) return null;
  const w = ws.data;
  const roleName = (key: string) => w.roles.find((r) => r.key === key)?.name ?? key;

  const detail = (s: Step, ttKey: string): string => {
    if (s.kind === "approval") return s.revises.length ? `Approve, or ask for changes and only ${s.revises.join(", ")} re-runs.` : "Approve or reject.";
    if (s.kind === "tool") return `Calls the tool chosen for ${roleName(s.role)} with ${Object.keys(s.args).join(", ") || "no arguments"}${s.optional ? " · skipped when no tool is connected" : ""}`;
    if (s.kind === "workspace") return describeCall(w, s, ttKey, targets.data);
    if (s.kind === "branch") return `Takes the ${s.mode === "all" ? "matching cases" : "first matching case"} of ${s.cases.map((c) => c.label).join(", ")}, else Else.`;
    if (s.kind === "classify") return `${roleName(s.role)} sorts it into ${s.categories.map((c) => c.label).join(", ")}${s.other ? " or Other" : ""}.`;
    if (s.kind === "merge") return s.mode === "first" ? "Passes on whichever branch ran." : s.mode === "concat" ? "Joins every input." : "Collects every input as JSON.";
    if (s.kind === "text") return "Writes text from a template. No model, no cost.";
    if (s.kind === "stop") return s.outcome === "succeed" ? "Ends the task as done." : "Ends the task as failed.";
    return `Up to ${s.maxTokens.toLocaleString()} output tokens · retries on outages · times out after ${Math.round(s.timeoutMs / 60000)} min`;
  };

  return (
    <main className="flex flex-col gap-4 px-4 py-5 md:px-8 md:py-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 min-w-[240px] flex-1 text-sm text-muted">
          Each task type runs one workflow. Steps call roles, so changing a model in Team never breaks a workflow. A step can also run another workspace, or this one again.
        </p>
        {editable ? (
          <Link to={`/workspaces/${w.id}/workflows/new`} className="inline-flex h-9 items-center rounded-[9px] bg-accent px-3.5 text-[13px] font-semibold text-on-accent no-underline hover:brightness-110">
            New task type
          </Link>
        ) : null}
      </div>
      {w.taskTypes.map((tt) => (
        <Card as="section" key={tt.id} className="flex flex-col gap-4 rounded-2xl p-5">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 className="m-0 text-base font-semibold">{tt.name}</h2>
              <span className="text-[13px] text-muted">{tt.description}</span>
            </div>
            {editable ? (
              <Link
                to={`/workspaces/${w.id}/workflows/${tt.key}`}
                aria-label={`Open editor for ${tt.name}`}
                className="inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink no-underline hover:bg-sunken"
              >
                Open editor
              </Link>
            ) : null}
          </div>
          <ol className="m-0 flex list-none flex-col gap-0 p-0">
            {tt.steps.map((s, i) => (
              <li key={s.key} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={cx(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                      s.kind === "approval" ? "bg-warn-soft text-warn-ink" : s.kind === "tool" ? "bg-line-soft text-ink-2" : s.kind === "workspace" ? "bg-line-soft text-ink" : "bg-accent-tint text-accent-ink",
                    )}
                  >
                    {i + 1}
                  </span>
                  {i < tt.steps.length - 1 ? <span className="w-px flex-1 bg-line" aria-hidden /> : null}
                </div>
                <div className="flex flex-1 flex-col gap-1 pb-4">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {label(s)}
                    {s.kind === "approval" ? <Pill tone="warn">Asks you</Pill> : s.kind === "workspace" ? <Pill>{KIND_LOOK.workspace.label}</Pill> : "role" in s ? <Pill tone="accent">{roleName(s.role)}</Pill> : <Pill>{KIND_LOOK[s.kind].label}</Pill>}
                    {s.kind === "tool" ? <Pill>tool</Pill> : null}
                    {s.optional ? <Pill>optional</Pill> : null}
                    {s.needs && s.needs.length > 1 ? <Pill>after {s.needs.map((n) => (typeof n === "string" ? n : n.step)).join(" + ")}</Pill> : null}
                    {s.needs?.some((n) => typeof n !== "string" && n.type !== "always") ? <Pill tone="warn">conditional</Pill> : null}
                    {s.disabled ? <Pill>off</Pill> : null}
                    {s.loop ? <Pill tone="accent">↻ back to {s.loop.to}, up to {s.loop.max}×</Pill> : null}
                  </span>
                  <span className="text-[13px] text-muted">{detail(s, tt.key)}</span>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </main>
  );
}

function describeCall(w: WorkspaceDetailDto, s: Extract<Step, { kind: "workspace" }>, ttKey: string, targets: { workspaceId: string; workspaceName: string; taskTypes: { key: string; name: string }[] }[] | undefined): string {
  const self = s.workspace === "self" || s.workspace === w.id;
  const target = targets?.find((t) => t.workspaceId === (self ? w.id : s.workspace));
  const what = self && s.taskType === ttKey ? "this same workflow" : (target?.taskTypes.find((t) => t.key === s.taskType)?.name ?? s.taskType);
  const where = self ? "" : ` in ${target?.workspaceName ?? "another workspace"}`;
  const times =
    s.repeat?.mode === "times"
      ? `, ${s.repeat.count} times`
      : s.repeat?.mode === "each"
        ? ", once for each item of a list"
        : s.repeat?.mode === "until"
          ? `, again and again until the output says "${s.repeat.stopWhen}" (at most ${s.repeat.max})`
          : "";
  return `Runs ${what}${where}${s.until ? ` up to ${s.until}` : ""}${times}, then carries on with its output.`;
}

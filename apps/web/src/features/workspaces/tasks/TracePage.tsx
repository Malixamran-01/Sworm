import type { SpanSystem, TraceDto, TraceSpanDto } from "@conclave/contract";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";
import { duration, money, plural } from "../../../lib/format";
import { moduleLook } from "../../../lib/palette";
import { Card, cx, Empty, ErrorNote, SectionTitle, StatusPill, Tile } from "../../../ui";
import { ChevronIcon } from "../../../ui/icons";

/** One colour per kind of system, in a fixed order; tasks and logic are neutral, not a series. */
const SYSTEMS: { key: SpanSystem; label: string; color: string }[] = [
  { key: "model", label: "Models", color: "var(--series-1)" },
  { key: "tool", label: "Tools", color: "var(--series-2)" },
  { key: "agent", label: "Agents", color: "var(--series-3)" },
  { key: "workflow", label: "Workflow engines", color: "var(--series-4)" },
  { key: "knowledge", label: "Knowledge", color: "var(--series-6)" },
  { key: "person", label: "People", color: "var(--series-5)" },
];
const colorOf = (s: SpanSystem) => SYSTEMS.find((x) => x.key === s)?.color ?? "var(--series-none)";
const KIND_LABEL: Record<SpanSystem, string> = { model: "Model", tool: "Tool", agent: "Agent", workflow: "Workflow engine", knowledge: "Knowledge", person: "Person", workspace: "Sub-task", logic: "Logic" };
const QUIET = new Set(["not_taken", "skipped", "pending"]);
const ACTIVE = new Set(["queued", "running", "waiting"]);

interface Row {
  span: TraceSpanDto;
  level: number;
}

/** Depth-first rows: each task, its steps in order, and under a step the sub-tasks it started. */
function rowsOf(trace: TraceDto, showQuiet: boolean): Row[] {
  const children = new Map<string | null, TraceSpanDto[]>();
  for (const s of trace.spans) {
    const list = children.get(s.parentId) ?? [];
    list.push(s);
    children.set(s.parentId, list);
  }
  const out: Row[] = [];
  const walk = (span: TraceSpanDto, level: number) => {
    if (span.type === "step" && !showQuiet && QUIET.has(span.status)) return;
    out.push({ span, level });
    const kids = [...(children.get(span.id) ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attempt - b.attempt);
    for (const k of kids) walk(k, level + 1);
  };
  for (const root of children.get(null) ?? []) walk(root, 0);
  return out;
}

const ms = (iso: string) => new Date(iso).getTime();

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="flex min-w-[130px] flex-1 flex-col gap-0.5 px-4 py-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-lg font-bold tabular-nums">{value}</span>
      {sub ? <span className="text-xs text-muted">{sub}</span> : null}
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ink-2">{children}</dd>
    </div>
  );
}

function SpanDetail({ span, trace }: { span: TraceSpanDto; trace: TraceDto }) {
  const elsewhere = span.type === "run" && span.id !== trace.focusRunId && !span.hidden;
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-line-soft bg-surface-2 px-4 py-3 text-[13px] sm:grid-cols-[140px_1fr]">
      {span.hidden ? <Detail label="Details">In someone's personal workspace, so its details are left out.</Detail> : null}
      {span.type === "run" ? <Detail label="Workspace">{span.workspaceName}</Detail> : null}
      {span.node?.label ? <Detail label="Done by">{span.node.label}</Detail> : null}
      {span.node?.connectionName ? (
        <Detail label="Connection">
          {span.node.connectionName}
          {span.node.moduleId ? <span className="text-muted"> · {span.node.moduleId}</span> : null}
        </Detail>
      ) : null}
      {span.attempt > 1 || span.round > 1 ? (
        <Detail label="Try">
          {span.round > 1 ? `Round ${span.round}` : `Attempt ${span.attempt}`}
          {span.status === "superseded" ? ", replaced by a later one" : ""}
        </Detail>
      ) : null}
      {span.iteration > 1 ? <Detail label="Repeat">Run {span.iteration}</Detail> : null}
      {span.type === "step" && span.system !== "person" && span.system !== "logic" ? (
        <Detail label="Cost">
          {money(span.costUsd)}
          {span.costSource ? <span className="text-muted"> · {span.costSource}</span> : null}
          {span.system === "workspace" ? <span className="text-muted"> · all spent by its sub-tasks</span> : null}
        </Detail>
      ) : null}
      {span.type === "run" ? <Detail label="Cost">{money(span.costUsd)}, sub-tasks included</Detail> : null}
      {span.reservedUsd > 0 ? (
        <Detail label="Budget hold">
          {money(span.reservedUsd)} held before it started
          {span.heldUsd > 0 ? `, ${money(span.heldUsd)} still held` : ", released when it ended"}
        </Detail>
      ) : null}
      {span.inputTokens + span.outputTokens > 0 ? (
        <Detail label="Tokens">
          {span.inputTokens.toLocaleString()} in · {span.outputTokens.toLocaleString()} out
        </Detail>
      ) : null}
      {span.policy && (!span.policy.allowed || span.policy.effect !== "allow" || span.policy.source) ? (
        <Detail label="Rules">
          <span className={span.policy.allowed ? "" : "font-semibold text-bad"}>{span.policy.allowed ? "Allowed. " : "Refused. "}</span>
          {span.policy.reason}
        </Detail>
      ) : null}
      {span.decision ? (
        <Detail label="Decision">
          {span.decision.decision ? (
            <>
              {span.decision.decision === "approve" ? "Approved" : span.decision.decision === "reject" ? "Rejected" : "Changes asked"}
              {span.decision.by ? ` by ${span.decision.by}` : ""}
              {span.decision.at ? `, ${new Date(span.decision.at).toLocaleString()}` : ""}
              {span.decision.note ? <span className="block text-muted">“{span.decision.note}”</span> : null}
            </>
          ) : (
            "Waiting for a person"
          )}
        </Detail>
      ) : null}
      {span.error ? (
        <Detail label="Error">
          <span className="text-bad">{span.error}</span>
          {span.errorCode ? <span className="text-muted"> ({span.errorCode})</span> : null}
        </Detail>
      ) : null}
      {span.externalId ? (
        <Detail label="Outside id">
          <code className="font-mono text-xs">{span.externalId}</code>
        </Detail>
      ) : null}
      {span.traceparent ? (
        <Detail label="traceparent">
          <code className="font-mono text-xs">{span.traceparent}</code>
          <span className="block text-xs text-muted">Sent with the call, so the outside system's own logs can be matched to this step.</span>
        </Detail>
      ) : null}
      <Detail label="Started">{new Date(span.startedAt).toLocaleString()}</Detail>
      {elsewhere ? (
        <Detail label="Task">
          <Link to={`/workspaces/${span.workspaceId}/tasks/${span.id}`} className="font-semibold">
            Open this task
          </Link>
        </Detail>
      ) : null}
    </dl>
  );
}

/** One task tree on one timeline: who did what, in which system, for how long and how much. */
export function TracePage() {
  const { workspaceId, taskId } = useParams({ strict: false }) as { workspaceId: string; taskId: string };
  const [showQuiet, setShowQuiet] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const query = useQuery({
    queryKey: ["trace", taskId],
    queryFn: () => api.trace(taskId),
    // A live task keeps moving; a finished one does not change.
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.status) ? 2_500 : false),
  });
  const trace = query.data;
  const live = !!trace && ACTIVE.has(trace.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [live]);

  const rows = useMemo(() => (trace ? rowsOf(trace, showQuiet) : []), [trace, showQuiet]);

  if (query.isLoading) return <p className="px-8 py-6 text-muted">Loading…</p>;
  if (query.error || !trace) {
    return (
      <div className="px-4 py-5 md:px-8">
        <ErrorNote error={query.error ?? new Error("Trace not found.")} />
      </div>
    );
  }

  const t0 = ms(trace.startedAt);
  const t1 = Math.max(t0 + 1, trace.finishedAt ? ms(trace.finishedAt) : now);
  const total = t1 - t0;
  const endOf = (s: TraceSpanDto) => (s.finishedAt ? ms(s.finishedAt) : now);
  const lengthOf = (s: TraceSpanDto) => Math.max(0, endOf(s) - ms(s.startedAt));

  // Where the time went, by kind of system. Steps only: tasks would count their steps twice.
  const busy = SYSTEMS.map((sys) => ({
    ...sys,
    ms: trace.spans.filter((s) => s.type === "step" && s.system === sys.key && !QUIET.has(s.status)).reduce((n, s) => n + lengthOf(s), 0),
  })).filter((b) => b.ms > 0);
  const busyTotal = busy.reduce((n, b) => n + b.ms, 0);
  const quietCount = trace.spans.filter((s) => s.type === "step" && QUIET.has(s.status)).length;
  const focus = trace.spans.find((s) => s.id === trace.focusRunId);

  return (
    <main className="flex flex-col gap-5 px-4 py-5 md:px-8 md:py-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Link to={`/workspaces/${workspaceId}/tasks/${taskId}`} className="text-[13px] text-muted no-underline hover:text-ink">
            ← Back to the task
          </Link>
          <h2 className="m-0 text-[19px] font-bold">Trace of {trace.title}</h2>
          <p className="m-0 text-[13px] text-muted">
            Everything this task set in motion, on one timeline: {plural(trace.counts.tasks, "task")} in {plural(trace.counts.workspaces, "workspace")},{" "}
            {plural(trace.systems.length, "connected system")}.
            {focus && trace.focusRunId !== trace.rootRunId ? ` You opened it from the sub-task “${focus.name}”.` : ""}
          </p>
        </div>
        <StatusPill status={trace.status} />
      </header>

      <div className="flex flex-wrap gap-3">
        <Stat label={live ? "Running for" : "Took"} value={duration(total)} sub={`started ${new Date(trace.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`} />
        <Stat label="Cost" value={money(trace.costUsd)} sub={`of ${money(trace.budgetUsd)} task limit`} />
        <Stat label="Calls to systems" value={String(trace.counts.calls)} sub={trace.counts.retries ? `${plural(trace.counts.retries, "retry", "retries")}` : "no retries"} />
        <Stat label="Failures" value={String(trace.counts.failures)} sub={trace.counts.failures ? "open a red row for the reason" : "none"} />
        <Stat label="Decisions by people" value={String(trace.counts.decisions)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card as="section" className="flex flex-col gap-3 p-4">
          <SectionTitle>Where the time went</SectionTitle>
          {busy.length ? (
            <>
              <div className="flex h-3 gap-0.5 overflow-hidden rounded-full" aria-hidden>
                {busy.map((b) => (
                  <span key={b.key} style={{ width: `${(b.ms / busyTotal) * 100}%`, background: b.color, minWidth: 3 }} />
                ))}
              </div>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                {busy.map((b) => (
                  <li key={b.key} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: b.color }} aria-hidden />
                    <span className="flex-1">{b.key === "person" ? "Waiting for people" : b.label}</span>
                    <span className="text-muted tabular-nums">{Math.round((b.ms / busyTotal) * 100)}%</span>
                    <span className="w-24 text-right tabular-nums">{duration(b.ms)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="m-0 text-[13px] text-muted">Nothing has run yet.</p>
          )}
        </Card>

        <Card as="section" className="flex flex-col gap-3 p-4">
          <SectionTitle count={trace.systems.length}>Systems it reached</SectionTitle>
          {trace.systems.length ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {trace.systems.map((s) => {
                const look = moduleLook(s.moduleId, s.connectionName);
                return (
                  <li key={s.connectionId} className="flex items-center gap-2.5 text-[13px]">
                    <Tile text={look.short} palette={look.palette} size={30} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-semibold">{s.connectionName}</span>
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: colorOf(s.system) }} aria-hidden />
                        {KIND_LABEL[s.system]} · {plural(s.calls, "call")}
                        {s.failures ? <span className="font-semibold text-bad"> · {s.failures} failed</span> : null}
                      </span>
                    </span>
                    <span className="text-right tabular-nums">
                      {money(s.costUsd)}
                      <span className="block text-xs text-muted">{duration(s.busyMs)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-[13px] text-muted">No outside system has been called yet.</p>
          )}
        </Card>
      </div>

      <section className="flex flex-col gap-3" aria-label="Timeline">
        <div className="flex flex-wrap items-center gap-3">
          <SectionTitle>Timeline</SectionTitle>
          <span className="flex-1" />
          {quietCount > 0 ? (
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <input type="checkbox" checked={showQuiet} onChange={(e) => setShowQuiet(e.target.checked)} />
              Show {plural(quietCount, "step")} that did not run
            </label>
          ) : null}
          <button
            type="button"
            className="text-xs font-semibold text-accent-ink hover:underline"
            onClick={() => {
              void navigator.clipboard.writeText(trace.traceId);
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            }}
            title="The trace id every outside call of this task carries"
          >
            {copied ? "Copied" : "Copy trace id"}
          </button>
        </div>

        {rows.length ? (
          <Card className="overflow-hidden">
            <div className="hidden items-center gap-3 border-b border-line-soft bg-surface-2 px-4 py-2 text-xs font-semibold text-muted sm:flex">
              <span className="w-[42%] shrink-0 lg:w-[36%]">Step</span>
              <span className="flex flex-1 justify-between font-normal tabular-nums">
                <span>0</span>
                <span>{duration(total / 2)}</span>
                <span>{duration(total)}</span>
              </span>
              <span className="w-[68px] shrink-0 text-right">Cost</span>
            </div>
            <ol className="m-0 list-none p-0">
              {rows.map(({ span, level }) => {
                const start = ms(span.startedAt);
                const len = lengthOf(span);
                const left = Math.min(99.5, Math.max(0, ((start - t0) / total) * 100));
                const width = Math.max(0.6, Math.min(100 - left, (len / total) * 100));
                const isRun = span.type === "run";
                const quiet = QUIET.has(span.status) || span.status === "superseded";
                const running = ACTIVE.has(span.status) || (span.status === "waiting" && !span.finishedAt);
                const expanded = open === span.id;
                const who = span.node?.connectionName ?? (span.system === "person" ? (span.decision?.by ?? "you") : null);
                return (
                  <li key={span.id} className={cx("border-t border-line-soft first:border-t-0", span.id === trace.focusRunId && trace.focusRunId !== trace.rootRunId && "bg-selected-2")}>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : span.id)}
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-surface-2 sm:flex-nowrap"
                    >
                      <span className="flex w-full min-w-0 items-center gap-2 sm:w-[42%] sm:shrink-0 lg:w-[36%]" style={{ paddingLeft: Math.min(level, 8) * 14 }}>
                        <span
                          className={cx("h-2.5 w-2.5 shrink-0", isRun ? "rounded-full border-2 border-line-dashed" : "rounded-sm")}
                          style={isRun ? undefined : { background: colorOf(span.system) }}
                          aria-hidden
                        />
                        <span className={cx("min-w-0 truncate text-[13px]", isRun ? "font-bold" : "font-semibold", quiet && "font-normal text-muted")}>
                          {span.name}
                          <span className="font-normal text-muted">
                            {isRun ? ` · ${span.workspaceName}` : who ? ` · ${who}` : ""}
                            {span.attempt > 1 && span.round <= 1 ? ` · attempt ${span.attempt}` : ""}
                            {span.round > 1 ? ` · round ${span.round}` : ""}
                            {span.iteration > 1 ? ` · run ${span.iteration}` : ""}
                          </span>
                        </span>
                        {span.status === "failed" ? <StatusPill status="failed" /> : null}
                        {span.status === "cancelled" ? <StatusPill status="cancelled" /> : null}
                        {span.status === "waiting" && span.system === "person" ? <StatusPill status="waiting" /> : null}
                      </span>
                      <span className="relative h-5 min-w-[120px] flex-1" aria-hidden>
                        <span className="absolute inset-y-[9px] right-0 left-0 rounded bg-line-soft" />
                        {QUIET.has(span.status) ? null : (
                          <span
                            className={cx("absolute rounded", isRun ? "top-[7px] h-1.5" : "top-1 h-3", running && "pulse", span.status === "superseded" && "opacity-40")}
                            style={{
                              left: `${left}%`,
                              width: `${width}%`,
                              minWidth: 3,
                              background: span.status === "failed" ? "var(--bad)" : isRun ? "var(--line-dashed)" : colorOf(span.system),
                            }}
                          />
                        )}
                      </span>
                      <span className="flex w-auto shrink-0 items-center gap-2 text-xs text-muted tabular-nums sm:w-[68px] sm:flex-col sm:items-end sm:gap-0">
                        <span className="text-ink-2">{QUIET.has(span.status) ? (span.status === "not_taken" ? "not taken" : span.status) : duration(len)}</span>
                        <span>{span.system === "person" || span.system === "logic" || QUIET.has(span.status) ? "" : money(span.costUsd)}</span>
                      </span>
                      <ChevronIcon open={expanded} />
                    </button>
                    {expanded ? <SpanDetail span={span} trace={trace} /> : null}
                  </li>
                );
              })}
            </ol>
          </Card>
        ) : (
          <Empty title="Nothing has run yet">Steps appear here as the task starts them.</Empty>
        )}
        <p className="m-0 text-xs text-muted">
          Bars show when each step ran within the task. A thin grey bar is a task or sub-task; steps under it are its own. Select a row for the node, budget hold, decision and
          error behind it.
        </p>
      </section>
    </main>
  );
}

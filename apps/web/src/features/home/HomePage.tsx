import type { InboxItemDto, RunSummaryDto, WorkspaceDto } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, cleanBrief } from "../../lib/api";
import { greeting, money, plural, stepLabel } from "../../lib/format";
import { initials, paletteFor } from "../../lib/palette";
import { Button, Card, cx, ErrorNote, SectionTitle, Tile } from "../../ui";
import { useDecide } from "../inbox/ApprovalActions";

function Onboarding({ hasConnection, hasWorkspace }: { hasConnection: boolean; hasWorkspace: boolean }) {
  const steps = [
    { done: hasConnection, title: "Connect a model", body: "An Anthropic key, any OpenAI-compatible server, or the free mock model.", to: "/connections", cta: "Add a connection" },
    { done: hasWorkspace, title: "Create a workspace", body: "Start from the Research Brief template: a researcher, an editor, and you approving.", to: "/workspaces/new", cta: "Create a workspace" },
    { done: false, title: "Run a task and approve it", body: "Write a brief, check the estimate, run it, then approve the draft.", to: "", cta: "" },
  ];
  return (
    <Card as="section" className="flex flex-col gap-4 rounded-2xl p-5">
      <SectionTitle>Get to your first result</SectionTitle>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {steps.map((s, i) => (
          <li key={s.title} className="flex items-center gap-3">
            <span
              className={cx("flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-xs font-bold", s.done ? "bg-good-soft text-good" : "bg-line-soft text-muted")}
              aria-hidden
            >
              {s.done ? "✓" : i + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cx("text-sm font-semibold", s.done && "text-muted line-through")}>{s.title}</span>
              <span className="text-[13px] text-muted">{s.body}</span>
            </span>
            {!s.done && s.to ? (
              <Link to={s.to} className="text-[13px] font-semibold">
                {s.cta}
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function StartTask({ workspaces }: { workspaces: WorkspaceDto[] }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [wsId, setWsId] = useState(workspaces[0]!.id);
  const ws = useQuery({ queryKey: ["workspace", wsId], queryFn: () => api.workspace(wsId) });
  const [ttId, setTtId] = useState<string | null>(null);
  const taskType = ws.data?.taskTypes.find((t) => t.id === ttId) ?? ws.data?.taskTypes[0];
  const field = taskType?.inputFields[0];
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 400);
    return () => clearTimeout(t);
  }, [text]);
  const brief = field ? cleanBrief({ [field.key]: debounced }) : {};
  const estimate = useQuery({
    queryKey: ["estimate", wsId, taskType?.id, brief],
    queryFn: () => api.estimate(wsId, taskType!.id, brief),
    enabled: !!taskType,
  });
  const start = useMutation({
    mutationFn: () => api.startTask(wsId, taskType!.id, cleanBrief({ [field!.key]: text })),
    onSuccess: (run) => {
      qc.setQueryData(["task", run.id], run);
      void navigate({ to: `/workspaces/${wsId}/tasks/${run.id}` });
    },
  });

  return (
    <Card as="section" aria-label="Start a task" className="flex flex-col gap-3 rounded-2xl p-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <label htmlFor="home-ws" className="text-[13px] text-muted">
          In
        </label>
        <select
          id="home-ws"
          value={wsId}
          onChange={(e) => {
            setWsId(e.target.value);
            setTtId(null);
          }}
          className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-sm font-semibold text-ink"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <label htmlFor="home-tt" className="text-[13px] text-muted">
          make a
        </label>
        <select
          id="home-tt"
          value={taskType?.id ?? ""}
          onChange={(e) => setTtId(e.target.value)}
          className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-sm font-semibold text-ink"
        >
          {ws.data?.taskTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name.toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      <label htmlFor="home-brief" className="sr-only">
        {field?.label ?? "Brief"}
      </label>
      <textarea
        id="home-brief"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={field?.placeholder ? `${field.placeholder}` : "Describe what you want…"}
        className="resize-none border-0 bg-transparent px-0.5 py-1 text-base leading-normal text-ink outline-none placeholder:text-muted"
      />
      <ErrorNote error={start.error} />
      <div className="flex flex-wrap items-center gap-2.5">
        {taskType && taskType.inputFields.length > 1 ? (
          <Link to={`/workspaces/${wsId}`} className="text-[13px] text-muted">
            More fields in the workspace
          </Link>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {estimate.data ? `Estimated ${money(estimate.data.medianUsd)}–${money(estimate.data.p90Usd)}` : "Estimating…"}
          {estimate.data?.medianSeconds ? ` · about ${Math.max(1, Math.round(estimate.data.medianSeconds / 60))} min` : ""}
        </span>
        <Button variant="primary" size="lg" disabled={!text.trim() || !taskType || start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? "Starting…" : "Start task"}
        </Button>
      </div>
    </Card>
  );
}

function NeedsYouCard({ item }: { item: InboxItemDto }) {
  const decide = useDecide(item.approvalId ?? "", item.runId);
  const problem = item.kind === "problem" || item.kind === "budget";
  const to = item.runId && item.workspaceId ? `/workspaces/${item.workspaceId}/tasks/${item.runId}` : "/inbox";
  return (
    <Card as="article" className={cx("flex flex-wrap items-center gap-3.5 px-4 py-3.5", problem ? "!border-bad-line" : "!border-warn-line")}>
      {problem ? (
        <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-bad-soft font-bold text-bad" aria-hidden>
          !
        </span>
      ) : (
        <Tile text={initials(item.workspaceName ?? "?", 1)} palette={paletteFor(item.workspaceId ?? "")} size={36} />
      )}
      <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <span className="text-xs text-muted">
          {item.workspaceName} · {item.kind === "approval" ? "Needs approval" : item.kind === "budget" ? "Budget" : "Problem"}
        </span>
        <span className="text-[15px] font-semibold">{item.title}</span>
        {item.body ? <span className="line-clamp-1 text-[13px] text-muted">{item.body}</span> : null}
      </div>
      <Link to={to} className="flex h-9 items-center rounded-lg border border-line-strong px-3 text-[13px] font-semibold text-ink no-underline hover:bg-sunken">
        Open
      </Link>
      {item.kind === "approval" && item.approvalId ? (
        <Button variant="success" disabled={decide.isPending} onClick={() => decide.mutate({ decision: "approve" })}>
          Approve
        </Button>
      ) : null}
    </Card>
  );
}

function RunningCard({ run }: { run: RunSummaryDto }) {
  const segments = Array.from({ length: run.stepsTotal }, (_, i) =>
    i < run.stepsDone ? "bg-good" : i === run.stepsDone ? (run.status === "waiting" ? "bg-warn-strong" : "bg-accent") : "bg-line",
  );
  return (
    <Link to={`/workspaces/${run.workspaceId}/tasks/${run.id}`} className="no-underline">
      <Card as="article" className="flex flex-col gap-2.5 px-4 py-3.5 text-ink hover:border-line-strong">
        <div className="flex justify-between gap-3">
          <span className="text-sm font-semibold">{run.title}</span>
          <span className="shrink-0 text-xs text-muted">
            {run.workspaceName} · {money(run.costUsd)}
          </span>
        </div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, run.stepsTotal)}, minmax(0, 1fr))` }} aria-hidden>
          {segments.map((c, i) => (
            <span key={i} className={cx("h-1.5 rounded-[3px]", c)} />
          ))}
        </div>
        <span className="text-[13px] text-muted">
          Step {Math.min(run.stepsDone + 1, run.stepsTotal)} of {run.stepsTotal}
          {run.currentStep ? ` · ${stepLabel(run.currentStep)}` : run.status === "queued" ? " · starting" : ""}
        </span>
      </Card>
    </Link>
  );
}

export function HomePage() {
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: api.inbox });
  const active = useQuery({ queryKey: ["active"], queryFn: api.activeTasks });

  const wsList = workspaces.data ?? [];
  const needsYou = (inbox.data ?? []).filter((i) => !i.resolved && (i.kind === "approval" || (!i.readAt && (i.kind === "problem" || i.kind === "budget"))));
  const running = (active.data ?? []).filter((r) => r.status === "queued" || r.status === "running");
  const spent = wsList.reduce((n, w) => n + w.monthSpendUsd, 0);
  const budget = wsList.reduce((n, w) => n + w.budgetMonthUsd, 0);
  const hasConnection = (connections.data?.length ?? 0) > 0;
  const loaded = connections.isSuccess && workspaces.isSuccess;

  return (
    <main className="flex flex-col gap-6 px-4 py-5 md:px-10 md:py-8">
      <header className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-bold tracking-[-0.02em]">{greeting()}</h1>
        <p className="m-0 text-[15px] text-muted">
          {plural(needsYou.length, "thing needs", "things need")} you · {plural(running.length, "task")} running · {money(spent)} of {money(budget)} spent this month
        </p>
      </header>

      {loaded && (!hasConnection || wsList.length === 0) ? (
        <Onboarding hasConnection={hasConnection} hasWorkspace={wsList.length > 0} />
      ) : null}
      {wsList.length > 0 ? <StartTask workspaces={wsList} /> : null}

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_460px] flex-col gap-3">
          <SectionTitle count={needsYou.length}>Needs you</SectionTitle>
          {needsYou.map((i) => (
            <NeedsYouCard key={i.id} item={i} />
          ))}
          {needsYou.length === 0 ? <p className="m-0 text-[13px] text-muted">Nothing waiting for you.</p> : null}

          <SectionTitle count={running.length} className="mt-3">
            Running now
          </SectionTitle>
          {running.map((r) => (
            <RunningCard key={r.id} run={r} />
          ))}
          {running.length === 0 ? <p className="m-0 text-[13px] text-muted">No tasks running.</p> : null}
        </div>

        <div className="flex max-w-[380px] flex-[1_1_300px] flex-col gap-3">
          <SectionTitle>Workspaces</SectionTitle>
          {wsList.map((w) => (
            <Link key={w.id} to={`/workspaces/${w.id}`} className="no-underline">
              <Card className="flex items-center gap-3 p-3.5 text-ink hover:border-line-strong">
                <Tile text={initials(w.name, 1)} palette={paletteFor(w.id)} size={36} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-semibold">{w.name}</span>
                  <span className="text-xs text-muted">
                    {[w.waitingTasks ? `${w.waitingTasks} to review` : null, w.runningTasks ? `${w.runningTasks} running` : null].filter(Boolean).join(" · ") || "Idle"}
                  </span>
                </span>
                <span className="text-xs text-muted">{money(w.monthSpendUsd)}</span>
              </Card>
            </Link>
          ))}
          <Link to="/workspaces/new" className="flex min-h-[64px] items-center justify-center rounded-[14px] border border-dashed border-line-dashed text-[13px] font-semibold text-ink-2 no-underline hover:border-accent hover:text-accent-ink">
            + Create a workspace
          </Link>
          {wsList.length > 0 ? (
            <Card as="section" className="flex flex-col gap-2.5 p-4">
              <div className="flex justify-between">
                <span className="text-sm font-semibold">This month</span>
                <span className="text-sm font-semibold">
                  {money(spent)} <span className="font-medium text-muted">/ {money(budget)}</span>
                </span>
              </div>
              <div className="flex h-2 overflow-hidden rounded bg-line-soft" aria-hidden>
                {wsList.map((w, i) => (
                  <span key={w.id} className={i % 2 === 0 ? "bg-accent" : "bg-good"} style={{ width: `${budget ? (w.monthSpendUsd / budget) * 100 : 0}%` }} />
                ))}
              </div>
              <span className="text-xs text-muted">{wsList.map((w) => `${w.name} ${money(w.monthSpendUsd)}`).join(" · ")}</span>
            </Card>
          ) : null}
        </div>
      </div>
    </main>
  );
}

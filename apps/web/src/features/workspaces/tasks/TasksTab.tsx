import type { RunSummaryDto } from "@conclave/contract";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../../lib/api";
import { clock, money, stepLabel } from "../../../lib/format";
import { cx, Empty, Segmented, StatusPill } from "../../../ui";
import { useWorkspace } from "../WorkspaceLayout";
import { NewTaskCard } from "./NewTaskCard";
import { TaskPanel } from "./TaskPanel";

type Filter = "all" | "waiting" | "running" | "done";

function subline(t: RunSummaryDto): { text: string; tone: string } {
  if (t.status === "failed") return { text: t.error ?? "Failed", tone: "text-bad" };
  if (t.status === "cancelled") return { text: `${t.taskTypeName} · cancelled`, tone: "text-muted" };
  if (t.status === "succeeded") return { text: `${t.taskTypeName} · saved to Library`, tone: "text-muted" };
  const at = Math.min(t.stepsDone + 1, t.stepsTotal);
  return { text: `${t.taskTypeName} · step ${at} of ${t.stepsTotal}${t.currentStep ? ` · ${stepLabel(t.currentStep)}` : ""}`, tone: "text-muted" };
}

export function TasksTab() {
  const { workspaceId, ws } = useWorkspace();
  const { taskId } = useParams({ strict: false }) as { taskId?: string };
  const tasks = useQuery({ queryKey: ["tasks", workspaceId], queryFn: () => api.tasks(workspaceId) });
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  if (!ws.data) return null;

  const all = tasks.data ?? [];
  const counts = {
    all: all.length,
    waiting: all.filter((t) => t.status === "waiting").length,
    running: all.filter((t) => t.status === "running" || t.status === "queued").length,
    done: all.filter((t) => t.status === "succeeded").length,
  };
  const shown = all
    .filter((t) =>
      filter === "all" ? true : filter === "waiting" ? t.status === "waiting" : filter === "running" ? t.status === "running" || t.status === "queued" : t.status === "succeeded",
    )
    .filter((t) => t.title.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="flex flex-1 flex-wrap">
      <main className="flex min-w-0 flex-[999_1_480px] flex-col gap-[18px] px-4 py-5 md:px-8 md:py-6">
        <NewTaskCard ws={ws.data} />

        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Filter tasks"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: counts.all },
              { value: "waiting", label: "Needs review", count: counts.waiting },
              { value: "running", label: "Running", count: counts.running },
              { value: "done", label: "Done", count: counts.done },
            ]}
          />
          <span className="flex-1" />
          <label htmlFor="task-search" className="sr-only">
            Search tasks
          </label>
          <input
            id="task-search"
            type="search"
            placeholder="Search tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-[200px] rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted"
          />
        </div>

        {shown.length > 0 ? (
          <div role="list" className="overflow-hidden rounded-[14px] border border-line bg-surface">
            {shown.map((t, i) => {
              const sub = subline(t);
              const selected = t.id === taskId;
              return (
                <Link
                  key={t.id}
                  role="listitem"
                  to={`/workspaces/${workspaceId}/tasks/${t.id}`}
                  aria-current={selected ? "true" : undefined}
                  className={cx(
                    "flex flex-wrap items-center gap-3.5 border-l-[3px] px-4 py-3.5 text-ink no-underline hover:bg-surface-2 hover:text-ink",
                    i > 0 && "border-t border-t-line-soft",
                    selected ? "border-l-accent bg-selected hover:bg-selected" : "border-l-transparent",
                  )}
                >
                  <StatusPill status={t.status} />
                  <span className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                    <span className="text-sm font-semibold">{t.title}</span>
                    <span className={cx("line-clamp-1 text-xs", sub.tone)}>{sub.text}</span>
                  </span>
                  <span className="text-[13px] text-muted">{money(t.costUsd)}</span>
                  <span className="w-[72px] text-right text-[13px] text-muted">{clock(t.createdAt)}</span>
                </Link>
              );
            })}
          </div>
        ) : (
          <Empty title={all.length ? "No tasks match" : "No tasks yet"}>{all.length ? "Try another filter." : "Write a brief above and press Run."}</Empty>
        )}
      </main>

      <aside aria-label="Selected task" className="flex max-w-[440px] flex-[1_1_360px] flex-col border-l border-line bg-surface px-6 py-[22px]">
        {taskId ? (
          <TaskPanel key={taskId} taskId={taskId} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
            <p className="m-0 font-semibold">Pick a task</p>
            <p className="m-0 text-[13px] text-muted">Its steps, costs and approvals show here, live.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

import type { WorkspaceDetailDto } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, cleanBrief } from "../../../lib/api";
import { useWorkspaceCan } from "../../../lib/auth";
import { money } from "../../../lib/format";
import { Button, ChipGroup, cx, ErrorNote } from "../../../ui";

/** The brief box from the Tasks mockup: task-type chips, one big field, the rest compact, the estimate beside Run. */
export function NewTaskCard({ ws }: { ws: WorkspaceDetailDto }) {
  const navigate = useNavigate();
  const canRun = useWorkspaceCan(ws, "task:run");
  const qc = useQueryClient();
  const [typeId, setTypeId] = useState(ws.taskTypes[0]?.id ?? "");
  const taskType = ws.taskTypes.find((t) => t.id === typeId) ?? ws.taskTypes[0];
  const [brief, setBrief] = useState<Record<string, string>>({});
  const [showNotes, setShowNotes] = useState(false);
  const [debounced, setDebounced] = useState(brief);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(brief), 400);
    return () => clearTimeout(t);
  }, [brief]);

  const estimate = useQuery({
    queryKey: ["estimate", ws.id, taskType?.id, cleanBrief(debounced)],
    queryFn: () => api.estimate(ws.id, taskType!.id, cleanBrief(debounced)),
    enabled: !!taskType,
  });
  const start = useMutation({
    mutationFn: () => api.startTask(ws.id, taskType!.id, cleanBrief(brief)),
    onSuccess: (run) => {
      qc.setQueryData(["task", run.id], run);
      void qc.invalidateQueries({ queryKey: ["tasks", ws.id] });
      setBrief({});
      void navigate({ to: `/workspaces/${ws.id}/tasks/${run.id}` });
    },
  });

  if (!taskType) return null;
  const [main, ...rest] = taskType.inputFields;
  const shortFields = rest.filter((f) => f.type === "text");
  const longFields = rest.filter((f) => f.type === "longtext");
  // Only roles that required steps call must have a node; optional steps are skipped without one.
  const requiredRoles = new Set(taskType.steps.flatMap((s) => ("role" in s && !s.optional && !s.disabled ? [s.role] : [])));
  const unfilled = ws.roles.filter((r) => requiredRoles.has(r.key) && (!r.connectionId || !r.model));
  const asksYou = taskType.steps.some((s) => s.kind === "approval");
  const set = (key: string, value: string) => setBrief((b) => ({ ...b, [key]: value }));
  const ready = canRun && main && (brief[main.key] ?? "").trim() && unfilled.length === 0;

  return (
    <section id="new-task" aria-label="New task" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-[18px] py-4">
      <ChipGroup label="Task type" value={taskType.id} onChange={setTypeId} options={ws.taskTypes.map((t) => ({ value: t.id, label: t.name }))} />
      {main ? (
        <>
          <label htmlFor="brief-main" className="sr-only">
            {main.label}
          </label>
          <textarea
            id="brief-main"
            rows={2}
            value={brief[main.key] ?? ""}
            onChange={(e) => set(main.key, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) start.mutate();
            }}
            placeholder={main.placeholder ?? main.label}
            className="resize-none border-0 bg-transparent p-0.5 text-base leading-normal text-ink outline-none placeholder:text-muted"
          />
        </>
      ) : null}
      {showNotes
        ? longFields.map((f) => (
            <textarea
              key={f.key}
              aria-label={f.label}
              rows={2}
              value={brief[f.key] ?? ""}
              onChange={(e) => set(f.key, e.target.value)}
              placeholder={f.placeholder ?? f.label}
              className="resize-y rounded-[10px] border border-line bg-sunken px-3 py-2 text-[13px] text-ink placeholder:text-muted"
            />
          ))
        : null}
      <div className="flex flex-wrap items-center gap-2">
        {shortFields.map((f) => (
          <input
            key={f.key}
            aria-label={f.label}
            value={brief[f.key] ?? ""}
            onChange={(e) => set(f.key, e.target.value)}
            placeholder={`${f.label}${f.placeholder ? `: ${f.placeholder}` : ""}`}
            className="h-[34px] w-[220px] rounded-lg border border-line bg-sunken px-2.5 text-[13px] text-ink-2 placeholder:text-muted"
          />
        ))}
        {longFields.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowNotes((s) => !s)}
            aria-expanded={showNotes}
            className={cx("h-[34px] rounded-lg border border-line px-3 text-[13px] text-ink-2", showNotes ? "bg-line-soft" : "bg-sunken")}
          >
            {showNotes ? "Hide " : "+ "}
            {longFields.map((f) => f.label.toLowerCase()).join(", ")}
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted" aria-live="polite">
          {estimate.data ? `≈ ${money(estimate.data.medianUsd)}–${money(estimate.data.p90Usd)}` : "Estimating…"}
          {estimate.data?.confidence === "none" ? " (rough)" : ""}
          {estimate.data?.medianSeconds ? ` · ${Math.max(1, Math.round(estimate.data.medianSeconds / 60))} min` : ""}
          {asksYou ? " · asks you before delivering" : ""}
        </span>
        <Button variant="primary" className="!h-[38px] !rounded-[10px] !px-[18px] text-sm" disabled={!ready || start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? "Starting…" : "Run"}
        </Button>
      </div>
      {!canRun ? <p className="m-0 text-[13px] text-muted">Your role here can read tasks but not run them.</p> : null}
      {unfilled.length > 0 ? (
        <p className="m-0 text-[13px] text-warn-ink">
          {unfilled.map((r) => r.name).join(", ")} {unfilled.length === 1 ? "has" : "have"} no model yet. <Link to={`/workspaces/${ws.id}/team`}>Choose one in Team</Link>.
        </p>
      ) : null}
      <ErrorNote error={start.error} />
    </section>
  );
}

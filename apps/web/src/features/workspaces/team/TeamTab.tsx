import type { ConnectionDto, RoleDto, RoleName, WorkspaceDetailDto } from "@conclave/contract";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { api } from "../../../lib/api";
import { money } from "../../../lib/format";
import { initials, moduleLook } from "../../../lib/palette";
import { useCan } from "../../../lib/auth";
import { Button, Card, ErrorNote, Pill, Progress, Tile } from "../../../ui";
import { ChevronIcon } from "../../../ui/icons";
import { NodePicker, type NodeValue } from "../../connections/NodePicker";
import { useWorkspace } from "../WorkspaceLayout";

function RoleRows({ ws, role, conn }: { ws: WorkspaceDetailDto; role: RoleDto; conn: ConnectionDto | undefined }) {
  const qc = useQueryClient();
  const [node, setNode] = useState<NodeValue>({ connectionId: role.connectionId, model: role.model });
  const [effort, setEffort] = useState(role.effort ?? "");
  const [open, setOpen] = useState(false);
  const dirty = node.connectionId !== role.connectionId || node.model !== role.model || effort !== (role.effort ?? "");
  const save = useMutation({
    mutationFn: () => api.assignRole(ws.id, role.key, { ...node, effort: effort || null }),
    onSuccess: (next) => qc.setQueryData(["workspace", ws.id], next),
  });
  const empty = !role.connectionId || !role.model;
  const look = conn ? moduleLook(conn.moduleId, conn.name) : null;

  return (
    <Fragment>
      <tr className={empty ? "border-t border-line-soft bg-warn-row" : open ? "border-t border-line-soft bg-selected-2" : "border-t border-line-soft"}>
        <td className="px-4 py-3.5 align-top">
          <div className="flex items-center gap-2.5">
            {look ? (
              <Tile text={look.short} palette={look.palette} size={32} round className="!text-[11px]" />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-line-dashed text-[13px] text-muted" aria-hidden>
                ?
              </span>
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-semibold">
                {role.name} {empty ? <Pill tone="warn">Empty</Pill> : null} {role.port.startsWith("tool@") ? <Pill>tool</Pill> : null}
              </span>
              <span className="text-muted">{role.description}</span>
            </span>
          </div>
        </td>
        <td className="w-[44%] px-2 py-3.5 align-top">
          <NodePicker idPrefix={`role-${role.key}`} value={node} onChange={setNode} port={role.port} compact />
        </td>
        <td className="px-2 py-3.5 align-top">
          {role.port.startsWith("tool@") ? <span className="text-muted">—</span> : <>
          <label className="sr-only" htmlFor={`effort-${role.key}`}>
            {role.name} effort
          </label>
          <select
            id={`effort-${role.key}`}
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            className="h-[34px] rounded-lg border border-line-strong bg-surface px-2 text-[13px] font-semibold text-ink"
          >
            <option value="">Default</option>
            {["low", "medium", "high", "xhigh", "max"].map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select></>}
        </td>
        <td className="px-4 py-3.5 text-right align-top">
          <div className="flex flex-col items-end gap-1">
            <span>{money(role.monthSpendUsd)}</span>
            <span className="text-xs text-muted">
              {role.monthRuns} call{role.monthRuns === 1 ? "" : "s"}
              {role.monthFailures ? ` · ${role.monthFailures} failed` : ""}
            </span>
            {dirty ? (
              <Button variant="primary" size="sm" disabled={save.isPending || (!!node.connectionId && !node.model)} onClick={() => save.mutate()}>
                Save
              </Button>
            ) : null}
          </div>
        </td>
      </tr>
      <tr className={open ? "bg-selected-2" : ""}>
        <td colSpan={4} className="px-4 pb-3 pl-[58px]">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1 text-xs font-semibold text-muted hover:text-ink">
            <ChevronIcon open={open} size={12} /> Instructions
          </button>
          {open ? <p className="output-text m-0 mt-2 rounded-[10px] border border-line-strong bg-surface px-3 py-2.5 text-[13px]">{role.instructions}</p> : null}
          <ErrorNote error={save.error} />
        </td>
      </tr>
    </Fragment>
  );
}

export function BudgetCard({ ws }: { ws: WorkspaceDetailDto }) {
  const qc = useQueryClient();
  const [task, setTask] = useState("");
  const [month, setMonth] = useState("");
  const toNum = (v: string) => Number(v.replace(/[^0-9.]/g, ""));
  const save = useMutation({
    mutationFn: () => api.updateBudget(ws.id, { ...(task ? { taskUsd: toNum(task) } : {}), ...(month ? { monthUsd: toNum(month) } : {}) }),
    onSuccess: (next) => {
      qc.setQueryData(["workspace", ws.id], next);
      void qc.invalidateQueries({ queryKey: ["workspaces"] });
      setTask("");
      setMonth("");
    },
  });
  const pct = (ws.monthSpendUsd / ws.budgetMonthUsd) * 100;

  return (
    <Card as="section" className="flex flex-col gap-3 p-[18px]">
      <h2 className="m-0 text-[15px] font-semibold">Budget</h2>
      <div className="flex justify-between text-[13px]">
        <span>This month</span>
        <span className="font-semibold">
          {money(ws.monthSpendUsd)} / {money(ws.budgetMonthUsd)}
        </span>
      </div>
      <Progress value={pct} tone={pct > 90 ? "bad" : "accent"} />
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-2.5">
          <div className="flex flex-col gap-1">
            <label htmlFor="budget-task" className="text-xs text-muted">
              Per task
            </label>
            <input id="budget-task" inputMode="decimal" placeholder={money(ws.budgetTaskUsd)} value={task} onChange={(e) => setTask(e.target.value)} className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-ink" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="budget-month" className="text-xs text-muted">
              Per month
            </label>
            <input id="budget-month" inputMode="decimal" placeholder={money(ws.budgetMonthUsd)} value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-ink" />
          </div>
        </div>
        <p className="m-0 text-xs text-muted">New spend stops when a limit is reached. Every step reserves its cost before it runs.</p>
        <ErrorNote error={save.error} />
        {task || month ? (
          <Button type="submit" variant="primary" size="sm" disabled={save.isPending} className="self-start">
            Save budget
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

/** Who can do what in this workspace; owners can override a member's org role here (ACC-004). */
function WorkspacePeople({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const canManage = useCan("member:manage");
  const people = useQuery({ queryKey: ["workspace-members", workspaceId], queryFn: () => api.workspaceMembers(workspaceId) });
  const set = useMutation({
    mutationFn: (v: { userId: string; role: RoleName | null }) => api.setWorkspaceRole(workspaceId, v.userId, v.role),
    onSuccess: (next) => qc.setQueryData(["workspace-members", workspaceId], next),
  });

  return (
    <Card as="section" className="flex flex-col gap-2.5 p-[18px]">
      <h2 className="m-0 text-[15px] font-semibold">People</h2>
      {people.data?.map((m) => (
        <div key={m.userId} className="flex items-center gap-2.5 text-[13px]">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-inverse text-[11px] font-bold text-on-inverse" aria-hidden>
            {initials(m.name)}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {m.name}
            {m.you ? <span className="text-muted"> (you)</span> : null}
          </span>
          {canManage && !m.you ? (
            <select
              aria-label={`${m.name}'s role in this workspace`}
              value={m.override ?? ""}
              disabled={set.isPending}
              onChange={(e) => set.mutate({ userId: m.userId, role: (e.target.value || null) as RoleName | null })}
              className="h-8 rounded-lg border border-line-strong bg-surface px-1.5 text-xs text-ink"
            >
              <option value="">Org role ({m.role})</option>
              {(["owner", "editor", "runner", "viewer"] as const).map((r) => (
                <option key={r} value={r}>
                  {r} here
                </option>
              ))}
            </select>
          ) : (
            <span className="text-muted">{m.override ?? m.role}</span>
          )}
        </div>
      ))}
      <ErrorNote error={set.error} />
      {canManage ? (
        <Link to="/settings" className="text-xs font-semibold">
          Invite someone
        </Link>
      ) : null}
    </Card>
  );
}

export function TeamTab() {
  const { ws } = useWorkspace();
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  if (!ws.data) return null;
  const byId = new Map((connections.data ?? []).map((c) => [c.id, c]));

  return (
    <div className="flex flex-1 flex-wrap items-start gap-6 px-4 py-5 md:px-8 md:py-6">
      <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-3.5">
        <p className="m-0 min-w-[260px] text-sm leading-normal text-muted">
          Workflows call <strong className="text-ink">roles</strong>, not models. Change a model here and every workflow keeps working.
        </p>
        <div className="relative overflow-x-auto rounded-[14px] border border-line bg-surface">
          <table className="w-full min-w-[660px] border-collapse text-[13px]">
            <thead>
              <tr className="bg-surface-2 text-left text-xs text-muted">
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-2 py-3 font-semibold">Connection and model</th>
                <th className="px-2 py-3 font-semibold">Effort</th>
                <th className="px-4 py-3 text-right font-semibold whitespace-nowrap">This month</th>
              </tr>
            </thead>
            <tbody>
              {ws.data.roles.map((r) => (
                <RoleRows key={`${r.id}:${r.connectionId}:${r.model}:${r.effort}`} ws={ws.data!} role={r} conn={r.connectionId ? byId.get(r.connectionId) : undefined} />
              ))}
            </tbody>
          </table>
        </div>
      </main>
      <aside className="flex max-w-[360px] flex-[1_1_300px] flex-col gap-3.5">
        <BudgetCard ws={ws.data} />
        <WorkspacePeople workspaceId={ws.data.id} />
        <Card as="section" className="flex flex-col gap-2 p-[18px]">
          <h2 className="m-0 text-[15px] font-semibold">If you export this workspace</h2>
          <p className="m-0 text-[13px] leading-relaxed text-muted">Roles, instructions and workflows are shared. Your keys and models are not: people fill each role with their own.</p>
        </Card>
      </aside>
    </div>
  );
}

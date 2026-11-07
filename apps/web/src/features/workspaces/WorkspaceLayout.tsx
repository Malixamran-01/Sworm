import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { api } from "../../lib/api";
import { money } from "../../lib/format";
import { initials, moduleLook, paletteFor } from "../../lib/palette";
import { ErrorNote, Tile } from "../../ui";

export function useWorkspace() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
  const ws = useQuery({ queryKey: ["workspace", workspaceId], queryFn: () => api.workspace(workspaceId) });
  return { workspaceId, ws };
}

export function WorkspaceLayout() {
  const { workspaceId, ws } = useWorkspace();
  const tasks = useQuery({ queryKey: ["tasks", workspaceId], queryFn: () => api.tasks(workspaceId) });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  if (ws.isLoading) return <p className="px-8 py-6 text-muted">Loading…</p>;
  if (ws.error || !ws.data) {
    return (
      <div className="px-8 py-6">
        <ErrorNote error={ws.error ?? new Error("Workspace not found.")} />
      </div>
    );
  }
  const w = ws.data;
  const done = tasks.data?.filter((t) => t.status === "succeeded").length ?? 0;
  const tabs = [
    { to: "", label: "Tasks", count: tasks.data?.length },
    { to: "team", label: "Team", count: w.roles.length },
    { to: "workflows", label: "Workflows", count: w.taskTypes.length },
    { to: "library", label: "Library", count: done },
    { to: "activity", label: "Activity" },
    { to: "settings", label: "Settings" },
  ];
  const connById = new Map((connections.data ?? []).map((c) => [c.id, c]));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-col gap-3.5 border-b border-line bg-surface px-4 pt-[18px] md:px-8">
        <nav aria-label="Breadcrumb" className="text-[13px] text-muted">
          <Link to="/" className="text-muted no-underline hover:text-ink">
            Workspaces
          </Link>{" "}
          / {w.name}
        </nav>
        <div className="flex flex-wrap items-center gap-3.5">
          <Tile text={initials(w.name, 1)} palette={paletteFor(w.id)} size={44} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="m-0 text-[22px] font-bold tracking-[-0.01em]">{w.name}</h1>
            <span className="line-clamp-1 text-[13px] text-muted">{w.description}</span>
          </div>
          <span className="flex-1" />
          <Link to={`/workspaces/${w.id}/team`} className="flex items-center gap-2 text-[13px] text-ink-2 no-underline hover:text-ink">
            <span className="flex">
              {w.roles.slice(0, 4).map((r, i) => {
                const conn = r.connectionId ? connById.get(r.connectionId) : undefined;
                const look = conn ? moduleLook(conn.moduleId, conn.name) : { short: "?", palette: "grey" as const };
                return (
                  <span key={r.id} className={i ? "-ml-2" : ""} title={`${r.name}${conn ? ` · ${conn.name}` : " · no node"}`}>
                    <Tile text={look.short} palette={look.palette} size={22} round className="!h-[26px] !w-[26px] border-2 border-surface !text-[10px]" />
                  </span>
                );
              })}
            </span>
            {w.roles.length} roles
          </Link>
          <span className="border-l border-line pl-3.5 text-[13px] text-muted">
            {money(w.monthSpendUsd)} of {money(w.budgetMonthUsd)} this month
          </span>
        </div>
        {/* One row that scrolls sideways on narrow screens, instead of wrapping onto a second line. */}
        <nav aria-label="Workspace sections" className="-mx-4 flex gap-6 overflow-x-auto px-4 whitespace-nowrap md:mx-0 md:px-0">
          {tabs.map((t) => (
            <Link
              key={t.label}
              to={`/workspaces/${w.id}${t.to ? `/${t.to}` : ""}`}
              activeOptions={{ exact: t.to !== "" }}
              className="-mb-px border-b-2 border-transparent px-0.5 py-2.5 text-sm text-ink-2 no-underline hover:text-ink"
              activeProps={{ className: "!border-accent !text-accent-ink font-semibold", "aria-current": "page" }}
            >
              {t.label}
              {t.count !== undefined ? <span className="font-medium text-muted"> {t.count}</span> : null}
            </Link>
          ))}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

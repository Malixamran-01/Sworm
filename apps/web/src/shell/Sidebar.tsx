import { topics, type WorkspaceDto } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { replaceSession, useCan, useMe } from "../lib/auth";
import { moneyShort } from "../lib/format";
import { initials, paletteFor } from "../lib/palette";
import { useConnected, useTopics } from "../lib/realtime";
import { setTheme, useTheme } from "../lib/theme";
import { cx, Tile } from "../ui";
import { CloseIcon, GaugeIcon, GearIcon, HomeIcon, InboxIcon, MoonIcon, PlugIcon, SearchIcon, SignOutIcon, SunIcon } from "../ui/icons";

const navItem = "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink-2 no-underline hover:bg-line-soft hover:text-ink";
const navActive = "!bg-accent-soft !text-accent-ink font-semibold";

function NavLink({ to, icon, children, end, exact }: { to: string; icon?: ReactNode; children: ReactNode; end?: ReactNode; exact?: boolean }) {
  return (
    <Link to={to} activeOptions={{ exact: exact ?? false }} className={navItem} activeProps={{ className: navActive, "aria-current": "page" }}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {end}
    </Link>
  );
}

function WorkspaceStatus({ ws }: { ws: WorkspaceDto }) {
  if (ws.waitingTasks > 0) return <span className="rounded-full bg-warn-soft px-[7px] py-0.5 text-[11px] font-semibold text-warn-ink">Review</span>;
  if (ws.runningTasks > 0) return <span className="text-[11px] text-muted">Running</span>;
  return null;
}

/** Fixed on wide screens; a drawer below 768px, opened from the top bar. */
export function Sidebar({ onOpenPalette, open = false, onClose }: { onOpenPalette: () => void; open?: boolean; onClose?: () => void }) {
  const navigate = useNavigate();
  const me = useMe();
  const qc = useQueryClient();
  const canCreate = useCan("workspace:edit");
  const signOut = useMutation({ mutationFn: api.signOut, onSuccess: () => replaceSession(qc, null) });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: api.inbox });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const connected = useConnected();
  const theme = useTheme();

  // Listen to every workspace so Home, the sidebar and lists stay live.
  useTopics([topics.inbox(me.user.id), ...(workspaces.data?.map((w) => topics.workspaceRuns(w.id)) ?? [])]);

  const needsYou = inbox.data?.filter((i) => !i.resolved && (i.kind === "approval" || (!i.readAt && (i.kind === "problem" || i.kind === "budget")))).length ?? 0;
  const spent = workspaces.data?.reduce((n, w) => n + w.monthSpendUsd, 0) ?? 0;
  const budget = workspaces.data?.reduce((n, w) => n + w.budgetMonthUsd, 0) ?? 0;
  const currentWs = /^\/workspaces\/([0-9a-f-]{36})/.exec(pathname)?.[1];

  const newTask = () => {
    const target = currentWs ?? workspaces.data?.[0]?.id;
    void navigate({ to: target ? `/workspaces/${target}` : "/workspaces/new", ...(target ? { hash: "new-task" } : {}) });
    setTimeout(() => document.getElementById("brief-main")?.focus(), 50);
  };

  return (
    <aside
      id="main-nav"
      aria-label="Main navigation"
      className={cx(
        "flex h-screen w-[248px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-surface px-3 py-4",
        "fixed inset-y-0 left-0 z-40 transition-transform md:sticky md:top-0 md:translate-x-0",
        open ? "translate-x-0 shadow-xl" : "invisible -translate-x-full md:visible",
      )}
    >
      <div className="flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 px-2 pt-1 pb-3.5 text-ink no-underline hover:text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-on-accent" aria-hidden>
            C
          </span>
          <span className="text-base font-bold">Conclave</span>
        </Link>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close menu" className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-line-soft md:hidden">
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenPalette}
        className="mb-2 flex h-[38px] items-center gap-1.5 rounded-[9px] border border-line bg-sunken px-2 text-[12.5px] whitespace-nowrap text-muted hover:border-line-strong"
      >
        <SearchIcon />
        <span className="min-w-0 truncate">Search or run a command</span>
        <kbd className="ml-auto shrink-0 rounded-[5px] border border-line-strong px-1 py-px font-sans text-[11px]">{navigator.platform.startsWith("Mac") ? "⌘K" : "^K"}</kbd>
      </button>

      <button
        type="button"
        onClick={newTask}
        className="mb-3 flex h-10 items-center justify-center gap-1.5 rounded-[9px] bg-accent text-sm font-semibold text-on-accent hover:brightness-110"
      >
        + New task
      </button>

      <NavLink to="/" exact icon={<HomeIcon />}>
        Home
      </NavLink>
      <NavLink
        to="/inbox"
        icon={<InboxIcon />}
        end={needsYou > 0 ? <span className="rounded-full bg-alert px-[7px] py-px text-xs font-bold text-white">{needsYou}</span> : null}
      >
        Inbox
      </NavLink>

      <div className="flex items-center justify-between px-2.5 pt-4 pb-1.5">
        <span className="text-xs font-semibold text-muted">Workspaces</span>
        {canCreate ? (
          <Link to="/workspaces/new" aria-label="Create a workspace" className="text-lg leading-none text-muted no-underline hover:text-ink">
            +
          </Link>
        ) : null}
      </div>
      {workspaces.data?.map((w) => (
        <NavLink key={w.id} to={`/workspaces/${w.id}`} icon={<Tile text={initials(w.name, 1)} palette={paletteFor(w.id)} size={22} />} end={<WorkspaceStatus ws={w} />}>
          {w.name}
        </NavLink>
      ))}
      {workspaces.data?.length === 0 ? <p className="m-0 px-2.5 text-[13px] text-muted">No workspaces yet.</p> : null}

      <div className="min-h-4 flex-1" />

      <NavLink to="/connections" icon={<PlugIcon />}>
        Connections
      </NavLink>
      <div className={cx(navItem, "cursor-default hover:bg-transparent hover:text-ink-2")} title="Spend across all workspaces this month">
        <GaugeIcon />
        <span className="flex-1">This month</span>
        <span className="text-xs text-muted">
          {moneyShort(spent)} / {moneyShort(budget)}
        </span>
      </div>

      <NavLink to="/settings" icon={<GearIcon />}>
        Settings
      </NavLink>

      <div className="mt-2 flex items-center gap-2 border-t border-line px-2.5 pt-3">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-inverse text-[12px] font-bold text-on-inverse" aria-hidden>
          {initials(me.user.name)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-semibold">{me.user.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted" title={connected ? "Live updates connected" : "Reconnecting"}>
            <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", connected ? "bg-good" : "bg-warn-strong")} aria-hidden />
            <span className="truncate">
              {me.org.name} · {me.role}
            </span>
          </span>
        </span>
        <button
          type="button"
          onClick={() => signOut.mutate()}
          aria-label="Sign out"
          title="Sign out"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-line-soft hover:text-ink"
        >
          <SignOutIcon />
        </button>
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-line-soft hover:text-ink"
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </aside>
  );
}

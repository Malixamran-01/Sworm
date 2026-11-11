import type { AuditEntryDto, UsageInsightsDto, UsageSliceDto } from "@conclave/contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { duration, money, plural } from "../../lib/format";
import { initials, moduleLook, paletteFor } from "../../lib/palette";
import { Button, Card, cx, Empty, ErrorNote, PageHeader, Pill, SectionTitle, Segmented, Tile } from "../../ui";

type Period = "7" | "30" | "90";
type Tab = "spend" | "audit";

const SOURCE_LABEL: Record<string, { label: string; help: string; exact: boolean }> = {
  metered: { label: "Metered", help: "counted by Conclave from the provider's token usage", exact: true },
  reported: { label: "Reported", help: "the outside system said what it cost", exact: true },
  reconciled: { label: "Reconciled", help: "corrected against the provider's bill", exact: true },
  estimated: { label: "Estimated", help: "from the prices set on the connection", exact: false },
};

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "bad" | "good" }) {
  return (
    <Card className="flex min-w-[150px] flex-1 flex-col gap-0.5 px-4 py-3.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-[22px] font-bold tracking-[-0.01em] tabular-nums">{value}</span>
      {sub ? <span className={cx("text-xs", tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : "text-muted")}>{sub}</span> : null}
    </Card>
  );
}

const dayLabel = (day: string, long = false) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString([], long ? { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });

/** Spend per day: one series, so one colour and no legend; the title names it. */
function DailyChart({ data }: { data: UsageInsightsDto["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(...data.map((d) => d.costUsd), 0);
  const top = max > 0 ? max : 1;
  const shown = hover === null ? null : data[hover]!;
  const marks = [0, Math.floor((data.length - 1) / 2), data.length - 1];
  return (
    <Card as="section" className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <SectionTitle>Spend per day</SectionTitle>
        <span className="text-[13px] text-muted" aria-live="polite">
          {shown ? `${dayLabel(shown.day, true)}: ${money(shown.costUsd)}, ${plural(shown.calls, "call")}` : max > 0 ? `Highest day ${money(max)}` : "No spend in this period"}
        </span>
        <span className="flex-1" />
        <button type="button" className="text-xs font-semibold text-accent-ink hover:underline" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          {table ? "Show chart" : "Show as table"}
        </button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-y-auto" tabIndex={0} role="region" aria-label="Spend per day, as a table">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1.5 font-semibold">Day</th>
                <th className="py-1.5 text-right font-semibold">Spend</th>
                <th className="py-1.5 text-right font-semibold">Calls</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.day} className="border-t border-line-soft">
                  <td className="py-1.5">{dayLabel(d.day, true)}</td>
                  <td className="py-1.5 text-right tabular-nums">{money(d.costUsd)}</td>
                  <td className="py-1.5 text-right tabular-nums">{d.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <div className="flex h-40 items-stretch border-b border-line" role="img" aria-label={`Spend per day over ${data.length} days. Highest day ${money(max)}. Use "Show as table" for each value.`} onMouseLeave={() => setHover(null)}>
            {data.map((d, i) => (
              // The whole column is the hover target, so thin and empty days are easy to hit.
              <div key={d.day} className={cx("flex min-w-0 flex-1 items-end justify-center px-px", hover === i && "bg-line-soft")} onMouseEnter={() => setHover(i)}>
                <div
                  className="w-full max-w-[22px] rounded-t-[4px]"
                  style={{ height: d.costUsd > 0 ? `max(2px, ${(d.costUsd / top) * 100}%)` : 0, background: "var(--series-1)", opacity: hover === null || hover === i ? 1 : 0.55 }}
                />
              </div>
            ))}
          </div>
          <div className="relative mt-1 h-4 text-xs text-muted" aria-hidden>
            {marks.map((i, n) => (
              <span key={i} className="absolute whitespace-nowrap" style={n === 0 ? { left: 0 } : n === 2 ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" }}>
                {dayLabel(data[i]!.day)}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/** A ranked list with a proportional bar: magnitude in one hue, the name carries identity. */
function Breakdown({ title, rows, empty, tile, to }: { title: string; rows: UsageSliceDto[]; empty: string; tile: (r: UsageSliceDto) => React.ReactNode; to?: (r: UsageSliceDto) => string | null }) {
  const max = Math.max(...rows.map((r) => r.costUsd), 0);
  const maxCalls = Math.max(...rows.map((r) => r.calls), 1);
  return (
    <Card as="section" className="flex flex-col gap-3 p-4">
      <SectionTitle>{title}</SectionTitle>
      {rows.length ? (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {rows.map((r) => {
            const href = to?.(r);
            // With no spend at all (free or local models), rank by calls instead.
            const share = max > 0 ? r.costUsd / max : r.calls / maxCalls;
            return (
              <li key={r.id} className="flex items-center gap-2.5 text-[13px]">
                {tile(r)}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-baseline gap-2">
                    {href ? (
                      <Link to={href} className="min-w-0 truncate font-semibold text-ink no-underline hover:underline">
                        {r.name}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate font-semibold">{r.name}</span>
                    )}
                    {r.detail ? <span className="hidden min-w-0 truncate text-xs text-muted sm:inline">{r.detail}</span> : null}
                    <span className="flex-1" />
                    <span className="shrink-0 tabular-nums">{money(r.costUsd)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded bg-line-soft" aria-hidden>
                      <span className="block h-full rounded" style={{ width: `${Math.max(1.5, share * 100)}%`, background: "var(--series-1)" }} />
                    </span>
                    <span className="w-[72px] shrink-0 text-right text-xs text-muted tabular-nums">{plural(r.calls, "call")}</span>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 text-[13px] text-muted">{empty}</p>
      )}
    </Card>
  );
}

function Spend({ days }: { days: number }) {
  const usage = useQuery({ queryKey: ["usage", days], queryFn: () => api.usage(days) });
  if (usage.isLoading) return <p className="text-muted">Loading…</p>;
  if (usage.error || !usage.data) return <ErrorNote error={usage.error ?? new Error("Could not load.")} />;
  const u = usage.data;
  if (u.totals.calls === 0 && u.totals.tasks === 0) {
    return <Empty title={`Nothing ran in the last ${days} days`}>Run a task, and its spend, calls and failures show here, across every workspace you can see.</Empty>;
  }
  const delta = u.previous.costUsd > 0 ? (u.totals.costUsd - u.previous.costUsd) / u.previous.costUsd : null;
  const exact = u.bySource.filter((s) => SOURCE_LABEL[s.source]?.exact).reduce((n, s) => n + s.costUsd, 0);
  const exactShare = u.totals.costUsd > 0 ? Math.round((exact / u.totals.costUsd) * 100) : null;
  const finished = u.totals.tasksDone + u.totals.tasksFailed;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Stat
          label={`Spent in ${days} days`}
          value={money(u.totals.costUsd)}
          sub={delta === null ? "nothing in the period before" : `${delta >= 0 ? "up" : "down"} ${Math.abs(Math.round(delta * 100))}% on the ${days} days before`}
        />
        <Stat label="Calls to systems" value={u.totals.calls.toLocaleString()} sub={`${(u.totals.inputTokens + u.totals.outputTokens).toLocaleString()} tokens`} />
        <Stat
          label="Tasks"
          value={u.totals.tasks.toLocaleString()}
          sub={u.totals.tasksFailed ? `${u.totals.tasksFailed} of ${finished} finished ones failed` : finished ? "none failed" : "none finished yet"}
          {...(u.totals.tasksFailed ? { tone: "bad" as const } : {})}
        />
        <Stat
          label="How exact the costs are"
          value={exactShare === null ? "—" : `${exactShare}%`}
          sub={exactShare === null ? "nothing was charged" : exactShare === 100 ? "all measured, none estimated" : "measured; the rest is estimated from set prices"}
        />
      </div>

      <DailyChart data={u.daily} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown
          title="By workspace"
          rows={u.byWorkspace}
          empty="No spend yet."
          to={(r) => `/workspaces/${r.id}`}
          tile={(r) => <Tile text={initials(r.name, 1)} palette={paletteFor(r.id)} size={30} />}
        />
        <Breakdown
          title="By connection"
          rows={u.byConnection}
          empty="No spend yet."
          tile={(r) => {
            const look = moduleLook(r.detail ?? "", r.name);
            return <Tile text={look.short} palette={look.palette} size={30} />;
          }}
        />
        <Breakdown title="By model or tool" rows={u.byModel} empty="No spend yet." tile={(r) => <Tile text={initials(r.name)} palette="grey" size={30} />} />

        <Card as="section" className="flex flex-col gap-3 p-4">
          <SectionTitle>Where the cost figures come from</SectionTitle>
          {u.bySource.length ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
              {u.bySource.map((s) => {
                const info = SOURCE_LABEL[s.source] ?? { label: s.source, help: "", exact: false };
                return (
                  <li key={s.source} className="flex items-start gap-2.5">
                    <Pill tone={info.exact ? "good" : "warn"}>{info.label}</Pill>
                    <span className="min-w-0 flex-1 text-ink-2">{info.help}</span>
                    <span className="shrink-0 text-right tabular-nums">
                      {money(s.costUsd)}
                      <span className="block text-xs text-muted">{plural(s.calls, "call")}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-[13px] text-muted">No spend yet.</p>
          )}
        </Card>
      </div>

      <section className="flex flex-col gap-3" aria-label="Reliability">
        <SectionTitle>Reliability by connection</SectionTitle>
        {u.health.length ? (
          <div className="overflow-x-auto rounded-[14px] border border-line bg-surface" tabIndex={0} role="region" aria-label="Reliability by connection, as a table">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <thead>
                <tr className="bg-surface-2 text-left text-xs text-muted">
                  <th className="px-4 py-3 font-semibold">Connection</th>
                  <th className="px-2 py-3 text-right font-semibold">Calls</th>
                  <th className="px-2 py-3 text-right font-semibold">Failed</th>
                  <th className="px-2 py-3 text-right font-semibold">Failure rate</th>
                  <th className="px-2 py-3 text-right font-semibold">Retries</th>
                  <th className="px-4 py-3 text-right font-semibold">Average time</th>
                </tr>
              </thead>
              <tbody>
                {u.health.map((h) => {
                  const rate = h.calls ? h.failures / h.calls : 0;
                  return (
                    <tr key={h.connectionId} className="border-t border-line-soft">
                      <td className="px-4 py-3">
                        <span className="font-semibold">{h.connectionName}</span> <span className="text-xs text-muted">{h.moduleId}</span>
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">{h.calls}</td>
                      <td className="px-2 py-3 text-right tabular-nums">{h.failures}</td>
                      <td className="px-2 py-3 text-right">
                        {h.failures ? <Pill tone={rate >= 0.2 ? "bad" : "warn"}>{Math.max(1, Math.round(rate * 100))}%</Pill> : <span className="text-muted">0%</span>}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">{h.retries}</td>
                      <td className="px-4 py-3 text-right text-muted tabular-nums">{h.avgLatencyMs === null ? "—" : duration(h.avgLatencyMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 text-[13px] text-muted">No calls yet.</p>
        )}
        <p className="m-0 text-xs text-muted">Every attempt counts, so a connection that needed retries shows here even when its tasks ended well.</p>
      </section>
    </div>
  );
}

const AREAS = [
  { value: "", label: "Everything" },
  { value: "task", label: "Tasks" },
  { value: "approval", label: "Approvals" },
  { value: "connection", label: "Connections" },
  { value: "workspace", label: "Workspaces" },
  { value: "member", label: "Members" },
  { value: "token", label: "Tokens" },
  { value: "user", label: "Sign-ins" },
];

/** Plain words for what happened. Unknown actions still read sensibly. */
const ACTIONS: Record<string, string> = {
  "task.started": "started the task",
  "task.cancelled": "cancelled the task",
  "approval.approve": "approved",
  "approval.reject": "rejected",
  "approval.changes": "asked for changes to",
  "connection.created": "added the connection",
  "connection.updated": "changed the connection",
  "connection.deleted": "removed a connection",
  "connection.disabled": "turned off the connection",
  "connection.enabled": "turned on the connection",
  "workspace.created": "created the workspace",
  "workspace.exported": "exported the workspace",
  "workspace.role_override": "changed someone's role in",
  "role.assigned": "chose a node for a role in",
  "role.created": "added a role to",
  "role.updated": "changed a role in",
  "role.deleted": "removed a role from",
  "task_type.created": "added a workflow to",
  "task_type.updated": "changed a workflow in",
  "task_type.deleted": "removed a workflow from",
  "member.role_changed": "changed the role of",
  "member.removed": "removed the member",
  "invite.created": "created an invite",
  "invite.revoked": "revoked an invite",
  "invite.accepted": "joined with an invite",
  "token.created": "created an access token",
  "token.revoked": "revoked an access token",
  "user.sign_in": "signed in",
  "user.password_changed": "changed their password",
  "device.paired": "paired a device",
  "device.pairing_claimed": "started pairing a device",
  "device.removed": "removed a device",
  "org.created": "created the organisation",
  "instance.setup": "set up this instance",
};
const SELF = new Set(["user.sign_in", "user.password_changed", "instance.setup", "invite.accepted"]);

function detailText(e: AuditEntryDto): string {
  const d = e.detail;
  const parts: string[] = [];
  if (typeof d.from === "string" && typeof d.to === "string") parts.push(`${d.from} → ${d.to}`);
  for (const key of ["role", "key", "taskType", "module", "template", "method", "name", "email"]) {
    if (key === "role" && typeof d.from === "string") continue;
    if (typeof d[key] === "string" && d[key]) parts.push(`${key === "taskType" ? "workflow" : key}: ${d[key] as string}`);
  }
  if (Array.isArray(d.scopes)) parts.push(`scopes: ${d.scopes.join(", ")}`);
  return parts.join(" · ");
}

function Audit() {
  const [area, setArea] = useState("");
  const audit = useInfiniteQuery({
    queryKey: ["audit", area],
    queryFn: ({ pageParam }) => api.audit({ ...(area ? { area } : {}), ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const entries = audit.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <div className="flex flex-col gap-4">
      <Segmented label="Filter the audit trail" value={area} onChange={setArea} options={AREAS} />
      <ErrorNote error={audit.error} />
      {audit.isLoading ? <p className="text-muted">Loading…</p> : null}
      {entries.length ? (
        <Card className="overflow-hidden">
          <ol className="m-0 list-none p-0">
            {entries.map((e) => {
              const extra = detailText(e);
              return (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-line-soft px-4 py-2.5 text-[13px] first:border-t-0">
                  <span className="min-w-0 flex-1 basis-[280px]">
                    <strong>{e.actor?.name ?? "Someone"}</strong> {ACTIONS[e.action] ?? e.action.replace(/[._]/g, " ")}
                    {e.targetName && !SELF.has(e.action) ? <strong> {e.targetName}</strong> : null}
                    {extra ? <span className="text-muted"> · {extra}</span> : null}
                  </span>
                  <code className="font-mono text-[11px] text-muted">{e.action}</code>
                  <time dateTime={e.at} className="w-[150px] shrink-0 text-right text-xs text-muted">
                    {new Date(e.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                  </time>
                </li>
              );
            })}
          </ol>
        </Card>
      ) : audit.isLoading ? null : (
        <Empty title="Nothing recorded here yet">Sign-ins, task starts, approvals and every change to connections, workspaces and members are kept here.</Empty>
      )}
      {audit.hasNextPage ? (
        <Button className="self-center" disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
          {audit.isFetchingNextPage ? "Loading…" : "Show older"}
        </Button>
      ) : null}
    </div>
  );
}

/** Spend, reliability and the audit trail across every workspace: the control plane's view of itself. */
export function InsightsPage() {
  const canAudit = useCan("org:manage");
  const [tab, setTab] = useState<Tab>("spend");
  const [period, setPeriod] = useState<Period>("30");
  return (
    <main className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        title="Insights"
        subtitle="What every connected system did and cost, across all your workspaces."
        actions={
          tab === "spend" ? (
            <Segmented
              label="Period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
              ]}
            />
          ) : null
        }
      />
      {canAudit ? (
        <div role="tablist" aria-label="Insights sections" className="flex gap-6 border-b border-line">
          {(
            [
              ["spend", "Spend and reliability"],
              ["audit", "Audit trail"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cx("-mb-px border-b-2 px-0.5 py-2.5 text-sm", tab === value ? "border-accent font-semibold text-accent-ink" : "border-transparent text-ink-2 hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {tab === "spend" ? <Spend days={Number(period)} /> : <Audit />}
    </main>
  );
}

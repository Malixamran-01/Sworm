import type { InboxItemDto } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { ago } from "../../lib/format";
import { initials, paletteFor } from "../../lib/palette";
import { Button, cx, Empty, PageHeader, Tile } from "../../ui";
import { ApprovalPanel, useDecide } from "./ApprovalActions";

type Filter = "all" | "needs" | "done" | "problems";

const isNeeds = (i: InboxItemDto) => i.kind === "approval" && !i.resolved;
const isProblem = (i: InboxItemDto) => i.kind === "problem" || i.kind === "budget";

function Row({ item, first }: { item: InboxItemDto; first: boolean }) {
  const qc = useQueryClient();
  const [changing, setChanging] = useState(false);
  const canDecide = useCan("approval:decide");
  const decide = useDecide(item.approvalId ?? "", item.runId);
  const read = useMutation({ mutationFn: () => api.markRead(item.id), onSuccess: () => void qc.invalidateQueries({ queryKey: ["inbox"] }) });
  const taskLink = item.runId && item.workspaceId ? `/workspaces/${item.workspaceId}/tasks/${item.runId}` : null;
  const unread = !item.readAt && !item.resolved;
  const metaTone = item.kind === "problem" ? "text-bad" : item.kind === "budget" ? "text-warn-ink" : "text-muted";
  const openLink = (label: string, to: string | null) =>
    to ? (
      <Link
        to={to}
        onClick={() => unread && read.mutate()}
        className="flex h-[34px] items-center rounded-lg border border-line-strong px-3 text-[13px] font-semibold text-ink no-underline hover:bg-sunken"
      >
        {label}
      </Link>
    ) : null;

  return (
    <div role="listitem" className={cx("flex flex-col gap-3 px-[18px] py-3.5", !first && "border-t border-line-soft", item.resolved && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-3.5">
        <span className={cx("h-2 w-2 shrink-0 rounded-full", unread ? "bg-accent" : "bg-transparent")} aria-hidden />
        {unread ? <span className="sr-only">Unread: </span> : null}
        <Tile text={initials(item.workspaceName ?? "?", 1)} palette={paletteFor(item.workspaceId ?? "")} size={30} />
        <span className="flex min-w-[240px] flex-1 flex-col gap-0.5">
          <span className="text-sm font-semibold">{item.title}</span>
          <span className={cx("text-xs", metaTone)}>
            {item.path || item.workspaceName} · {ago(item.createdAt)}
          </span>
        </span>
        {isNeeds(item) && item.approvalId && canDecide ? (
          <>
            {openLink("Open", taskLink)}
            <Button size="sm" className="!h-[34px]" onClick={() => setChanging((c) => !c)} aria-expanded={changing}>
              Changes
            </Button>
            <Button variant="success" size="sm" className="!h-[34px]" disabled={decide.isPending} onClick={() => decide.mutate({ decision: "approve" })}>
              Approve
            </Button>
          </>
        ) : item.kind === "budget" ? (
          openLink("Adjust", item.workspaceId ? `/workspaces/${item.workspaceId}/team` : null)
        ) : (
          openLink("Open", taskLink)
        )}
      </div>
      {isNeeds(item) && item.body ? <p className="output-text m-0 ml-[60px] line-clamp-4 rounded-[10px] bg-sunken p-3 text-ink-2">{item.body}</p> : null}
      {changing && item.approvalId ? (
        <div className="ml-[60px]">
          <ApprovalPanel approvalId={item.approvalId} runId={item.runId} layout="row" />
        </div>
      ) : null}
    </div>
  );
}

export function InboxPage() {
  const qc = useQueryClient();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: api.inbox });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const [filter, setFilter] = useState<Filter>("all");
  const [ws, setWs] = useState("");
  const all = (inbox.data ?? []).filter((i) => !ws || i.workspaceId === ws);
  const counts = { all: all.length, needs: all.filter(isNeeds).length, done: all.filter((i) => i.kind === "result").length, problems: all.filter(isProblem).length };
  const items = all.filter((i) => filter === "all" || (filter === "needs" ? isNeeds(i) : filter === "done" ? i.kind === "result" : isProblem(i)));
  const unread = all.filter((i) => !i.readAt && !i.resolved && i.kind !== "approval");
  const markAll = useMutation({
    mutationFn: () => Promise.all(unread.map((i) => api.markRead(i.id))),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["inbox"] }),
  });

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "needs", label: "Needs you" },
    { key: "done", label: "Done" },
    { key: "problems", label: "Problems" },
  ];

  return (
    <main className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-4 py-5 md:px-9 md:py-7">
      <PageHeader
        title="Inbox"
        actions={
          <>
            <label htmlFor="inbox-ws" className="sr-only">
              Workspace
            </label>
            <select id="inbox-ws" value={ws} onChange={(e) => setWs(e.target.value)} className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink">
              <option value="">All workspaces</option>
              {workspaces.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <Button disabled={unread.length === 0 || markAll.isPending} onClick={() => markAll.mutate()}>
              Mark all read
            </Button>
          </>
        }
      />
      <nav aria-label="Filter" className="flex gap-6 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-current={filter === t.key ? "page" : undefined}
            onClick={() => setFilter(t.key)}
            className={cx(
              "-mb-px border-b-2 px-0.5 py-2.5 text-sm",
              filter === t.key ? "border-accent font-semibold text-accent-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {t.label} {counts[t.key]}
          </button>
        ))}
      </nav>
      {items.length > 0 ? (
        <div role="list" className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {items.map((i, n) => (
            <Row key={i.id} item={i} first={n === 0} />
          ))}
        </div>
      ) : (
        <Empty title="Nothing here">Approvals, results and problems show up here as soon as they happen.</Empty>
      )}
    </main>
  );
}

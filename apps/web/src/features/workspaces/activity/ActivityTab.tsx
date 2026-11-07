import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../../../lib/api";
import { clock, money } from "../../../lib/format";
import { Empty, StatusPill } from "../../../ui";
import { useWorkspace } from "../WorkspaceLayout";

export function ActivityTab() {
  const { workspaceId } = useWorkspace();
  const tasks = useQuery({ queryKey: ["tasks", workspaceId], queryFn: () => api.tasks(workspaceId) });
  const rows = tasks.data ?? [];

  return (
    <main className="flex flex-col gap-4 px-4 py-5 md:px-8 md:py-6">
      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
          <table className="w-full min-w-[720px] border-collapse text-[13px]">
            <thead>
              <tr className="bg-surface-2 text-left text-xs text-muted">
                <th className="px-4 py-3 font-semibold">Task</th>
                <th className="px-2 py-3 font-semibold">Status</th>
                <th className="px-2 py-3 font-semibold">Steps</th>
                <th className="px-2 py-3 text-right font-semibold">Cost</th>
                <th className="px-2 py-3 text-right font-semibold">Limit</th>
                <th className="px-4 py-3 text-right font-semibold">Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-t border-line-soft">
                  <td className="max-w-[320px] truncate px-4 py-3">
                    <Link to={`/workspaces/${workspaceId}/tasks/${t.id}`} className="font-semibold text-ink no-underline hover:underline">
                      {t.title}
                    </Link>
                  </td>
                  <td className="px-2 py-3">
                    <StatusPill status={t.status} />
                  </td>
                  <td className="px-2 py-3 text-muted">
                    {t.stepsDone} of {t.stepsTotal}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums">{money(t.costUsd)}</td>
                  <td className="px-2 py-3 text-right text-muted tabular-nums">{money(t.budgetUsd)}</td>
                  <td className="px-4 py-3 text-right text-muted">{clock(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No activity yet">Every task this workspace runs is listed here with its cost.</Empty>
      )}
    </main>
  );
}

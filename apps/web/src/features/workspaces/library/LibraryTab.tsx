import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../../../lib/api";
import { clock, money } from "../../../lib/format";
import { Card, Empty } from "../../../ui";
import { useWorkspace } from "../WorkspaceLayout";

export function LibraryTab() {
  const { workspaceId } = useWorkspace();
  const tasks = useQuery({ queryKey: ["tasks", workspaceId], queryFn: () => api.tasks(workspaceId) });
  const done = tasks.data?.filter((t) => t.status === "succeeded") ?? [];

  return (
    <main className="flex flex-col gap-4 px-4 py-5 md:px-8 md:py-6">
      <p className="m-0 text-sm text-muted">Every approved result, linked to the task that made it.</p>
      {done.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {done.map((t) => (
            <Link key={t.id} to={`/workspaces/${workspaceId}/tasks/${t.id}`} className="no-underline">
              <Card as="article" className="flex h-full flex-col gap-2 p-4 text-ink hover:border-line-strong">
                <span className="text-xs text-muted">{t.taskTypeName}</span>
                <span className="text-sm font-semibold">{t.title}</span>
                <span className="mt-auto flex justify-between pt-2 text-xs text-muted">
                  <span>{clock(t.finishedAt)}</span>
                  <span>{money(t.costUsd)}</span>
                </span>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="No outputs yet">Approved results are saved here.</Empty>
      )}
    </main>
  );
}

import { useMutation } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { clock } from "../../../lib/format";
import { Button, Card, ErrorNote } from "../../../ui";
import { BudgetCard } from "../team/TeamTab";
import { useWorkspace } from "../WorkspaceLayout";

export function SettingsTab() {
  const { workspaceId, ws } = useWorkspace();
  const exportPkg = useMutation({
    mutationFn: () => api.exportWorkspace(workspaceId),
    onSuccess: (pkg) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${ws.data?.name.replace(/\W+/g, "-").toLowerCase() ?? "workspace"}.conclave.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  if (!ws.data) return null;

  return (
    <main className="grid max-w-[1040px] gap-4 px-8 py-6 lg:grid-cols-2">
      <BudgetCard ws={ws.data} />
      <Card as="section" className="flex flex-col gap-3 p-[18px]">
        <h2 className="m-0 text-[15px] font-semibold">Export</h2>
        <p className="m-0 text-[13px] text-muted">Download this workspace as a portable package: roles, task types and workflows, with no keys or secrets.</p>
        <ErrorNote error={exportPkg.error} />
        <Button className="self-start" onClick={() => exportPkg.mutate()} disabled={exportPkg.isPending}>
          Download package
        </Button>
      </Card>
      <Card as="section" className="flex flex-col gap-2 p-[18px]">
        <h2 className="m-0 text-[15px] font-semibold">About</h2>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="text-muted">Template</dt>
          <dd className="m-0">{ws.data.templateKey ?? "None"}</dd>
          <dt className="text-muted">Version</dt>
          <dd className="m-0">{ws.data.version} (every change to roles or budget makes a new one)</dd>
          <dt className="text-muted">Created</dt>
          <dd className="m-0">{clock(ws.data.createdAt)}</dd>
        </dl>
      </Card>
    </main>
  );
}

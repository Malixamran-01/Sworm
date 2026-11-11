import type { PolicyEffect, PolicyRuleDto, WorkspaceDetailDto } from "@conclave/contract";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useWorkspaceCan } from "../../../lib/auth";
import { moduleLook } from "../../../lib/palette";
import { Card, cx, ErrorNote, Pill, Tile } from "../../../ui";

const CHOICES: { value: PolicyEffect; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask first" },
  { value: "deny", label: "Never" },
];
const STRICT: Record<PolicyEffect, number> = { allow: 0, ask: 1, deny: 2 };

function Choice({ label, value, locked, disabled, onChange }: { label: string; value: PolicyEffect; locked: PolicyEffect | null; disabled: boolean; onChange: (v: PolicyEffect) => void }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 overflow-hidden rounded-lg border border-line-strong">
      {CHOICES.map((c) => {
        // A choice looser than the organisation's rule would do nothing, so it is not offered.
        const blocked = locked !== null && STRICT[c.value] < STRICT[locked];
        return (
          <button
            key={c.value}
            type="button"
            aria-pressed={value === c.value}
            disabled={disabled || blocked}
            onClick={() => onChange(c.value)}
            className={cx(
              "h-8 border-l border-line-strong px-2.5 text-xs first:border-l-0 disabled:cursor-not-allowed disabled:opacity-50",
              value === c.value ? (c.value === "deny" ? "bg-bad-soft font-semibold text-bad" : c.value === "ask" ? "bg-warn-soft font-semibold text-warn-ink" : "bg-good-soft font-semibold text-good") : "bg-surface text-ink-2 hover:bg-sunken",
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/** What this workspace's tasks may use (SRS 4.12): each connection, and each tool, is allowed, needs a person first, or is never used. */
export function PoliciesCard({ ws }: { ws: WorkspaceDetailDto }) {
  const qc = useQueryClient();
  const canEdit = useWorkspaceCan(ws, "workspace:edit");
  const key = ["policies", ws.id];
  const policies = useQuery({ queryKey: key, queryFn: () => api.workspacePolicies(ws.id) });
  const withTools = policies.data?.connections.filter((c) => c.tools.length) ?? [];
  const toolLists = useQueries({ queries: withTools.map((c) => ({ queryKey: ["tools", c.id], queryFn: () => api.tools(c.id) })) });
  const set = useMutation({
    mutationFn: (body: { connectionId: string; tool?: string | null; effect: PolicyEffect | "default" }) => api.setWorkspacePolicy(ws.id, body),
    onSuccess: (data) => qc.setQueryData(key, data),
  });

  const rules = policies.data?.rules ?? [];
  const find = (scope: PolicyRuleDto["scope"], connectionId: string, tool: string | null) => rules.find((r) => r.scope === scope && r.connectionId === connectionId && r.tool === tool);
  const sensitive = (connectionId: string, tool: string) => {
    const i = withTools.findIndex((c) => c.id === connectionId);
    return toolLists[i]?.data?.find((t) => t.name === tool)?.sensitive === true;
  };

  return (
    <Card as="section" className="flex flex-col gap-3 p-[18px] lg:col-span-2">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px] font-semibold">What this workspace may use</h2>
        <p className="m-0 text-[13px] text-muted">
          These limits are checked before a step runs and before any money is held. They also follow the work: a task this workspace starts in another workspace keeps them, so handing
          work on never gives it more than you had.
        </p>
      </div>
      <ErrorNote error={policies.error ?? set.error} />
      {policies.data?.connections.length === 0 ? <p className="m-0 text-[13px] text-muted">No role here has a node yet. Choose nodes in Team, and they show up here.</p> : null}
      <ul className="m-0 flex list-none flex-col gap-0 p-0">
        {policies.data?.connections.map((c) => {
          const look = moduleLook(c.moduleId, c.name);
          const own = find("workspace", c.id, null);
          const org = find("org", c.id, null);
          return (
            <li key={c.id} className="flex flex-col gap-2 border-t border-line-soft py-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <Tile text={look.short} palette={look.palette} size={30} />
                <span className="flex min-w-[160px] flex-1 flex-col">
                  <span className="text-[13px] font-semibold">{c.name}</span>
                  <span className="text-xs text-muted">Used by {c.roles.join(", ")}</span>
                </span>
                {org && org.effect !== "allow" ? <Pill tone={org.effect === "deny" ? "bad" : "warn"}>Organisation: {org.effect === "deny" ? "never" : "ask first"}</Pill> : null}
                <Choice
                  label={`Rule for ${c.name}`}
                  value={org && STRICT[org.effect] > STRICT[own?.effect ?? "allow"] ? org.effect : (own?.effect ?? "allow")}
                  locked={org?.effect ?? null}
                  disabled={!canEdit || set.isPending}
                  onChange={(effect) => set.mutate({ connectionId: c.id, effect: effect === "allow" ? "default" : effect })}
                />
              </div>
              {c.tools.map((tool) => {
                const writes = sensitive(c.id, tool);
                const natural: PolicyEffect = writes ? "ask" : "allow";
                const rule = find("workspace", c.id, tool);
                const orgTool = find("org", c.id, tool) ?? org;
                const mine = rule?.effect ?? natural;
                return (
                  <div key={tool} className="ml-10 flex flex-wrap items-center gap-2.5">
                    <span className="flex min-w-[160px] flex-1 flex-col">
                      <span className="text-[13px]">
                        Tool <code className="font-mono text-xs">{tool}</code>
                      </span>
                      <span className="text-xs text-muted">
                        {writes
                          ? rule?.effect === "allow"
                            ? "Can change things outside Conclave. Reviewed: it runs without asking."
                            : "Can change things outside Conclave, so it needs an approval step before it."
                          : "Read-only, as far as its server says."}
                      </span>
                    </span>
                    <Choice
                      label={`Rule for the tool ${tool}`}
                      value={orgTool && STRICT[orgTool.effect] > STRICT[mine] ? orgTool.effect : mine}
                      locked={orgTool?.effect ?? null}
                      disabled={!canEdit || set.isPending}
                      onChange={(effect) => set.mutate({ connectionId: c.id, tool, effect: effect === natural ? "default" : effect })}
                    />
                  </div>
                );
              })}
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-xs text-muted">
        <strong>Ask first</strong> means a person must have approved an earlier step of the same task. <strong>Never</strong> stops the step with the reason, in the task and in its
        trace.
      </p>
    </Card>
  );
}

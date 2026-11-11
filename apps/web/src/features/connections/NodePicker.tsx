import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { cx, Select } from "../../ui";

export interface NodeValue {
  connectionId: string | null;
  model: string | null;
}

/** Pick the node that fills a role: a connection, then one of its models. */
export function NodePicker({
  value,
  onChange,
  idPrefix,
  compact,
  port = "model@1",
}: {
  value: NodeValue;
  onChange: (v: NodeValue) => void;
  idPrefix: string;
  compact?: boolean;
  /** The role's port decides which connections fit and what to pick second: a model, tool, agent skill or workflow. */
  port?: string;
}) {
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const modules = useQuery({ queryKey: ["modules"], queryFn: api.modules, staleTime: Infinity });
  const kind = port.split("@")[0] as "model" | "tool" | "agent" | "workflow" | "knowledge";
  const noun = { model: "model", tool: "tool", agent: "skill", workflow: "workflow", knowledge: "source" }[kind] ?? "model";
  // A dock's connection lists the ports its module said it provides; others, their module's.
  const fits = (c: { moduleId: string; ports?: string[] }) =>
    (c.ports ?? modules.data?.find((m) => m.id === c.moduleId)?.ports ?? [port]).some((p) => p.split("@")[0] === kind);
  const describe = (id: string, text?: string) => (text ? `${id}: ${text.slice(0, 60)}` : id);
  const models = useQuery({
    queryKey: [`${kind}-list`, value.connectionId],
    queryFn: async (): Promise<{ id: string; displayName?: string; pricing?: { inputPerMTok: number; outputPerMTok: number } }[]> => {
      const id = value.connectionId!;
      if (kind === "tool") return (await api.tools(id)).map((t) => ({ id: t.name, displayName: describe(t.name, t.description) }));
      if (kind === "knowledge") return (await api.sources(id)).map((s) => ({ id: s.id, displayName: describe(s.name ?? s.id, s.description) }));
      if (kind === "agent") return (await api.skills(id)).map((s) => ({ id: s.id, displayName: describe(s.name ?? s.id, s.description) }));
      if (kind === "workflow") return (await api.workflows(id)).map((w) => ({ id: w.id, displayName: describe(w.name ?? w.id, w.description) }));
      return api.models(id);
    },
    enabled: !!value.connectionId,
    staleTime: 5 * 60_000,
  });
  const size = compact ? "!h-[34px] text-[13px] font-semibold" : "";

  return (
    <div className="grid grid-cols-2 gap-2">
      <Select
        id={`${idPrefix}-connection`}
        aria-label="Connection"
        className={size}
        value={value.connectionId ?? ""}
        onChange={(e) => onChange({ connectionId: e.target.value || null, model: null })}
      >
        <option value="">No connection</option>
        {connections.data?.filter((c) => fits(c) || c.id === value.connectionId).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select
        id={`${idPrefix}-model`}
        aria-label={noun.replace(/^./, (c) => c.toUpperCase())}
        className={cx(size)}
        value={value.model ?? ""}
        disabled={!value.connectionId || models.isLoading}
        onChange={(e) => onChange({ ...value, model: e.target.value || null })}
      >
        <option value="">{models.isLoading ? "Loading…" : models.isError ? `Could not list ${noun}s` : `Choose a ${noun}`}</option>
        {models.data?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName ?? m.id}
            {m.pricing ? ` · $${m.pricing.inputPerMTok}/$${m.pricing.outputPerMTok} per 1M` : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}

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
  /** The role's port decides which connections fit and what to pick second: a model or a tool. */
  port?: string;
}) {
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const modules = useQuery({ queryKey: ["modules"], queryFn: api.modules, staleTime: Infinity });
  const isTool = port.startsWith("tool@");
  const fits = (moduleId: string) => !modules.data || modules.data.find((m) => m.id === moduleId)?.ports.some((p) => p.split("@")[0] === port.split("@")[0]);
  const models = useQuery({
    queryKey: [isTool ? "tools" : "models", value.connectionId],
    queryFn: async () =>
      isTool
        ? (await api.tools(value.connectionId!)).map((t) => ({ id: t.name, displayName: t.description ? `${t.name}: ${t.description.slice(0, 60)}` : t.name, pricing: undefined }))
        : api.models(value.connectionId!),
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
        {connections.data?.filter((c) => fits(c.moduleId) || c.id === value.connectionId).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select
        id={`${idPrefix}-model`}
        aria-label={isTool ? "Tool" : "Model"}
        className={cx(size)}
        value={value.model ?? ""}
        disabled={!value.connectionId || models.isLoading}
        onChange={(e) => onChange({ ...value, model: e.target.value || null })}
      >
        <option value="">{models.isLoading ? "Loading…" : models.isError ? `Could not list ${isTool ? "tools" : "models"}` : isTool ? "Choose a tool" : "Choose a model"}</option>
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

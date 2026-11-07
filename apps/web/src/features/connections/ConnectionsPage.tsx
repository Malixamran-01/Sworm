import type { ConnectionDto, ConnectionTestDto, ModuleDto } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { money } from "../../lib/format";
import { moduleLook, PORT_GROUPS } from "../../lib/palette";
import { Button, Card, cx, ErrorNote, Field, Input, PageHeader, Select, StatusPill, Tile } from "../../ui";

const DISABLED = "Disabled by the kill switch.";
const portOf = (m: ModuleDto | undefined) => m?.ports[0]?.split("@")[0] ?? "tool";

function ConnectionCard({ c, mod }: { c: ConnectionDto; mod: ModuleDto | undefined }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["connections"] });
  const off = c.statusDetail === DISABLED;
  const test = useMutation({ mutationFn: () => api.testConnection(c.id), onSettled: refresh });
  const toggle = useMutation({ mutationFn: () => api.setConnectionDisabled(c.id, !off), onSettled: refresh });
  const remove = useMutation({ mutationFn: () => api.deleteConnection(c.id), onSettled: refresh });
  const look = moduleLook(c.moduleId, mod?.name ?? c.name);
  const border = off ? "" : c.status === "rate_limited" ? "!border-warn-line" : c.status === "signed_out" || c.status === "unreachable" ? "!border-bad-line" : "";

  return (
    <Card as="article" className={cx("flex flex-col gap-2 p-3.5", border)}>
      <div className="flex items-center gap-2.5">
        <Tile text={look.short} palette={look.palette} size={32} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{c.name}</span>
        <StatusPill status={off ? "off" : c.status} />
      </div>
      <span className="text-xs text-muted">{c.usedBy.length ? c.usedBy.map((u) => u.workspaceName).join(", ") : "Not used by a workspace yet"}</span>
      {c.statusDetail && !off && c.status !== "working" ? <span className="text-xs text-bad">{c.statusDetail}</span> : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">
          {money(c.monthSpendUsd)} <span className="font-normal text-muted">this month</span>
        </span>
        {c.spendLimitUsd !== null ? <span className="text-xs text-muted">limit {money(c.spendLimitUsd)}</span> : null}
      </div>
      <div className="mt-1 flex gap-3 border-t border-line-soft pt-2 text-xs font-semibold">
        <button type="button" className="text-accent-ink hover:underline disabled:opacity-50" disabled={test.isPending || off} onClick={() => test.mutate()}>
          {test.isPending ? "Testing…" : "Test"}
        </button>
        <button type="button" className="text-ink-2 hover:underline disabled:opacity-50" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {off ? "Turn on" : "Turn off"}
        </button>
        <button
          type="button"
          className="ml-auto text-bad hover:underline"
          onClick={() => {
            if (confirm(`Delete ${c.name}? Roles that use it will have no node.`)) remove.mutate();
          }}
        >
          Delete
        </button>
      </div>
    </Card>
  );
}

function AddConnection({ modules, focusRef }: { modules: ModuleDto[]; focusRef: React.RefObject<HTMLInputElement | null> }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const groups = [...new Set(modules.map(portOf))];
  const visible = modules.filter((m) => (!group || portOf(m) === group) && `${m.name} ${m.description} ${m.id}`.toLowerCase().includes(search.toLowerCase()));
  const [moduleId, setModuleId] = useState<string>("");
  const mod = modules.find((m) => m.id === moduleId);
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState("");
  const [result, setResult] = useState<ConnectionTestDto | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const conn = await api.createConnection({
        moduleId,
        name: name.trim() || mod!.name,
        values,
        ...(limit ? { spendLimitUsd: Number(limit.replace(/[^0-9.]/g, "")) } : {}),
      });
      return api.testConnection(conn.id);
    },
    onSuccess: (test) => {
      setResult(test);
      void qc.invalidateQueries({ queryKey: ["connections"] });
      if (test.ok) {
        setModuleId("");
        setName("");
        setValues({});
        setLimit("");
      }
    },
  });

  return (
    <aside aria-label="Add a connection" className="flex max-w-[380px] flex-[1_1_300px] flex-col gap-4 self-stretch border-l border-line bg-surface px-6 py-7">
      <h2 className="m-0 text-[17px] font-bold">Add a connection</h2>
      <label htmlFor="conn-search" className="sr-only">
        Search modules
      </label>
      <Input ref={focusRef} id="conn-search" type="search" placeholder="Search modules" value={search} onChange={(e) => setSearch(e.target.value)} className="!h-10 !rounded-[9px] text-[13px]" />
      <div className="flex flex-wrap gap-1.5">
        {[null, ...groups].map((g) => (
          <button
            key={g ?? "all"}
            type="button"
            aria-pressed={group === g}
            onClick={() => setGroup(g)}
            className={cx("rounded-full px-2.5 py-[5px] text-xs", group === g ? "bg-inverse font-semibold text-on-inverse" : "bg-line-soft text-ink hover:bg-line")}
          >
            {g ? (PORT_GROUPS[g] ?? g) : "All"}
          </button>
        ))}
      </div>
      <form
        className="flex flex-1 flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Service" htmlFor="conn-module">
          <Select
            id="conn-module"
            value={moduleId}
            onChange={(e) => {
              setModuleId(e.target.value);
              setValues({});
              setResult(null);
              setName(modules.find((m) => m.id === e.target.value)?.name ?? "");
            }}
            required
          >
            <option value="">Choose a service</option>
            {visible.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        {mod ? (
          <>
            <p className="m-0 -mt-2 text-xs text-muted">
              {mod.description} <span className="whitespace-nowrap">({mod.ports.join(", ")} · {mod.docks[0]} dock)</span>
            </p>
            <Field label="Name" htmlFor="conn-name">
              <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            {mod.configFields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`} help={f.help} htmlFor={`conn-${f.key}`}>
                <Input
                  id={`conn-${f.key}`}
                  type={f.type === "secret" ? "password" : f.type === "number" ? "number" : f.type === "url" ? "url" : "text"}
                  autoComplete="off"
                  step={f.type === "number" ? "any" : undefined}
                  placeholder={f.placeholder ?? (f.default !== undefined ? String(f.default) : f.type === "secret" ? "Paste key" : "")}
                  required={f.required}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className={f.type === "secret" ? "font-mono text-[13px]" : ""}
                />
              </Field>
            ))}
            <Field label="Monthly limit (optional)" htmlFor="conn-limit" help="New calls stop when this connection reaches it.">
              <Input id="conn-limit" inputMode="decimal" placeholder="$10" value={limit} onChange={(e) => setLimit(e.target.value)} />
            </Field>
            <p className="m-0 text-xs text-muted">Keys are encrypted at rest and never shown again, or shared when you publish.</p>
          </>
        ) : (
          <p className="m-0 text-[13px] text-muted">
            Any system joins through a module. The mock model needs no key and costs nothing, so it is a good first connection.
          </p>
        )}
        <ErrorNote error={save.error} />
        {result && !result.ok ? <ErrorNote error={new Error(`Saved, but the test failed: ${result.detail}`)} /> : null}
        {result?.ok ? <p className="m-0 text-[13px] font-semibold text-good">Connected. {result.detail}</p> : null}
        <div className="mt-auto flex gap-2">
          <Button type="submit" variant="primary" size="lg" disabled={!mod || save.isPending} className="flex-1 !rounded-[9px]">
            {save.isPending ? "Connecting…" : "Save and test"}
          </Button>
        </div>
      </form>
    </aside>
  );
}

export function ConnectionsPage() {
  const modules = useQuery({ queryKey: ["modules"], queryFn: api.modules });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const searchRef = useRef<HTMLInputElement>(null);
  const canManage = useCan("connection:manage");
  const byId = useMemo(() => new Map((modules.data ?? []).map((m) => [m.id, m])), [modules.data]);
  const groups = useMemo(() => {
    const map = new Map<string, ConnectionDto[]>();
    for (const c of connections.data ?? []) {
      const g = portOf(byId.get(c.moduleId));
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    if (!map.has("model")) map.set("model", []);
    return [...map.entries()];
  }, [connections.data, byId]);

  return (
    <div className="flex min-h-screen flex-wrap">
      <main className="flex min-w-0 flex-[999_1_520px] flex-col gap-5 px-4 py-5 md:px-9 md:py-7">
        <PageHeader title="Connections" subtitle="The models, agents and tools your workspaces can use. Keys are encrypted and never shared when you publish." />
        {groups.map(([group, list]) => (
          <section key={group} className="flex flex-col gap-2.5">
            <h2 className="m-0 text-sm font-semibold text-muted">
              {PORT_GROUPS[group] ?? group} · {list.length}
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {list.map((c) => (
                <ConnectionCard key={c.id} c={c} mod={byId.get(c.moduleId)} />
              ))}
              {canManage ? (<button
                type="button"
                onClick={() => searchRef.current?.focus()}
                className="min-h-[110px] rounded-[14px] border border-dashed border-line-dashed bg-transparent text-[13px] font-semibold text-ink-2 hover:border-accent hover:text-accent-ink"
              >
                + Add {group === "model" ? "a language model" : `a ${(PORT_GROUPS[group] ?? group).toLowerCase()} connection`}
              </button>) : null}
            </div>
          </section>
        ))}
        <p className="m-0 text-xs text-muted">
          Agents, workflow engines, knowledge sources and devices appear here as their modules are installed.
        </p>
      </main>
      {modules.data && canManage ? <AddConnection modules={modules.data} focusRef={searchRef} /> : null}
    </div>
  );
}

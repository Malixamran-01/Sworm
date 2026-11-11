import type { ModuleDto } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { plural } from "../../lib/format";
import { moduleLook } from "../../lib/palette";
import { Button, Card, ErrorNote, Pill, SectionTitle, Tile } from "../../ui";

/** What the file says it is and may do, read on the server without installing it. */
function Preview({ module, replaces, blocked }: { module: ModuleDto; replaces: string | null; blocked: string | null }) {
  const label = (key: string) => module.configFields.find((f) => f.key === key)?.label ?? key;
  const reach = module.permissions.egress.map((e) => {
    const m = /^\{config\.([A-Za-z0-9_]+)(\[\])?\}$/.exec(e);
    return m ? `the ${m[2] ? "hosts" : "host"} entered in “${label(m[1]!)}”` : e;
  });
  const look = moduleLook(module.id, module.name);
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface-2 p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <Tile text={look.short} palette={look.palette} size={30} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-semibold">
            {module.name} <span className="font-normal text-muted">{module.version}</span>
          </span>
          <code className="font-mono text-xs text-muted">{module.id}</code>
        </span>
        {replaces ? <Pill tone="warn">Replaces {replaces}</Pill> : <Pill tone="accent">New</Pill>}
      </div>
      {module.description ? <p className="m-0 text-ink-2">{module.description}</p> : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">Provides</dt>
        <dd className="m-0">{module.ports.map((p) => p.split("@")[0]).join(", ")}</dd>
        <dt className="text-muted">May reach</dt>
        <dd className="m-0">{reach.length ? reach.join(", ") : "nothing outside this server"}</dd>
        <dt className="text-muted">Secrets it reads</dt>
        <dd className="m-0">{module.permissions.secrets.length ? `${module.permissions.secrets.map(label).join(", ")}, of each connection only` : "none"}</dd>
        <dt className="text-muted">Settings</dt>
        <dd className="m-0">{module.configFields.length ? module.configFields.map((f) => f.label).join(", ") : "none"}</dd>
      </dl>
      {blocked ? <ErrorNote error={new Error(blocked)} /> : null}
    </div>
  );
}

/** Install a module from a file, and remove ones installed this way (MOD-002). Owners only, and only when the server allows it. */
export function InstallModule() {
  const qc = useQueryClient();
  const canInstall = useCan("org:manage");
  const uploads = useQuery({ queryKey: ["module-uploads"], queryFn: api.moduleUploads });
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["module-uploads"] });
    void qc.invalidateQueries({ queryKey: ["modules"] });
  };
  const inspect = useMutation({ mutationFn: (text: string) => api.inspectModule(text) });
  const install = useMutation({
    mutationFn: () => api.installModule(source!),
    onSuccess: () => {
      setSource(null);
      setFileName("");
      inspect.reset();
      if (input.current) input.current.value = "";
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.removeModule(id), onSuccess: refresh });

  const enabled = uploads.data?.enabled ?? false;
  const installed = uploads.data?.modules ?? [];
  // Nothing to show to people who cannot install, on a server with nothing installed.
  if (!uploads.data || (!installed.length && !canInstall)) return null;

  return (
    <Card as="section" className="flex flex-col gap-3 p-[18px]" aria-label="Modules installed from the app">
      <div className="flex flex-col gap-1">
        <SectionTitle count={installed.length || undefined}>Your own modules</SectionTitle>
        <p className="m-0 text-[13px] text-muted">
          A module teaches Conclave to use one more system. Install one from a file and it appears under “Add a connection” at once, with budgets, rules, traces and the audit
          trail already working.
        </p>
      </div>

      {installed.length ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {installed.map(({ module: m, connections }) => {
            const look = moduleLook(m.id, m.name);
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-2.5 border-t border-line-soft py-2.5 text-[13px] first:border-t-0 first:pt-0">
                <Tile text={look.short} palette={look.palette} size={30} />
                <span className="flex min-w-[160px] flex-1 flex-col">
                  <span className="font-semibold">
                    {m.name} <span className="font-normal text-muted">{m.version}</span>
                  </span>
                  <span className="text-xs text-muted">
                    {m.ports.map((p) => p.split("@")[0]).join(", ")} · {connections ? plural(connections, "connection") : "not connected yet"}
                  </span>
                </span>
                {canInstall && enabled ? (
                  <button
                    type="button"
                    className="text-xs font-semibold text-bad hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={connections > 0 || remove.isPending}
                    title={connections > 0 ? "Delete its connections first" : undefined}
                    onClick={() => {
                      if (confirm(`Remove ${m.name} from this server?`)) remove.mutate(m.id);
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <ErrorNote error={remove.error} />

      {canInstall && !enabled ? (
        <p className="m-0 rounded-[10px] border border-line-soft bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
          Installing from the app is turned off on this server. Its admin turns it on with <code className="font-mono text-xs">CONCLAVE_MODULE_UPLOADS=on</code>, or puts module
          files in the server’s modules folder.
        </p>
      ) : null}

      {canInstall && enabled ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="module-file" className="text-[13px] font-semibold">
              Module file
            </label>
            <input
              ref={input}
              id="module-file"
              type="file"
              accept=".mjs,.js,text/javascript,application/javascript"
              className="text-[13px] file:mr-3 file:h-9 file:rounded-[9px] file:border file:border-line-strong file:bg-surface file:px-3.5 file:text-[13px] file:font-semibold file:text-ink"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                install.reset();
                if (!file) {
                  setSource(null);
                  inspect.reset();
                  return;
                }
                const text = await file.text();
                setFileName(file.name);
                setSource(text);
                inspect.mutate(text);
              }}
            />
            <p className="m-0 text-xs text-muted">
              One JavaScript file whose default export is <code className="font-mono">{"{ manifest, create }"}</code>. Nothing is installed until you confirm below.
            </p>
          </div>

          {inspect.isPending ? <p className="m-0 text-[13px] text-muted">Reading {fileName}…</p> : null}
          <ErrorNote error={inspect.error ?? install.error} />
          {inspect.data && source ? (
            <>
              <Preview {...inspect.data} />
              <p className="m-0 text-xs text-muted">
                It will run on this server as its own process, without the server’s keys, and reach only what is listed above. That is a boundary, not a sandbox: install only code
                you trust.
              </p>
              <div className="flex gap-2">
                <Button variant="primary" disabled={!!inspect.data.blocked || install.isPending} onClick={() => install.mutate()}>
                  {install.isPending ? "Installing…" : inspect.data.replaces ? `Replace with ${inspect.data.module.version}` : `Install ${inspect.data.module.name}`}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSource(null);
                    inspect.reset();
                    if (input.current) input.current.value = "";
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : null}
          {install.isSuccess ? <p className="m-0 text-[13px] font-semibold text-good">Installed. Choose it under “Add a connection”.</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

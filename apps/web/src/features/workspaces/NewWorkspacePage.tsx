import type { BuilderAnswers, TemplateDto } from "@conclave/contract";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { money } from "../../lib/format";
import { initials } from "../../lib/palette";
import { Button, Card, ChipGroup, cx, ErrorNote, Field, Input, PageHeader, Segmented, Textarea, Tile } from "../../ui";
import { NodePicker, type NodeValue } from "../connections/NodePicker";

type Start = "guided" | "template" | "blank" | "import";
type Goal = BuilderAnswers["goal"];

const STARTS: { value: Start; label: string }[] = [
  { value: "guided", label: "Answer a few questions" },
  { value: "template", label: "From a template" },
  { value: "blank", label: "Blank" },
  { value: "import", label: "Import a package" },
];

const GOALS: { value: Goal; label: string }[] = [
  { value: "research", label: "Research a topic" },
  { value: "write", label: "Write things" },
  { value: "summarize", label: "Summarize text" },
  { value: "answer", label: "Answer questions" },
  { value: "custom", label: "Something else" },
];

const BLANK: BuilderAnswers = { goal: "custom", approval: false, check: false, search: false };

/** A package file shown the way the server would show it, before anything is sent. */
function packagePreview(pkg: unknown): TemplateDto | null {
  if (!pkg || typeof pkg !== "object") return null;
  const p = pkg as Partial<{ key: string; name: string; description: string; budget: TemplateDto["budget"]; roles: TemplateDto["roles"]; taskTypes: { key: string; name: string; workflow?: { steps?: { key: string; kind: "role" | "approval" | "tool"; title?: string; role?: string }[] } }[] }>;
  if (!Array.isArray(p.roles) || !Array.isArray(p.taskTypes)) return null;
  return {
    key: String(p.key ?? "custom"),
    name: String(p.name ?? "Imported workspace"),
    description: String(p.description ?? ""),
    budget: p.budget ?? { taskUsd: 1, monthUsd: 25 },
    roles: p.roles,
    taskTypes: p.taskTypes.map((t) => ({
      key: t.key,
      name: t.name,
      steps: (t.workflow?.steps ?? []).map((s) => ({
        key: s.key,
        kind: s.kind,
        label: s.kind === "approval" ? (s.title ?? s.key) : `${p.roles!.find((r) => r.key === s.role)?.name ?? s.role}: ${s.key.replace(/_/g, " ")}`,
      })),
    })),
  };
}

function Toggle({ id, checked, onChange, label, help }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; help: ReactNode }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
      <span className="flex flex-col">
        <span className="text-[13px] font-semibold">{label}</span>
        <span className="text-xs text-muted">{help}</span>
      </span>
    </label>
  );
}

export function NewWorkspacePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const templates = useQuery({ queryKey: ["templates"], queryFn: api.templates });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });

  const [start, setStart] = useState<Start>("guided");
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [answers, setAnswers] = useState<BuilderAnswers>({ goal: "research", approval: true, check: false, search: false });
  const [pkg, setPkg] = useState<{ fileName: string; data: unknown } | null>(null);
  const [pkgError, setPkgError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [node, setNode] = useState<NodeValue>({ connectionId: null, model: null });
  const [monthly, setMonthly] = useState("");

  const set = (patch: Partial<BuilderAnswers>) => setAnswers((a) => ({ ...a, ...patch }));
  // Typing in the free-text answers should not send a request per key.
  const deferredAnswers = useDeferredValue(answers);
  const composeFor = start === "guided" ? deferredAnswers : start === "blank" ? BLANK : null;
  const composed = useQuery({
    queryKey: ["compose", composeFor],
    queryFn: () => api.composeWorkspace(composeFor!),
    enabled: composeFor !== null,
    placeholderData: keepPreviousData,
  });

  const template: TemplateDto | undefined =
    start === "template"
      ? (templates.data?.find((t) => t.key === templateKey) ?? templates.data?.[0])
      : start === "import"
        ? (packagePreview(pkg?.data) ?? undefined)
        : composed.data;

  const nodeName = connections.data?.find((c) => c.id === node.connectionId)?.name;
  const shownName = name.trim() || (start === "blank" ? "Blank workspace" : template?.name) || "New workspace";
  const monthUsd = monthly ? Number(monthly.replace(/[^0-9.]/g, "")) : (template?.budget.monthUsd ?? 0);

  const create = useMutation({
    mutationFn: async () => {
      const common = { ...(name.trim() ? { name: name.trim() } : {}), defaultNode: node };
      const source =
        start === "template" ? { templateKey: template!.key } : start === "guided" ? { answers } : start === "blank" ? { blank: true } : { package: pkg!.data };
      const ws = await api.createWorkspace({ ...source, ...common });
      if (monthly && monthUsd > 0 && monthUsd !== ws.budgetMonthUsd) await api.updateBudget(ws.id, { monthUsd });
      return ws;
    },
    onSuccess: async (ws) => {
      await qc.invalidateQueries({ queryKey: ["workspaces"] });
      // A blank workspace opens straight in the node editor, to be built step by step.
      const blankKey = start === "blank" ? ws.taskTypes[0]?.key : undefined;
      void navigate({ to: blankKey ? `/workspaces/${ws.id}/workflows/${blankKey}` : `/workspaces/${ws.id}` });
    },
  });

  async function readPackage(file: File | undefined) {
    setPkg(null);
    setPkgError(null);
    if (!file) return;
    try {
      const data: unknown = JSON.parse(await file.text());
      if (!packagePreview(data)) throw new Error("no roles or task types");
      setPkg({ fileName: file.name, data });
    } catch {
      setPkgError(`${file.name} is not a workspace package. Export one from a workspace's Settings tab.`);
    }
  }

  const ready = !!template && !(start === "guided" && answers.goal === "custom" && !answers.customGoal?.trim());

  return (
    <div className="flex flex-wrap gap-6 md:gap-8 px-4 py-5 md:px-10 md:py-8">
      <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
        <PageHeader title="Create a workspace" subtitle="A workspace is a team of AI roles with one job. You can change everything later." />

        <Segmented label="How to start" value={start} onChange={setStart} options={STARTS} />

        {start === "guided" && (
          <Card as="section" aria-label="Questions" className="flex flex-col gap-4 rounded-2xl p-5">
            <Field label="What should this workspace do?">
              <ChipGroup label="Goal" value={answers.goal} onChange={(goal) => set({ goal })} options={GOALS} />
            </Field>
            {answers.goal === "custom" && (
              <Field label="Describe the job" htmlFor="ws-custom" help="This becomes the assistant's instructions. Plain words are fine.">
                <Textarea id="ws-custom" value={answers.customGoal ?? ""} maxLength={2000} placeholder="Turn meeting notes into action items with owners and dates." onChange={(e) => set({ customGoal: e.target.value })} />
              </Field>
            )}
            <Field label="Who are the results for?" htmlFor="ws-audience" help="Optional. Roles write with this reader in mind.">
              <Input id="ws-audience" value={answers.audience ?? ""} maxLength={200} placeholder="Our leadership team" onChange={(e) => set({ audience: e.target.value })} />
            </Field>
            <div className="flex flex-col gap-3">
              <Toggle id="ws-approval" checked={answers.approval ?? true} onChange={(approval) => set({ approval })} label="I approve results first" help="Each task waits in your inbox until you approve, ask for changes or reject." />
              <Toggle id="ws-check" checked={answers.check ?? false} onChange={(check) => set({ check })} label="Add a reviewer" help="A second role checks the work against the brief and fixes what is off." />
              {answers.goal !== "summarize" && (
                <Toggle
                  id="ws-search"
                  checked={answers.search ?? false}
                  onChange={(search) => set({ search })}
                  label="Search first"
                  help="Starts with a search tool from any MCP server. If none is connected, the step is skipped."
                />
              )}
            </div>
          </Card>
        )}

        {start === "template" && (
          <div role="radiogroup" aria-label="Template" className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {templates.data?.map((t) => {
              const on = template?.key === t.key;
              return (
                <label key={t.key} className={cx("flex cursor-pointer flex-col gap-1 rounded-[14px] bg-surface p-3.5", on ? "border-2 border-accent" : "border border-line-strong hover:border-accent")}>
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <input type="radio" name="template" checked={on} onChange={() => setTemplateKey(t.key)} className="accent-[var(--accent)]" />
                    {t.name}
                  </span>
                  <span className="text-xs text-muted">{t.description}</span>
                </label>
              );
            })}
          </div>
        )}

        {start === "blank" && (
          <p className="m-0 text-[13px] text-ink-2">One assistant role and one request type, with no approval step. It opens in the node editor, where you add steps, connect them, and call other workspaces.</p>
        )}

        {start === "import" && (
          <Field
            label="Workspace package"
            htmlFor="ws-package"
            help={pkg ? `${pkg.fileName} · roles start unfilled, and no connections or secrets come with it.` : "A .json file exported from a workspace's Settings tab."}
          >
            <input id="ws-package" type="file" accept="application/json,.json" onChange={(e) => void readPackage(e.target.files?.[0])} className="text-sm file:mr-3 file:h-9 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:text-[13px] file:font-semibold file:text-ink" />
          </Field>
        )}
        {pkgError && <ErrorNote error={new Error(pkgError)} />}

        <Card as="section" aria-label="Details" className="flex flex-col gap-4 rounded-2xl p-5">
          <Field label="Name" htmlFor="ws-name">
            <Input id="ws-name" value={name} placeholder={template?.name} onChange={(e) => setName(e.target.value)} className="!h-10 !rounded-[9px]" />
          </Field>

          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-semibold">
              Roles <span className="font-normal text-muted">· edit later in Team</span>
            </span>
            <div className="flex flex-wrap gap-2">
              {template?.roles.map((r) => (
                <span key={r.key} className="flex items-center gap-2 rounded-full bg-accent-tint px-3 py-1.5 text-[13px] font-semibold text-accent-ink" title={r.description}>
                  {r.name}
                  {r.port === "tool@1" ? " · tool" : node.model ? ` · ${nodeName ?? ""} ${node.model}` : ""}
                </span>
              ))}
            </div>
          </div>

          <Field
            label="Fill every model role with"
            htmlFor="ws-node-connection"
            help={
              connections.data?.length === 0 ? (
                <>
                  No connections yet. <Link to="/connections">Add one</Link>, or create the workspace now and fill roles in Team.
                </>
              ) : (
                "Roles call nodes through ports, so any model connection works. Give each role its own node later in Team."
              )
            }
          >
            <NodePicker idPrefix="ws-node" value={node} onChange={setNode} />
          </Field>

          <div className="flex flex-wrap items-center gap-2.5">
            <label htmlFor="ws-limit" className="text-[13px] font-semibold">
              Monthly limit
            </label>
            <Input id="ws-limit" inputMode="decimal" value={monthly} placeholder={template ? money(template.budget.monthUsd) : "$50"} onChange={(e) => setMonthly(e.target.value)} className="!w-[110px]" />
            <span className="text-[13px] text-muted">{template ? `${money(template.budget.taskUsd)} per task` : ""}</span>
          </div>
        </Card>

        <ErrorNote error={create.error ?? composed.error} />
        <div className="flex justify-end gap-2.5">
          <Link to="/" className="flex h-11 items-center rounded-[10px] px-4 text-sm font-semibold text-ink-2 no-underline hover:bg-line-soft">
            Cancel
          </Link>
          <Button variant="primary" size="lg" className="!h-11 !px-[22px]" disabled={!ready || create.isPending || (!!node.connectionId && !node.model)} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create workspace"}
          </Button>
        </div>
      </main>

      <aside aria-label="Preview" className="flex max-w-[400px] flex-[1_1_320px] flex-col gap-2.5">
        <span className="text-xs font-semibold text-muted">Preview</span>
        <Card className="overflow-hidden rounded-2xl">
          <div className="flex flex-col gap-3 border-b border-line-soft p-4">
            <div className="flex items-center gap-2.5">
              <Tile text={initials(shownName, 1)} palette="blue" size={36} />
              <span className="flex flex-col">
                <span className="text-[15px] font-bold">{shownName}</span>
                <span className="text-xs text-muted">
                  {template?.roles.length ?? 0} roles · {money(monthUsd)} a month
                </span>
              </span>
            </div>
            <div className="flex flex-wrap gap-3.5 text-xs">
              {["Tasks", "Team", "Workflows", "Library", "Activity", "Settings"].map((t, i) => (
                <span key={t} className={i === 0 ? "border-b-2 border-accent pb-1.5 font-semibold text-accent-ink" : "text-ink-2"}>
                  {t}
                </span>
              ))}
            </div>
          </div>
          {!template && <p className="m-0 p-4 text-[13px] text-muted">{start === "import" ? "Choose a package file to see what it contains." : "Loading…"}</p>}
          {template?.taskTypes.map((tt) => (
            <div key={tt.key} className="flex flex-col gap-2.5 p-4">
              <span className="text-xs font-semibold text-muted">Workflow for {tt.name.toLowerCase()}</span>
              <ol className="m-0 flex flex-col gap-1.5 pl-[18px] text-[13px] text-ink-2">
                {tt.steps.map((s) => (
                  <li key={s.key} className={s.kind === "approval" ? "font-semibold text-warn-ink" : ""}>
                    {s.kind === "approval" ? `${s.label}: asks you to approve` : s.label}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </Card>
      </aside>
    </div>
  );
}

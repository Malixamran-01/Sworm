import { edgesOf, needKey, renameStep, taskTypeTemplateSchema, wouldCycle, type Step, type StepKind } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../../../lib/api";
import { Button, ErrorNote, Pill } from "../../../../ui";
import { useWorkspace } from "../../WorkspaceLayout";
import { Canvas, type Selection } from "./Canvas";
import {
  connect,
  disconnect,
  draftFrom,
  makeStep,
  moveNode,
  bottomOf,
  freeSpot,
  NODE_W,
  nodeHeight,
  NOTE_W,
  newDraft,
  removeStep,
  replaceStep,
  setNeeds,
  newLoop,
  setLoop,
  setNotes,
  titleOf,
  updateEdge,
  type Draft,
} from "./graph";
import { StepPanel, TaskTypePanel } from "./Inspector";
import { AddMenu } from "./AddMenu";
import { ConnectorPanel, LoopPanel } from "./Logic";

interface History {
  /** Which task type this draft is for, so switching resets it. */
  for: string;
  draft: Draft;
  saved: string;
  past: Draft[];
  future: Draft[];
}

/** The node editor for one task type (WF-007): a canvas of steps, and a panel for the selected one. */
export function WorkflowEditor() {
  const { workspaceId, ws } = useWorkspace();
  const { key: routeKey } = useParams({ strict: false }) as { key: string };
  const isNew = routeKey === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const targets = useQuery({ queryKey: ["call-targets"], queryFn: api.callTargets });
  const [h, setH] = useState<History | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [reveal, setReveal] = useState<{ key: string; n: number } | null>(null);
  // Full screen hides the app and workspace chrome, so the canvas gets the whole window.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.getElementById("add-step-menu")) setFull(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [full]);

  const source = ws.data?.taskTypes.find((t) => t.key === routeKey);
  // Start (or restart) the draft when the task type changes.
  useEffect(() => {
    if (!ws.data || h?.for === routeKey) return;
    if (!isNew && !source) return;
    const draft = isNew ? newDraft(ws.data.roles, ws.data.taskTypes.map((t) => t.key)) : draftFrom(source!);
    setH({ for: routeKey, draft, saved: isNew ? "" : JSON.stringify(draft), past: [], future: [] });
    setSelected(null);
  }, [ws.data, routeKey, isNew, source, h?.for]);

  const draft = h?.draft;
  const dirty = !!h && JSON.stringify(h.draft) !== h.saved;

  const apply = useCallback((fn: (d: Draft) => Draft, record = true) => {
    setH((cur) => (cur ? { ...cur, draft: fn(cur.draft), ...(record ? { past: [...cur.past.slice(-60), cur.draft], future: [] } : {}) } : cur));
  }, []);
  const checkpoint = useCallback(() => setH((cur) => (cur ? { ...cur, past: [...cur.past.slice(-60), cur.draft], future: [] } : cur)), []);
  const undo = useCallback(
    () => setH((cur) => (cur && cur.past.length ? { ...cur, draft: cur.past.at(-1)!, past: cur.past.slice(0, -1), future: [cur.draft, ...cur.future] } : cur)),
    [],
  );
  const redo = useCallback(
    () => setH((cur) => (cur && cur.future.length ? { ...cur, draft: cur.future[0]!, past: [...cur.past, cur.draft], future: cur.future.slice(1) } : cur)),
    [],
  );

  // Ctrl+Z and Ctrl+Shift+Z, except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const body = draft ? { key: draft.key, name: draft.name, description: draft.description, inputFields: draft.inputFields, workflow: draft.workflow } : null;
  const issues = useMemo(() => {
    if (!body) return [];
    const parsed = taskTypeTemplateSchema.safeParse({ ...body, description: body.description ?? "" });
    if (parsed.success) return [];
    return [...new Set(parsed.error.issues.map((i) => plainIssue(i.path, i.message, body.workflow.steps)))].slice(0, 6);
  }, [body]);

  const save = useMutation({
    mutationFn: () => (isNew ? api.createTaskType(workspaceId, body!) : api.saveTaskType(workspaceId, routeKey, body!)),
    onSuccess: (next) => {
      qc.setQueryData(["workspace", workspaceId], next);
      void qc.invalidateQueries({ queryKey: ["call-targets"] });
      const tt = next.taskTypes.find((t) => t.key === body!.key);
      if (tt) {
        const fresh = draftFrom(tt);
        setH({ for: tt.key, draft: fresh, saved: JSON.stringify(fresh), past: [], future: [] });
      }
      if (body!.key !== routeKey) void navigate({ to: `/workspaces/${workspaceId}/workflows/${body!.key}`, replace: true });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteTaskType(workspaceId, routeKey),
    onSuccess: (next) => {
      qc.setQueryData(["workspace", workspaceId], next);
      setH((cur) => (cur ? { ...cur, saved: JSON.stringify(cur.draft) } : cur));
      void navigate({ to: `/workspaces/${workspaceId}/workflows` });
    },
  });

  if (!ws.data) return null;
  if (!isNew && !source && !h) {
    return (
      <main className="px-4 py-5 md:px-8">
        <ErrorNote error={new Error("This task type does not exist.")} />
      </main>
    );
  }
  if (!draft) return null;
  const w = ws.data;
  const roleOf = (key: string) => w.roles.find((r) => r.key === key);

  const describe = (s: Step): string => {
    if (s.kind === "approval") return "Asks a person";
    if (s.kind === "branch") return `${s.mode === "all" ? "Every" : "First"} match of ${s.cases.length} case${s.cases.length === 1 ? "" : "s"}`;
    if (s.kind === "merge") return s.mode === "first" ? "Whichever branch ran" : s.mode === "concat" ? "All inputs, joined" : "All inputs as JSON";
    if (s.kind === "text") return "Writes text, no model";
    if (s.kind === "stop") return s.outcome === "succeed" ? "Ends the task: done" : "Ends the task: failed";
    if (s.kind === "classify") return `${roleOf(s.role)?.name ?? "Choose a role"} picks a category`;
    if (s.kind === "workspace") {
      const self = s.workspace === "self" || s.workspace === w.id;
      const t = targets.data?.find((x) => x.workspaceId === (self ? w.id : s.workspace));
      const tt = self && s.taskType === draft.key ? { name: "itself" } : t?.taskTypes.find((x) => x.key === s.taskType);
      if (!s.taskType) return "Choose what to run";
      return `${self ? "" : `${t?.workspaceName ?? "Another workspace"} › `}${tt?.name ?? s.taskType}${s.until ? ` to ${s.until}` : ""}`;
    }
    return roleOf(s.role)?.name ?? "Choose a role";
  };
  const warnings = new Map<string, string>();
  for (const s of draft.workflow.steps) {
    if (s.disabled) continue;
    if (s.kind === "role" || s.kind === "tool" || s.kind === "lookup" || s.kind === "classify" || s.kind === "agent" || s.kind === "automation") {
      const r = roleOf(s.role);
      const pick: Record<string, string> = { "model@1": "model", "tool@1": "tool", "agent@1": "agent", "workflow@1": "workflow", "knowledge@1": "source" };
      if (!r) warnings.set(s.key, "choose a role");
      else if ((!r.connectionId || !r.model) && !s.optional) warnings.set(s.key, `${r.name} has no ${pick[r.port] ?? "node"} yet`);
    } else if (s.kind === "workspace" && !s.taskType) warnings.set(s.key, "choose what to run");
    else if (s.kind === "workspace" && (s.workspace === "self" || s.workspace === w.id) && s.taskType === draft.key && !s.until) {
      warnings.set(s.key, "it runs itself with no place to stop");
    }
  }

  const add = (kind: StepKind) => {
    const after = selected?.type === "step" ? selected.key : null;
    const step = makeStep(kind, draft.workflow, w.roles, after);
    const anchor = after ? draft.workflow.layout[after] : null;
    // Right of the step it follows, or under everything; moved down until it overlaps nothing.
    const start = anchor ? { x: anchor.x + NODE_W + 60, y: anchor.y } : { x: (draft.workflow.layout._brief?.x ?? 40) + NODE_W + 60, y: bottomOf(draft) + 40 };
    const pos = freeSpot(draft, start.x, start.y, NODE_W, nodeHeight(step));
    apply((d) => moveNode({ ...d, workflow: { ...d.workflow, steps: [...d.workflow.steps, step] } }, step.key, pos));
    setSelected({ type: "step", key: step.key });
    setReveal((r) => ({ key: step.key, n: (r?.n ?? 0) + 1 }));
  };
  const addNote = () => {
    const id = `n${Date.now().toString(36)}`;
    const pos = freeSpot(draft, draft.workflow.layout._brief?.x ?? 40, bottomOf(draft) + 40, NOTE_W, 120);
    apply((d) => setNotes(d, (ns) => [...ns, { id, ...pos, text: "" }]));
  };
  const deleteStep = (key: string) => {
    if (draft.workflow.steps.length === 1) return;
    apply((d) => removeStep(d, key));
    setSelected(null);
  };
  const step = selected?.type === "step" ? draft.workflow.steps.find((s) => s.key === selected.key) : undefined;
  const edge = selected?.type === "edge" ? edgesOf(draft.workflow).find((e) => e.from === selected.from && e.to === selected.to) : undefined;
  const looping = selected?.type === "loop" ? draft.workflow.steps.find((s) => s.key === selected.key && s.loop) : undefined;
  const canDelete = !isNew && w.taskTypes.length > 1;

  return (
    <main className={full ? "fixed inset-0 z-40 flex flex-col overflow-y-auto bg-bg" : "flex flex-1 flex-col"}>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line bg-surface px-4 py-3 md:px-8">
        <Link to={`/workspaces/${w.id}/workflows`} className="text-[13px] text-muted no-underline hover:text-ink">
          ← Workflows
        </Link>
        <h2 className="m-0 text-[15px] font-semibold">{draft.name || "Untitled"}</h2>
        {dirty ? <Pill tone="warn">Not saved</Pill> : <Pill>Saved · v{w.version}</Pill>}
        <span className="flex-1" />
        <AddMenu onAdd={add} onNote={addNote} after={selected?.type === "step" ? titleOf(draft.workflow.steps.find((s) => s.key === selected.key) ?? draft.workflow.steps[0]!) : null} />
        <Button size="sm" variant="ghost" onClick={undo} disabled={!h!.past.length} aria-keyshortcuts="Control+Z">
          Undo
        </Button>
        <Button size="sm" variant="ghost" onClick={redo} disabled={!h!.future.length} aria-keyshortcuts="Control+Shift+Z">
          Redo
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={full} onClick={() => setFull((f) => !f)}>
          {full ? "Exit full screen" : "Full screen"}
        </Button>
        <Button variant="primary" size="sm" disabled={!dirty || issues.length > 0 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : isNew ? "Create task type" : "Save"}
        </Button>
      </div>
      {issues.length || save.error ? (
        <div className="flex flex-col gap-2 border-b border-line bg-surface px-4 py-2.5 md:px-8">
          {issues.length ? (
            <div role="status" className="rounded-[10px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
              <p className="m-0 font-semibold">Fix before saving</p>
              <ul className="m-0 pl-4">
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ErrorNote error={save.error} />
        </div>
      ) : null}

      <div className={`flex flex-1 flex-col lg:min-h-[520px] lg:flex-none lg:flex-row ${full ? "lg:h-[calc(100vh-58px)]" : "lg:h-[calc(100vh-220px)]"}`}>
        <div className="h-[62vh] min-h-[420px] lg:h-auto lg:flex-1">
          <Canvas
            draft={draft}
            selected={selected}
            onSelect={setSelected}
            onMoveStart={checkpoint}
            onMove={(key, pos) => apply((d) => moveNode(d, key, pos), false)}
            onConnect={(from, to, opts) => {
              apply((d) => connect(d, from, to, opts));
              setSelected({ type: "edge", from, to });
            }}
            onNotes={(fn, record = true) => apply((d) => setNotes(d, fn), record)}
            onLoop={(from, to) => {
              const existing = draft.workflow.steps.find((s) => s.key === from)?.loop;
              apply((d) => setLoop(d, from, existing ? { ...existing, to } : newLoop(to)));
              setSelected({ type: "loop", key: from });
            }}
            onDelete={deleteStep}
            describe={describe}
            warnings={warnings}
            fitKey={`${h!.for}:${full}`}
            reveal={reveal}
          />
        </div>
        <aside aria-label={looping ? "Loop settings" : edge ? "Connector settings" : step ? `Settings for ${titleOf(step)}` : "Task type settings"} className="flex flex-col gap-4 border-t border-line bg-surface p-4 lg:w-[380px] lg:overflow-y-auto lg:border-t-0 lg:border-l">
          {looping ? (
            <LoopPanel
              key={`loop-${looping.key}`}
              draft={draft}
              step={looping}
              onChange={(loop) => {
                apply((d) => setLoop(d, looping.key, loop));
                if (!loop) setSelected({ type: "step", key: looping.key });
              }}
            />
          ) : edge ? (
            <ConnectorPanel
              key={`${edge.from}-${edge.to}`}
              draft={draft}
              edge={edge}
              onChange={(patch) => apply((d) => updateEdge(d, edge, patch))}
              onRemove={() => {
                apply((d) => disconnect(d, edge.from, edge.to));
                setSelected(null);
              }}
            />
          ) : step ? (
            <StepPanel
              key={step.key}
              draft={draft}
              step={step}
              ws={w}
              targets={targets.data ?? []}
              onChange={(next) => apply((d) => replaceStep(d, step.key, next))}
              onRename={(to) => {
                if (draft.workflow.steps.some((s) => s.key === to)) return `Another step is already called "${to}".`;
                apply((d) => ({ ...d, workflow: { ...renameStep(d.workflow, step.key, to), layout: Object.fromEntries(Object.entries(d.workflow.layout).map(([k, v]) => [k === step.key ? to : k, v])) } }));
                setSelected({ type: "step", key: to });
                return null;
              }}
              onNeeds={(needs) =>
                apply((d) => setNeeds(d, step.key, needs.filter((n) => !wouldCycle(d.workflow, needKey(n), step.key) || (step.needs ?? []).map(needKey).includes(needKey(n)))))
              }
              onDelete={() => deleteStep(step.key)}
              onSelectEdge={(from, to) => setSelected({ type: "edge", from, to })}
              onLoop={(loop) => apply((d) => setLoop(d, step.key, loop))}
              onSelectLoop={() => setSelected({ type: "loop", key: step.key })}
            />
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <h2 className="m-0 text-[15px] font-semibold">{selected?.type === "brief" ? "Brief" : "Task type"}</h2>
                <p className="m-0 text-xs text-muted">
                  Add steps with + Add. Drag from a step's right-hand dot to another step to say it runs after it, or use "Runs after" in a step's settings. Click a connector's label to
                  make it conditional (Only if, Otherwise), a failure path, or to give the next step an instruction.
                </p>
              </div>
              <TaskTypePanel draft={draft} onChange={(d) => apply(() => d)} />
              {canDelete ? (
                <div className="flex flex-col gap-1.5 border-t border-line pt-4">
                  <Button
                    variant="danger"
                    size="sm"
                    className="self-start"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete ${draft.name}? Past tasks stay in the history.`)) remove.mutate();
                    }}
                  >
                    Delete task type
                  </Button>
                  <ErrorNote error={remove.error} />
                </div>
              ) : null}
            </>
          )}
          {step ? <p className="m-0 text-xs text-muted">Changes apply to new tasks once you save. Tasks already running keep the workflow they started with.</p> : null}
        </aside>
      </div>
    </main>
  );
}

const FIELD_HINTS: Record<string, string> = {
  taskType: "choose a task type to run",
  role: "choose a role",
  key: "keys are lowercase letters, digits and underscores, starting with a letter",
  prompt: "write a prompt",
  title: "give it a title",
  items: "say which list to repeat over",
  stopWhen: "say what text ends the repeat",
};

/** Schema problems in words: "Subtask: choose a task type to run" rather than a path and a pattern. */
function plainIssue(path: PropertyKey[], message: string, steps: Step[]): string {
  const at = path.indexOf("steps");
  const step = at >= 0 && path[0] === "workflow" ? steps[Number(path[at + 1])] : undefined;
  const field = String(path.at(-1) ?? "");
  if (step) return `${titleOf(step)}: ${FIELD_HINTS[field] ?? message.toLowerCase()}`;
  if (path[0] === "inputFields") return `Brief field ${Number(path[1]) + 1}: ${field === "key" ? FIELD_HINTS.key : message.toLowerCase()}`;
  if (path[0] === "key") return `Task type key: ${FIELD_HINTS.key}`;
  if (path[0] === "name") return "Give the task type a name.";
  return message;
}

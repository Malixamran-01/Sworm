import {
  edgesOf,
  loopRound,
  needKey,
  upstreamOf,
  wouldCycle,
  type Need,
  type CallTargetDto,
  type InputField,
  type Repeat,
  type RoleDto,
  type Step,
  type WorkspaceDetailDto,
  type WorkspaceStep,
} from "@conclave/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type ReactNode } from "react";
import { api } from "../../../../lib/api";
import { Button, cx, ErrorNote, Field, Input, Segmented, Select, Textarea, Tile } from "../../../../ui";
import { NodePicker, type NodeValue } from "../../../connections/NodePicker";
import { CONNECTOR_LOOK, KIND_LOOK, loopLabel, needFrom, newLoop, resultKey, titleOf, type Draft } from "./graph";
import { BranchFields, ClassifyFields, MergeFields, StopFields, TextFields } from "./Logic";

const KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;
const toKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "s_$1").slice(0, 48);

// --------------------------------------------------------------- templates

interface Ref {
  label: string;
  token: string;
}

/** A template box with buttons that insert {{...}} references where the cursor is. */
export function TemplateField({ label, value, onChange, refs, rows = 4, help, mono }: { label: string; value: string; onChange: (v: string) => void; refs: Ref[]; rows?: number; help?: ReactNode; mono?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? at;
    onChange(value.slice(0, at) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  return (
    <Field label={label} htmlFor={id} help={help}>
      <textarea
        id={id}
        ref={ref}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx("min-h-16 w-full resize-y rounded-[10px] border border-line-strong bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink", mono && "font-mono")}
      />
      {refs.length ? (
        <div className="flex flex-wrap gap-1" role="group" aria-label={`Insert into ${label}`}>
          {refs.map((r) => (
            <button key={r.token} type="button" onClick={() => insert(r.token)} className="rounded-md border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-2 hover:border-line-strong">
              + {r.label}
            </button>
          ))}
        </div>
      ) : null}
    </Field>
  );
}

export function refsFor(draft: Draft, key: string | null, loop = false): Ref[] {
  const out: Ref[] = draft.inputFields.map((f) => ({ label: `brief.${f.key}`, token: `{{input.${f.key}}}` }));
  if (key) {
    for (const k of upstreamOf(draft.workflow, key)) if (k !== key) out.push({ label: `${k}.output`, token: `{{steps.${k}.output}}` });
  }
  // Inside a loop (WF-010), or a repeated workspace step.
  const inLoop = !!key && draft.workflow.steps.some((s) => s.loop && loopRound(draft.workflow, s).has(key));
  if (loop || inLoop) out.push({ label: "loop.index", token: "{{loop.index}}" }, { label: "loop.previous", token: "{{loop.previous}}" });
  if (loop) out.push({ label: "loop.item", token: "{{loop.item}}" });
  return out;
}

// ------------------------------------------------------------------- roles

function useSetWorkspace(ws: WorkspaceDetailDto) {
  const qc = useQueryClient();
  return (next: WorkspaceDetailDto) => qc.setQueryData(["workspace", ws.id], next);
}

/** Pick the role a step calls, or add a new one on the right port. */
export function RolePicker({ ws, port, value, onChange }: { ws: WorkspaceDetailDto; port: "model@1" | "tool@1"; value: string; onChange: (key: string) => void }) {
  const id = useId();
  const setWs = useSetWorkspace(ws);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createRole(ws.id, { name, port }),
    onSuccess: (next) => {
      const fresh = next.roles.find((r) => !ws.roles.some((o) => o.key === r.key));
      setWs(next);
      if (fresh) onChange(fresh.key);
      setAdding(false);
      setName("");
    },
  });
  const options = ws.roles.filter((r) => r.port === port);
  return (
    <div className="flex flex-col gap-1.5">
      <Field label="Role" htmlFor={id} help={port === "tool@1" ? "A role filled by a tool connection." : "Workflows call roles, never a model by name. Fill the role below or in Team."}>
        <Select
          id={id}
          value={options.some((r) => r.key === value) ? value : ""}
          onChange={(e) => (e.target.value === "+" ? setAdding(true) : onChange(e.target.value))}
        >
          <option value="" disabled>
            Choose a role
          </option>
          {options.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
          <option value="+">New role…</option>
        </Select>
      </Field>
      {adding ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Input aria-label="New role name" placeholder={port === "tool@1" ? "Web search" : "Fact checker"} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
            Add
          </Button>
          <Button variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
      <ErrorNote error={create.error} />
    </div>
  );
}

/** Fill a role with a node and edit its instructions, right from the step. */
export function RoleSetup({ ws, role }: { ws: WorkspaceDetailDto; role: RoleDto }) {
  const setWs = useSetWorkspace(ws);
  const [node, setNode] = useState<NodeValue>({ connectionId: role.connectionId, model: role.model });
  const [instructions, setInstructions] = useState(role.instructions);
  const id = useId();
  const assign = useMutation({ mutationFn: () => api.assignRole(ws.id, role.key, node), onSuccess: setWs });
  const save = useMutation({ mutationFn: () => api.updateRole(ws.id, role.key, { instructions }), onSuccess: setWs });
  const nodeDirty = node.connectionId !== role.connectionId || node.model !== role.model;
  const isTool = role.port === "tool@1";
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-line bg-surface-2 p-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold">{role.name} is filled by</span>
        <NodePicker idPrefix={`insp-${role.key}`} value={node} onChange={setNode} port={role.port} compact />
        {nodeDirty ? (
          <Button size="sm" variant="primary" className="self-start" disabled={assign.isPending || (!!node.connectionId && !node.model)} onClick={() => assign.mutate()}>
            Save {isTool ? "tool" : "model"}
          </Button>
        ) : null}
        <ErrorNote error={assign.error} />
      </div>
      {isTool ? null : (
        <Field label={`${role.name}'s instructions`} htmlFor={id} help="Shared by every step that calls this role.">
          <Textarea id={id} rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} className="text-[13px]" />
          {instructions !== role.instructions ? (
            <Button size="sm" className="self-start" disabled={save.isPending} onClick={() => save.mutate()}>
              Save instructions
            </Button>
          ) : null}
          <ErrorNote error={save.error} />
        </Field>
      )}
    </div>
  );
}

// ---------------------------------------------------------- the task type

/** With nothing selected, or the brief: the task type's name, its brief and its result. */
export function TaskTypePanel({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const nameId = useId();
  const keyId = useId();
  const descId = useId();
  const resId = useId();
  const setField = (i: number, f: Partial<InputField>) => onChange({ ...draft, inputFields: draft.inputFields.map((x, j) => (j === i ? { ...x, ...f } : x)) });
  return (
    <div className="flex flex-col gap-4">
      <Field label="Task type name" htmlFor={nameId}>
        <Input id={nameId} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </Field>
      <Field label="Key" htmlFor={keyId} help="Other workflows call this task type by its key.">
        <Input id={keyId} value={draft.key} onChange={(e) => onChange({ ...draft, key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} className="font-mono text-[13px]" />
      </Field>
      <Field label="Description" htmlFor={descId}>
        <Textarea id={descId} rows={2} value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} className="text-[13px]" />
      </Field>

      <section className="flex flex-col gap-2" aria-labelledby={`${keyId}-brief`}>
        <h3 id={`${keyId}-brief`} className="m-0 text-[13px] font-semibold">
          Brief fields
        </h3>
        <p className="m-0 text-xs text-muted">What someone fills in to start a task. Steps read them as {"{{input.key}}"}.</p>
        {draft.inputFields.map((f, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-[10px] border border-line p-2.5">
            <div className="flex gap-2">
              <Input aria-label={`Field ${i + 1} label`} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} className="!h-8 text-[13px]" />
              <Input aria-label={`Field ${i + 1} key`} value={f.key} onChange={(e) => setField(i, { key: toKey(e.target.value) })} className="!h-8 w-32 font-mono text-[12px]" />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={f.type === "longtext"} onChange={(e) => setField(i, { type: e.target.checked ? "longtext" : "text" })} /> Long text
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required
              </label>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" disabled={draft.inputFields.length === 1} onClick={() => onChange({ ...draft, inputFields: draft.inputFields.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="sm"
          className="self-start"
          onClick={() => {
            let key = "field";
            for (let n = 2; draft.inputFields.some((f) => f.key === key); n++) key = `field_${n}`;
            onChange({ ...draft, inputFields: [...draft.inputFields, { key, label: "New field", type: "text", required: false }] });
          }}
        >
          Add a field
        </Button>
      </section>

      <Field label="Result" htmlFor={resId} help="Whose output becomes the task's result.">
        <Select
          id={resId}
          value={draft.workflow.output ?? ""}
          onChange={(e) => {
            const { output: _o, ...rest } = draft.workflow;
            onChange({ ...draft, workflow: e.target.value ? { ...rest, output: e.target.value } : rest });
          }}
        >
          <option value="">The last model or workspace step ({resultKey({ ...draft.workflow, output: undefined }) ?? "none"})</option>
          {draft.workflow.steps.map((s) => (
            <option key={s.key} value={s.key}>
              {titleOf(s)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------- steps

export function StepPanel({
  draft,
  step,
  ws,
  targets,
  onChange,
  onRename,
  onNeeds,
  onDelete,
  onSelectEdge,
  onLoop,
  onSelectLoop,
}: {
  draft: Draft;
  step: Step;
  ws: WorkspaceDetailDto;
  targets: CallTargetDto[];
  onChange: (s: Step) => void;
  onRename: (to: string) => string | null;
  onNeeds: (needs: Need[]) => void;
  onDelete: () => void;
  onSelectEdge: (from: string, to: string) => void;
  onLoop: (loop: Step["loop"]) => void;
  onSelectLoop: () => void;
}) {
  const look = KIND_LOOK[step.kind];
  const [key, setKey] = useState(step.key);
  const [keyError, setKeyError] = useState<string | null>(null);
  const keyId = useId();
  const others = draft.workflow.steps.filter((s) => s.key !== step.key);
  const needs = step.needs ?? [];
  const needKeys = needs.map(needKey);
  const incoming = edgesOf(draft.workflow).filter((e) => e.to === step.key);
  const outgoing = edgesOf(draft.workflow).filter((e) => e.from === step.key);
  const before = [...upstreamOf(draft.workflow, step.key)].filter((k) => k !== step.key);
  const isResult = resultKey(draft.workflow) === step.key;

  const commitKey = () => {
    if (key === step.key) return setKeyError(null);
    if (!KEY_RE.test(key)) return setKeyError("Lowercase letters, digits and underscores, starting with a letter.");
    const problem = onRename(key);
    setKeyError(problem);
    if (problem) setKey(step.key);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5">
        <Tile text={look.short} palette={look.palette} size={32} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 truncate text-[15px] font-semibold">{titleOf(step)}</h2>
          <span className="text-xs text-muted">{look.help}</span>
        </div>
      </div>

      <Field label="Step key" htmlFor={keyId} help={keyError ?? "Other steps read this step's output as {{steps.key.output}}. Renaming updates them."}>
        <Input
          id={keyId}
          value={key}
          aria-invalid={!!keyError}
          onChange={(e) => setKey(e.target.value.toLowerCase())}
          onBlur={commitKey}
          onKeyDown={(e) => e.key === "Enter" && commitKey()}
          className="font-mono text-[13px]"
        />
      </Field>

      {step.kind === "role" ? <RoleFields draft={draft} step={step} ws={ws} onChange={onChange} /> : null}
      {step.kind === "tool" ? <ToolFields draft={draft} step={step} ws={ws} onChange={onChange} /> : null}
      {step.kind === "approval" ? <ApprovalFields draft={draft} step={step} before={before} onChange={onChange} /> : null}
      {step.kind === "workspace" ? <WorkspaceFields draft={draft} step={step} ws={ws} targets={targets} onChange={onChange} /> : null}
      {step.kind === "branch" ? <BranchFields draft={draft} step={step} onChange={onChange} /> : null}
      {step.kind === "classify" ? <ClassifyFields draft={draft} step={step} ws={ws} onChange={onChange} /> : null}
      {step.kind === "merge" ? <MergeFields step={step} onChange={onChange} /> : null}
      {step.kind === "text" ? <TextFields draft={draft} step={step} onChange={onChange} /> : null}
      {step.kind === "stop" ? <StopFields draft={draft} step={step} onChange={onChange} /> : null}

      {/* The keyboard way to connect steps: the same as drawing arrows on the canvas. */}
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 p-0 text-[13px] font-semibold">Runs after</legend>
        {others.length === 0 ? <p className="m-0 text-xs text-muted">Nothing else yet. It starts from the brief.</p> : null}
        {others.map((o) => {
          const on = needKeys.includes(o.key);
          const blocked = !on && (wouldCycle(draft.workflow, o.key, step.key) || o.kind === "stop");
          return (
            <label key={o.key} className={cx("flex items-center gap-2 text-[13px]", blocked && "text-muted")}>
              <input
                type="checkbox"
                checked={on}
                disabled={blocked}
                onChange={(e) => onNeeds(e.target.checked ? [...needs, needFrom(draft.workflow, o.key)] : needs.filter((n) => needKey(n) !== o.key))}
              />
              {titleOf(o)}
              {blocked ? <span className="text-xs">{o.kind === "stop" ? "(ends the task)" : "(runs after this one)"}</span> : null}
            </label>
          );
        })}
        {needs.length === 0 && others.length ? <p className="m-0 text-xs text-muted">Nothing checked: it starts as soon as the task does.</p> : null}
      </fieldset>

      {incoming.length + outgoing.length ? (
        <section className="flex flex-col gap-1.5" aria-label="Connectors">
          <span className="text-[13px] font-semibold">Connectors</span>
          <p className="m-0 text-xs text-muted">Open one to make it conditional, an otherwise or failure path, or to give the next step an instruction.</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {[...incoming, ...outgoing].map((e) => (
              <li key={`${e.from}-${e.to}`}>
                <button
                  type="button"
                  onClick={() => onSelectEdge(e.from, e.to)}
                  className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-[13px] hover:border-line-strong"
                >
                  <span className="h-0.5 w-4 shrink-0 rounded" style={{ background: CONNECTOR_LOOK[e.type].stroke }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {e.to === step.key ? `From ${titleOf(draft.workflow.steps.find((x) => x.key === e.from)!)}` : `To ${titleOf(draft.workflow.steps.find((x) => x.key === e.to)!)}`}
                  </span>
                  <span className="text-xs text-muted">{CONNECTOR_LOOK[e.type].label}{e.note ? " · note" : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {step.kind === "stop" ? null : (
        <section className="flex flex-col gap-1.5" aria-label="Loop">
          <span className="text-[13px] font-semibold">Loop</span>
          {step.loop ? (
            <button type="button" onClick={onSelectLoop} className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-[13px] hover:border-line-strong">
              <span className="min-w-0 flex-1 truncate">
                Back to {titleOf(draft.workflow.steps.find((x) => x.key === step.loop!.to) ?? step)} · {loopLabel(step.loop)}
              </span>
              <span className="text-xs text-muted">Edit</span>
            </button>
          ) : (
            <Button
              size="sm"
              className="self-start"
              onClick={() => {
                onLoop(newLoop(step.key));
                onSelectLoop();
              }}
            >
              Repeat until…
            </Button>
          )}
        </section>
      )}

      {incoming.length > 1 ? (
        <Field label="When several connectors arrive" htmlFor={`${keyId}-join`}>
          <Select id={`${keyId}-join`} value={step.join ?? "any"} onChange={(e) => onChange({ ...step, join: e.target.value as "any" | "all" | "first" })}>
            <option value="any">Wait for each, run if any was taken</option>
            <option value="all">Run only if every one was taken</option>
            <option value="first">Run as soon as one is taken</option>
          </Select>
        </Field>
      ) : null}

      <div className="flex flex-col gap-2 text-[13px]">
        {step.kind === "role" || step.kind === "tool" ? (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={step.optional} onChange={(e) => onChange({ ...step, optional: e.target.checked })} />
            Skip this step when its role has no node
          </label>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!step.disabled}
            onChange={(e) => {
              const { disabled: _d, ...rest } = step;
              onChange(e.target.checked ? ({ ...rest, disabled: true } as Step) : (rest as Step));
            }}
          />
          Turn off: skip this step and pass its input on
        </label>
        {isResult && draft.workflow.output !== step.key ? <p className="m-0 text-xs text-muted">This step's output is the task's result, because it is the last one that writes.</p> : null}
      </div>

      <Button variant="danger" size="sm" className="self-start" onClick={onDelete}>
        Delete step
      </Button>
    </div>
  );
}

function RoleFields({ draft, step, ws, onChange }: { draft: Draft; step: Extract<Step, { kind: "role" }>; ws: WorkspaceDetailDto; onChange: (s: Step) => void }) {
  const role = ws.roles.find((r) => r.key === step.role);
  const tokId = useId();
  return (
    <>
      <RolePicker ws={ws} port="model@1" value={step.role} onChange={(role) => onChange({ ...step, role })} />
      {role ? <RoleSetup key={`${role.key}:${role.connectionId}:${role.model}`} ws={ws} role={role} /> : null}
      <TemplateField label="Prompt" value={step.prompt} onChange={(prompt) => onChange({ ...step, prompt })} refs={refsFor(draft, step.key)} rows={6} />
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Most output tokens" htmlFor={tokId}>
          <Input id={tokId} inputMode="numeric" value={String(step.maxTokens)} onChange={(e) => onChange({ ...step, maxTokens: Number(e.target.value.replace(/\D/g, "")) || 16 })} />
        </Field>
        <Field label="Output" htmlFor={`${tokId}-o`}>
          <Select id={`${tokId}-o`} value={step.output} onChange={(e) => onChange({ ...step, output: e.target.value as "text" | "json" })}>
            <option value="text">Text</option>
            <option value="json">JSON</option>
          </Select>
        </Field>
      </div>
    </>
  );
}

function ToolFields({ draft, step, ws, onChange }: { draft: Draft; step: Extract<Step, { kind: "tool" }>; ws: WorkspaceDetailDto; onChange: (s: Step) => void }) {
  const role = ws.roles.find((r) => r.key === step.role);
  const args = Object.entries(step.args);
  const setArgs = (list: [string, string][]) => onChange({ ...step, args: Object.fromEntries(list) });
  return (
    <>
      <RolePicker ws={ws} port="tool@1" value={step.role} onChange={(role) => onChange({ ...step, role })} />
      {role ? <RoleSetup key={`${role.key}:${role.connectionId}:${role.model}`} ws={ws} role={role} /> : null}
      <section className="flex flex-col gap-2" aria-label="Tool arguments">
        <span className="text-[13px] font-semibold">Arguments</span>
        {args.map(([k, v], i) => (
          <div key={i} className="flex flex-col gap-1 rounded-[10px] border border-line p-2.5">
            <div className="flex gap-2">
              <Input aria-label={`Argument ${i + 1} name`} value={k} onChange={(e) => setArgs(args.map((a, j) => (j === i ? [e.target.value.replace(/\s/g, ""), a[1]] : a)))} className="!h-8 font-mono text-[12px]" />
              <Button size="sm" variant="ghost" onClick={() => setArgs(args.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
            <TemplateField label={k || "Value"} value={v} onChange={(val) => setArgs(args.map((a, j) => (j === i ? [a[0], val] : a)))} refs={refsFor(draft, step.key)} rows={2} />
          </div>
        ))}
        <Button size="sm" className="self-start" onClick={() => setArgs([...args, [`arg${args.length + 1}`, ""]])}>
          Add an argument
        </Button>
      </section>
    </>
  );
}

function ApprovalFields({ draft, step, before, onChange }: { draft: Draft; step: Extract<Step, { kind: "approval" }>; before: string[]; onChange: (s: Step) => void }) {
  const titleId = useId();
  return (
    <>
      <Field label="Title" htmlFor={titleId}>
        <Input id={titleId} value={step.title} onChange={(e) => onChange({ ...step, title: e.target.value })} />
      </Field>
      <TemplateField label="Show the approver" value={step.show} onChange={(show) => onChange({ ...step, show })} refs={refsFor(draft, step.key)} />
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 p-0 text-[13px] font-semibold">If they ask for changes, re-run</legend>
        {before.length === 0 ? <p className="m-0 text-xs text-muted">No earlier steps. Connect one first.</p> : null}
        {before.map((k) => (
          <label key={k} className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={step.revises.includes(k)}
              onChange={(e) => onChange({ ...step, revises: e.target.checked ? [...step.revises, k] : step.revises.filter((r) => r !== k) })}
            />
            {titleOf(draft.workflow.steps.find((s) => s.key === k)!)}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={step.urgent} onChange={(e) => onChange({ ...step, urgent: e.target.checked })} />
        Safety check: reach people even in quiet hours
      </label>
    </>
  );
}

// -------------------------------------------------------- workspace steps

const REPEATS = [
  { value: "none", label: "Once" },
  { value: "times", label: "Times" },
  { value: "each", label: "Each item" },
  { value: "until", label: "Until" },
] as const;

function WorkspaceFields({ draft, step, ws, targets, onChange }: { draft: Draft; step: WorkspaceStep; ws: WorkspaceDetailDto; targets: CallTargetDto[]; onChange: (s: Step) => void }) {
  const wsId = useId();
  const ttId = useId();
  const untilId = useId();
  const self = step.workspace === "self" || step.workspace === ws.id;
  const target = targets.find((t) => t.workspaceId === (self ? ws.id : step.workspace));
  // In this workspace, the task type being edited is the draft itself, saved or not.
  const own = { key: draft.key, name: `${draft.name || draft.key} (this one)`, description: draft.description, inputFields: draft.inputFields, steps: draft.workflow.steps.map((s) => ({ key: s.key, kind: s.kind, label: titleOf(s) })) };
  const taskTypes = self ? [own, ...(target?.taskTypes ?? []).filter((t) => t.key !== draft.key)] : (target?.taskTypes ?? []);
  const called = taskTypes.find((t) => t.key === step.taskType);
  const recursive = self && step.taskType === draft.key;
  const mode = step.repeat?.mode ?? "none";
  const setRepeat = (r: Repeat | undefined) => {
    const { repeat: _r, ...rest } = step;
    onChange(r ? { ...rest, repeat: r } : rest);
  };

  return (
    <>
      <Field label="Workspace" htmlFor={wsId}>
        <Select
          id={wsId}
          value={self ? "self" : step.workspace}
          onChange={(e) => {
            const { until: _u, ...rest } = step;
            onChange({ ...rest, workspace: e.target.value, taskType: "", inputs: {} });
          }}
        >
          <option value="self">This workspace ({ws.name})</option>
          {targets
            .filter((t) => t.workspaceId !== ws.id)
            .map((t) => (
              <option key={t.workspaceId} value={t.workspaceId}>
                {t.workspaceName}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Task type to run" htmlFor={ttId} help={recursive ? "This workflow runs itself. Set where the inner run stops, or it would never end." : undefined}>
        <Select
          id={ttId}
          value={called ? step.taskType : ""}
          onChange={(e) => {
            const next = taskTypes.find((t) => t.key === e.target.value);
            const { until: _u, ...rest } = step;
            // Pass each field of the same name straight through, which is what most calls want.
            const inputs = Object.fromEntries((next?.inputFields ?? []).map((f) => [f.key, draft.inputFields.some((d) => d.key === f.key) ? `{{input.${f.key}}}` : ""]));
            onChange({ ...rest, taskType: e.target.value, inputs });
          }}
        >
          <option value="" disabled>
            Choose a task type
          </option>
          {taskTypes.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      {called ? (
        <>
          <Field label="Run up to" htmlFor={untilId} help="Stop the sub-task after this step; its output is the result here.">
            <Select
              id={untilId}
              value={step.until ?? ""}
              onChange={(e) => {
                const { until: _u, ...rest } = step;
                onChange(e.target.value ? { ...rest, until: e.target.value } : rest);
              }}
            >
              <option value="">All of it</option>
              {called.steps.map((s) => (
                <option key={s.key} value={s.key} disabled={recursive && s.key === step.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <section className="flex flex-col gap-2.5" aria-label="Sub-task brief">
            <span className="text-[13px] font-semibold">Its brief</span>
            {called.inputFields.map((f) => (
              <TemplateField
                key={f.key}
                label={`${f.label}${f.required ? " (required)" : ""}`}
                value={step.inputs[f.key] ?? ""}
                onChange={(v) => onChange({ ...step, inputs: { ...step.inputs, [f.key]: v } })}
                refs={refsFor(draft, step.key, !!step.repeat)}
                rows={2}
              />
            ))}
          </section>
        </>
      ) : null}

      <section className="flex flex-col gap-2.5" aria-label="Repeat">
        <span className="text-[13px] font-semibold">How many runs</span>
        <Segmented
          label="How many runs"
          value={mode}
          options={REPEATS.map((r) => ({ value: r.value, label: r.label }))}
          onChange={(m) =>
            setRepeat(
              m === "none"
                ? undefined
                : m === "times"
                  ? { mode: "times", count: 3, parallel: 1 }
                  : m === "each"
                    ? { mode: "each", items: refsFor(draft, step.key)[0]?.token ?? "{{input.request}}", max: 20, parallel: 3 }
                    : { mode: "until", stopWhen: "DONE", max: 5 },
            )
          }
        />
        {step.repeat?.mode === "times" ? (
          <div className="grid grid-cols-2 gap-2.5">
            <NumberField label="Runs" value={step.repeat.count} min={1} max={50} onChange={(count) => setRepeat({ ...(step.repeat as Extract<Repeat, { mode: "times" }>), count })} />
            <NumberField label="At once" value={step.repeat.parallel} min={1} max={10} onChange={(parallel) => setRepeat({ ...(step.repeat as Extract<Repeat, { mode: "times" }>), parallel })} />
          </div>
        ) : null}
        {step.repeat?.mode === "each" ? (
          <>
            <TemplateField
              label="The list"
              value={step.repeat.items}
              onChange={(items) => setRepeat({ ...(step.repeat as Extract<Repeat, { mode: "each" }>), items })}
              refs={refsFor(draft, step.key)}
              rows={2}
              mono
              help="A JSON array, or one item per line. Each run reads its item as {{loop.item}}."
            />
            <div className="grid grid-cols-2 gap-2.5">
              <NumberField label="Most items" value={step.repeat.max} min={1} max={100} onChange={(max) => setRepeat({ ...(step.repeat as Extract<Repeat, { mode: "each" }>), max })} />
              <NumberField label="At once" value={step.repeat.parallel} min={1} max={10} onChange={(parallel) => setRepeat({ ...(step.repeat as Extract<Repeat, { mode: "each" }>), parallel })} />
            </div>
          </>
        ) : null}
        {step.repeat?.mode === "until" ? (
          <>
            <Field label="Stop when the output contains" htmlFor={`${untilId}-stop`} help="Runs one after another. Each run reads the one before as {{loop.previous}}.">
              <Input id={`${untilId}-stop`} value={step.repeat.stopWhen} onChange={(e) => setRepeat({ ...(step.repeat as Extract<Repeat, { mode: "until" }>), stopWhen: e.target.value })} />
            </Field>
            <NumberField label="Most runs" value={step.repeat.max} min={1} max={20} onChange={(max) => setRepeat({ ...(step.repeat as Extract<Repeat, { mode: "until" }>), max })} />
          </>
        ) : null}
        {step.repeat && step.repeat.mode !== "until" ? <p className="m-0 text-xs text-muted">The output is a JSON list of every run's output, in order.</p> : null}
      </section>
      <NumberField
        label="Give up after (hours)"
        value={Math.round(step.timeoutMs / 3_600_000) || 1}
        min={1}
        max={168}
        onChange={(h) => onChange({ ...step, timeoutMs: h * 3_600_000 })}
        help="Counts approvals inside the sub-tasks too."
      />
    </>
  );
}

export function NumberField({ label, value, min, max, onChange, help }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; help?: string }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} help={help}>
      <Input id={id} type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || min))))} />
    </Field>
  );
}

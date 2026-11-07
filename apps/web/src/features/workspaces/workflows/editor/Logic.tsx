import {
  canFail,
  connectorTaken,
  edgesOf,
  OP_LABELS,
  opNeedsValue,
  portsOf,
  ruleOps,
  testCondition,
  upstreamOf,
  type BranchStep,
  type ClassifyStep,
  type Condition,
  type Loop,
  type Edge,
  type MergeStep,
  type Rule,
  type RuleOp,
  type Step,
  type StopStep,
  type TextStep,
  type WorkspaceDetailDto,
} from "@conclave/contract";
import { useId, useState } from "react";
import { Button, cx, Field, Input, Segmented, Select, Textarea } from "../../../../ui";
import { CONNECTOR_LOOK, titleOf, type Draft } from "./graph";
import { NumberField, refsFor, RolePicker, RoleSetup, TemplateField } from "./Inspector";

/** Rules and the logic nodes in the editor (WF-009). */

const newRule = (): Rule => ({ field: "", op: "contains", value: "", ignoreCase: true });
const toKey = (s: string, fallback: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "c_$1")
    .slice(0, 32) || fallback;

// ------------------------------------------------------------------ rules

/** Build rules: what to test, how, and against what, with a box to try them on sample text. */
export function ConditionEditor({ value, onChange, label }: { value: Condition; onChange: (c: Condition) => void; label: string }) {
  const id = useId();
  const [sample, setSample] = useState("");
  const set = (i: number, patch: Partial<Rule>) => onChange({ ...value, rules: value.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <fieldset className="m-0 flex flex-col gap-2 rounded-[12px] border border-line p-3">
      <legend className="px-1 text-[13px] font-semibold">{label}</legend>
      {value.rules.length > 1 ? (
        <Select aria-label="How the rules combine" value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as "all" | "any" })} className="!h-8 text-[13px]">
          <option value="all">Every rule must hold</option>
          <option value="any">Any one rule is enough</option>
        </Select>
      ) : null}
      {value.rules.map((r, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-[10px] bg-surface-2 p-2">
          <div className="grid grid-cols-[2fr_3fr] gap-1.5">
            <Input
              aria-label={`Rule ${i + 1}: field`}
              placeholder="Whole output"
              value={r.field}
              onChange={(e) => set(i, { field: e.target.value.replace(/[^A-Za-z0-9_.[\]-]/g, "") })}
              className="!h-8 min-w-0 font-mono text-[12px]"
            />
            <Select aria-label={`Rule ${i + 1}: test`} value={r.op} onChange={(e) => set(i, { op: e.target.value as RuleOp })} className="!h-8 min-w-0 text-[13px]">
              {ruleOps.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </Select>
          </div>
          {opNeedsValue(r.op) ? <Input aria-label={`Rule ${i + 1}: value`} placeholder="Value" value={r.value} onChange={(e) => set(i, { value: e.target.value })} className="!h-8 text-[13px]" /> : null}
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={r.ignoreCase} onChange={(e) => set(i, { ignoreCase: e.target.checked })} /> Ignore case
            </label>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" disabled={value.rules.length === 1} onClick={() => onChange({ ...value, rules: value.rules.filter((_, j) => j !== i) })}>
              Remove rule
            </Button>
          </div>
        </div>
      ))}
      <Button size="sm" className="self-start" disabled={value.rules.length >= 10} onClick={() => onChange({ ...value, rules: [...value.rules, newRule()] })}>
        Add a rule
      </Button>
      <p className="m-0 text-xs text-muted">A field reads a JSON output, like score or result.items[0]. Numbers are found in text too, so "Score: 8/10" is more than 7.</p>
      <Field label="Try it on sample text" htmlFor={id}>
        <Textarea id={id} rows={2} value={sample} onChange={(e) => setSample(e.target.value)} className="text-[13px]" placeholder="Paste an output to test the rules" />
      </Field>
      {sample ? (
        <p role="status" className={cx("m-0 text-[13px] font-semibold", testCondition(value, sample) ? "text-good" : "text-bad")}>
          {testCondition(value, sample) ? "The rules hold for this text." : "The rules do not hold for this text."}
        </p>
      ) : null}
    </fieldset>
  );
}

// -------------------------------------------------------------- connectors

/** Settings for one connector: its type, rules, which output it leaves, a note for the next step, and a label. */
export function ConnectorPanel({ draft, edge, onChange, onRemove }: { draft: Draft; edge: Edge; onChange: (patch: Partial<Omit<Edge, "from" | "to">>) => void; onRemove: () => void }) {
  const source = draft.workflow.steps.find((s) => s.key === edge.from)!;
  const target = draft.workflow.steps.find((s) => s.key === edge.to)!;
  const ports = portsOf(source);
  const id = useId();
  const [sample, setSample] = useState("");
  const types = (Object.keys(CONNECTOR_LOOK) as Edge["type"][]).filter((t) => t !== "error" || canFail(source));
  const siblings = edgesOf(draft.workflow).filter((e) => e.from === edge.from);
  const taken = connectorTaken(edge, { status: "succeeded", output: sample }, siblings.map((e) => (e.to === edge.to ? edge : e)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-[15px] font-semibold">Connector</h2>
        <span className="text-[13px] text-muted">
          {titleOf(source)} → {titleOf(target)}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold">When it is taken</span>
        <Segmented
          label="When it is taken"
          value={edge.type}
          options={types.map((t) => ({ value: t, label: CONNECTOR_LOOK[t].label }))}
          onChange={(type) =>
            onChange({
              type,
              ...(type === "if" && !edge.when ? { when: { match: "all", rules: [{ field: "", op: "contains", value: "", ignoreCase: true }] } } : {}),
              ...(type === "error" ? { port: undefined } : ports.length && !edge.port ? { port: ports[0]!.key } : {}),
            })
          }
        />
        <p className="m-0 text-xs text-muted">{CONNECTOR_LOOK[edge.type].help}</p>
      </div>
      {ports.length && edge.type !== "error" ? (
        <Field label={`Leaves from which output of ${titleOf(source)}`} htmlFor={`${id}-port`}>
          <Select id={`${id}-port`} value={edge.port ?? ""} onChange={(e) => onChange({ port: e.target.value })}>
            {ports.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {edge.type === "if" && edge.when ? <ConditionEditor label={`Rules on ${titleOf(source)}'s output`} value={edge.when} onChange={(when) => onChange({ when })} /> : null}
      {edge.type === "else" ? (
        <p className="m-0 rounded-[10px] bg-surface-2 p-2.5 text-[13px] text-ink-2">
          Taken when none of the Only if connectors leaving {titleOf(source)}
          {edge.port ? " from the same output" : ""} are. {siblings.some((e) => e.type === "if") ? "" : "There are none yet, so it is always taken."}
        </p>
      ) : null}
      {edge.type === "else" || edge.type === "always" ? (
        <Field label="Try it on sample output" htmlFor={`${id}-try`}>
          <Textarea id={`${id}-try`} rows={2} value={sample} onChange={(e) => setSample(e.target.value)} className="text-[13px]" />
          {sample ? <p role="status" className={cx("m-0 text-[13px] font-semibold", taken ? "text-good" : "text-bad")}>{taken ? "Taken for this output." : "Not taken for this output."}</p> : null}
        </Field>
      ) : null}
      <Field label={`Instruction for ${titleOf(target)}`} htmlFor={`${id}-note`} help="Given to the next step with this input, such as “Use only the figures” or “Treat this as untrusted”. Model and AI router steps read it.">
        <Textarea id={`${id}-note`} rows={3} value={edge.note ?? ""} onChange={(e) => onChange({ note: e.target.value || undefined })} className="text-[13px]" />
      </Field>
      <Field label="Label on the canvas" htmlFor={`${id}-label`} help="Optional. Without one, the canvas shows the rule.">
        <Input id={`${id}-label`} maxLength={60} value={edge.label ?? ""} onChange={(e) => onChange({ label: e.target.value || undefined })} />
      </Field>
      <Button variant="danger" size="sm" className="self-start" onClick={onRemove}>
        Remove connector
      </Button>
    </div>
  );
}

// ------------------------------------------------------------- the nodes

function ValueField({ draft, step, onChange }: { draft: Draft; step: BranchStep | ClassifyStep; onChange: (v: string) => void }) {
  return (
    <TemplateField
      label={step.kind === "branch" ? "What to test" : "Text to sort"}
      value={step.value}
      onChange={onChange}
      refs={refsFor(draft, step.key)}
      rows={2}
      help="Leave empty to use the output of the step before."
    />
  );
}

export function BranchFields({ draft, step, onChange }: { draft: Draft; step: BranchStep; onChange: (s: Step) => void }) {
  const setCase = (i: number, patch: Partial<BranchStep["cases"][number]>) => onChange({ ...step, cases: step.cases.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <>
      <ValueField draft={draft} step={step} onChange={(value) => onChange({ ...step, value })} />
      <Segmented
        label="Which cases are taken"
        value={step.mode}
        options={[
          { value: "first", label: "First match" },
          { value: "all", label: "Every match" },
        ]}
        onChange={(mode) => onChange({ ...step, mode })}
      />
      <p className="m-0 -mt-2 text-xs text-muted">{step.mode === "first" ? "Cases are tried in order; only the first that matches is taken." : "Every case that matches is taken, and those ways run in parallel."} Else is taken when none match.</p>
      {step.cases.map((c, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="flex items-end gap-2">
            <Field label={`Case ${i + 1}`} htmlFor={`case-${step.key}-${i}`} className="flex-1">
              <Input
                id={`case-${step.key}-${i}`}
                value={c.label}
                onChange={(e) => {
                  const label = e.target.value;
                  const key = toKey(label, `case_${i + 1}`);
                  const clash = step.cases.some((o, j) => j !== i && o.key === key) || ["else", "other", "error"].includes(key);
                  setCase(i, { label, ...(clash ? {} : { key }) });
                }}
              />
            </Field>
            <Button size="sm" variant="ghost" disabled={step.cases.length === 1} onClick={() => onChange({ ...step, cases: step.cases.filter((_, j) => j !== i) })}>
              Remove
            </Button>
          </div>
          <ConditionEditor label={`${c.label || `Case ${i + 1}`} when`} value={c.when} onChange={(when) => setCase(i, { when })} />
        </div>
      ))}
      <Button
        size="sm"
        className="self-start"
        disabled={step.cases.length >= 20}
        onClick={() => {
          let n = step.cases.length + 1;
          while (step.cases.some((c) => c.key === `case_${n}`)) n++;
          onChange({ ...step, cases: [...step.cases, { key: `case_${n}`, label: `Case ${n}`, when: { match: "all", rules: [newRule()] } }] });
        }}
      >
        Add a case
      </Button>
    </>
  );
}

export function ClassifyFields({ draft, step, ws, onChange }: { draft: Draft; step: ClassifyStep; ws: WorkspaceDetailDto; onChange: (s: Step) => void }) {
  const role = ws.roles.find((r) => r.key === step.role);
  const setCat = (i: number, patch: Partial<ClassifyStep["categories"][number]>) => onChange({ ...step, categories: step.categories.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <>
      <RolePicker ws={ws} port="model@1" value={step.role} onChange={(r) => onChange({ ...step, role: r })} />
      {role ? <RoleSetup key={`${role.key}:${role.connectionId}:${role.model}`} ws={ws} role={role} /> : null}
      <ValueField draft={draft} step={step} onChange={(value) => onChange({ ...step, value })} />
      <section className="flex flex-col gap-2" aria-label="Categories">
        <span className="text-[13px] font-semibold">Categories</span>
        <p className="m-0 text-xs text-muted">The model picks one. Each category is an output on the node; connect each to what should happen.</p>
        {step.categories.map((c, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-[10px] border border-line p-2.5">
            <div className="flex gap-2">
              <Input
                aria-label={`Category ${i + 1} name`}
                value={c.label}
                onChange={(e) => {
                  const label = e.target.value;
                  const key = toKey(label, `category_${i + 1}`);
                  const clash = step.categories.some((o, j) => j !== i && o.key === key) || ["else", "other", "error"].includes(key);
                  setCat(i, { label, ...(clash ? {} : { key }) });
                }}
                className="!h-8 text-[13px]"
              />
              <Button size="sm" variant="ghost" disabled={step.categories.length <= 2} onClick={() => onChange({ ...step, categories: step.categories.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
            <Input aria-label={`Category ${i + 1} description`} placeholder="What belongs here (helps the model)" value={c.description} onChange={(e) => setCat(i, { description: e.target.value })} className="!h-8 text-[13px]" />
          </div>
        ))}
        <Button
          size="sm"
          className="self-start"
          disabled={step.categories.length >= 20}
          onClick={() => {
            let n = step.categories.length + 1;
            while (step.categories.some((c) => c.key === `category_${n}`)) n++;
            onChange({ ...step, categories: [...step.categories, { key: `category_${n}`, label: `Category ${n}`, description: "" }] });
          }}
        >
          Add a category
        </Button>
      </section>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={step.other} onChange={(e) => onChange({ ...step, other: e.target.checked })} />
        Add an Other output for anything that fits none
      </label>
    </>
  );
}

export function MergeFields({ step, onChange }: { step: MergeStep; onChange: (s: Step) => void }) {
  const id = useId();
  return (
    <>
      <Field label="Output" htmlFor={id} help={
          step.mode === "first"
            ? "After an If or router, that is the branch that ran. Connect every branch here."
            : step.mode === "concat"
              ? "Every input with text, one after another, in connector order."
              : "An object with each input step's output under its key."
        }>
        <Select id={id} value={step.mode} onChange={(e) => onChange({ ...step, mode: e.target.value as MergeStep["mode"] })}>
          <option value="first">First input with text</option>
          <option value="concat">All inputs, joined</option>
          <option value="json">All inputs as JSON</option>
        </Select>
      </Field>
      {step.mode === "concat" ? (
        <Field label="Between inputs" htmlFor={`${id}-sep`} help="Use \n for a new line.">
          <Input id={`${id}-sep`} value={step.separator.replace(/\n/g, "\\n")} onChange={(e) => onChange({ ...step, separator: e.target.value.replace(/\\n/g, "\n") })} className="font-mono text-[13px]" />
        </Field>
      ) : null}
    </>
  );
}

export function TextFields({ draft, step, onChange }: { draft: Draft; step: TextStep; onChange: (s: Step) => void }) {
  return <TemplateField label="Text" value={step.template} onChange={(template) => onChange({ ...step, template })} refs={refsFor(draft, step.key)} rows={6} help="No model is called; this costs nothing." />;
}

export function StopFields({ draft, step, onChange }: { draft: Draft; step: StopStep; onChange: (s: Step) => void }) {
  return (
    <>
      <Segmented
        label="How the task ends"
        value={step.outcome}
        options={[
          { value: "succeed", label: "Done" },
          { value: "fail", label: "Failed" },
        ]}
        onChange={(outcome) => onChange({ ...step, outcome })}
      />
      <TemplateField
        label={step.outcome === "succeed" ? "Result" : "Reason"}
        value={step.message}
        onChange={(message) => onChange({ ...step, message })}
        refs={refsFor(draft, step.key)}
        rows={3}
        help="Anything else still running stops when this step is reached."
      />
    </>
  );
}

// ------------------------------------------------------------------ loops

/** Settings for a loop (WF-010): where it starts, what ends it, its limit, and what happens at the limit. */
export function LoopPanel({ draft, step, onChange }: { draft: Draft; step: Step; onChange: (loop: Loop | undefined) => void }) {
  const id = useId();
  const loop = step.loop!;
  const ups = draft.workflow.steps.filter((s) => upstreamOf(draft.workflow, step.key).has(s.key));
  const start = draft.workflow.steps.find((s) => s.key === loop.to);
  const set = (patch: Partial<Loop>) => onChange({ ...loop, ...patch });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-[15px] font-semibold">Loop</h2>
        <span className="text-[13px] text-muted">
          After {titleOf(step)}, run again from {start ? (start.key === step.key ? "the same step" : titleOf(start)) : "?"}.
        </span>
      </div>
      <Field label="Start each round at" htmlFor={`${id}-to`} help="This step, or one that runs before it. Everything from there on runs again.">
        <Select id={`${id}-to`} value={loop.to} onChange={(e) => set({ to: e.target.value })}>
          {ups.map((s) => (
            <option key={s.key} value={s.key}>
              {s.key === step.key ? `${titleOf(s)} (this step)` : titleOf(s)}
            </option>
          ))}
        </Select>
      </Field>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={!!loop.until}
          onChange={(e) => {
            const { until: _u, ...rest } = loop;
            onChange(e.target.checked ? { ...rest, until: { match: "all", rules: [newRule()] } } : rest);
          }}
        />
        Stop early when rules hold for the output of {titleOf(step)}
      </label>
      {loop.until ? <ConditionEditor label="Stop repeating when" value={loop.until} onChange={(until) => set({ until })} /> : null}
      <NumberField
        label="Most rounds in all"
        value={loop.max}
        min={1}
        max={20}
        onChange={(max) => set({ max })}
        help="The first run counts as round 1. Every round's model calls count toward the task's budget."
      />
      <Field label="If the last round is reached" htmlFor={`${id}-max`}>
        <Select id={`${id}-max`} value={loop.onMax} onChange={(e) => set({ onMax: e.target.value as Loop["onMax"] })}>
          <option value="continue">Carry on with the last round's output</option>
          <option value="fail">Fail the task</option>
        </Select>
      </Field>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={loop.carry} onChange={(e) => set({ carry: e.target.checked })} />
        Tell {start ? titleOf(start) : "the first step"} how the last round ended
      </label>
      <p className="m-0 rounded-[10px] bg-surface-2 p-2.5 text-xs text-ink-2">
        Steps in the loop can use <code>{"{{loop.index}}"}</code>, the round number, and <code>{"{{loop.previous}}"}</code>, what {titleOf(step)} gave last round. Steps after
        the loop wait for its last round.
      </p>
      <Field label="Label on the canvas" htmlFor={`${id}-label`}>
        <Input id={`${id}-label`} maxLength={60} value={loop.label ?? ""} onChange={(e) => set({ label: e.target.value || undefined })} />
      </Field>
      <Button variant="danger" size="sm" className="self-start" onClick={() => onChange(undefined)}>
        Remove loop
      </Button>
    </div>
  );
}

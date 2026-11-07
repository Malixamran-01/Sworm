import {
  autoLayout,
  describeCondition,
  edgesOf as contractEdges,
  explicitNeeds,
  needKey,
  portsOf,
  resolveNeeds,
  toNeed,
  type CanvasNote,
  type Edge,
  type InputField,
  type Loop,
  type Need,
  type NodePosition,
  type RoleDto,
  type Step,
  type StepKind,
  type TaskTypeDto,
  type WorkflowDefinition,
} from "@conclave/contract";
import type { TilePalette } from "../../../../lib/palette";

/** What the editor holds while you work: a task type with every dependency written out and every node placed. */
export interface Draft {
  key: string;
  name: string;
  description: string;
  inputFields: InputField[];
  workflow: WorkflowDefinition & { layout: Record<string, NodePosition> };
}

export type { Edge };
export const BRIEF = "_brief";
export const NODE_W = 220;
export const NODE_H = 78;
/** Nodes with named outputs (If/Switch, AI router) grow a row per output. */
export const PORT_TOP = 58;
export const PORT_ROW = 24;

export const KIND_LOOK: Record<StepKind, { label: string; short: string; palette: TilePalette; help: string; group: "Work" | "Logic" | "People" }> = {
  role: { label: "Model step", short: "M", palette: "blue", help: "A role writes, plans or checks with a model.", group: "Work" },
  tool: { label: "Tool step", short: "T", palette: "teal", help: "Calls one tool, such as a web search.", group: "Work" },
  workspace: { label: "Run a workspace", short: "W", palette: "violet", help: "Runs a task type of a workspace as a sub-task, this one included, and waits for it.", group: "Work" },
  text: { label: "Text", short: "Tx", palette: "mint", help: "Writes text from a template, with no model and no cost.", group: "Work" },
  branch: { label: "If / Switch", short: "If", palette: "peach", help: "Tests rules and takes the matching way: one case is an If, more is a Switch.", group: "Logic" },
  classify: { label: "AI router", short: "AI", palette: "sky", help: "A model reads the text and picks one of your categories; that way is taken.", group: "Logic" },
  merge: { label: "Merge", short: "Mg", palette: "green", help: "Brings branches back together: the one that ran, or all of them.", group: "Logic" },
  stop: { label: "Stop", short: "■", palette: "grey", help: "Ends the task here, as done with a result or as failed with a reason.", group: "Logic" },
  approval: { label: "Approval", short: "A", palette: "amber", help: "Stops and asks a person to approve, reject or ask for changes.", group: "People" },
};

export const CONNECTOR_LOOK = {
  always: { label: "Always", stroke: "var(--line-dashed)", help: "Runs the next step when this one finishes." },
  if: { label: "Only if", stroke: "var(--accent)", help: "Runs the next step only when the rules hold for this step's output." },
  else: { label: "Otherwise", stroke: "var(--warn-strong)", help: "Runs the next step when none of this step's Only if connectors are taken." },
  error: { label: "On failure", stroke: "var(--bad)", help: "Runs the next step only if this one fails, after its retries. The task carries on." },
} as const;

export const LOOP_LOOK = {
  label: "Loop back",
  stroke: "var(--tile-violet-fg)",
  help: "Runs again from an earlier step until rules hold for this step's output, up to a limit.",
};

/** A loop's short label: what ends it and its limit. */
export function loopLabel(loop: Loop): string {
  const head = loop.label || (loop.until ? `until ${describeCondition(loop.until)}` : `${loop.max} rounds`);
  const text = head.length > 30 ? `${head.slice(0, 29)}…` : head;
  return `↻ ${text}${loop.until && !loop.label ? ` · max ${loop.max}` : ""}`;
}

/** Add, change or remove a step's loop. */
export function setLoop(draft: Draft, key: string, loop: Loop | undefined): Draft {
  return {
    ...draft,
    workflow: {
      ...draft.workflow,
      steps: draft.workflow.steps.map((s) => {
        if (s.key !== key) return s;
        const { loop: _l, ...rest } = s;
        return (loop ? { ...rest, loop } : rest) as Step;
      }),
    },
  };
}

export const newLoop = (to: string): Loop => ({ to, max: 3, onMax: "continue", carry: true, until: { match: "all", rules: [{ field: "", op: "contains", value: "DONE", ignoreCase: true }] } });

export function draftFrom(tt: TaskTypeDto): Draft {
  const def = explicitNeeds(tt.workflow);
  return { key: tt.key, name: tt.name, description: tt.description, inputFields: tt.inputFields, workflow: { ...def, layout: autoLayout(def, 280, 132, nodeHeight) } };
}

export function newDraft(roles: RoleDto[], taken: string[]): Draft {
  const role = roles.find((r) => r.port === "model@1");
  let key = "new_task";
  for (let i = 2; taken.includes(key); i++) key = `new_task_${i}`;
  const steps: Step[] = [
    role
      ? { kind: "role", key: "respond", role: role.key, prompt: "{{input.request}}", maxTokens: 4_000, output: "text", timeoutMs: 300_000, optional: false, needs: [] }
      : { kind: "approval", key: "review", title: "Review the request", show: "{{input.request}}", revises: [], urgent: false, optional: false, needs: [] },
  ];
  const def: WorkflowDefinition = { version: 1, steps };
  return {
    key,
    name: "New task",
    description: "",
    inputFields: [{ key: "request", label: "Request", type: "longtext", required: true }],
    workflow: { ...def, layout: autoLayout(def, 280, 132, nodeHeight) },
  };
}

export const titleOf = (s: Step) => (s.kind === "approval" ? s.title : s.key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));

export function uniqueKey(def: WorkflowDefinition, base: string): string {
  const keys = new Set(def.steps.map((s) => s.key));
  if (!keys.has(base)) return base;
  for (let i = 2; ; i++) if (!keys.has(`${base}_${i}`)) return `${base}_${i}`;
}

const rule = (op: "contains" | "not_empty", value = "") => ({ match: "all" as const, rules: [{ field: "", op, value, ignoreCase: true }] });

/** A connector from `after`, leaving from its first output when it has named ones. */
export function needFrom(def: WorkflowDefinition, after: string): Need {
  const source = def.steps.find((s) => s.key === after);
  const port = source ? portsOf(source)[0]?.key : undefined;
  return port ? { step: after, type: "always", port } : after;
}

/** A new step of a kind, wired after `after` when given. */
export function makeStep(kind: StepKind, def: WorkflowDefinition, roles: RoleDto[], after: string | null): Step {
  const needs = after ? [needFrom(def, after)] : [];
  const from = after ? `{{steps.${after}.output}}` : "{{input.request}}";
  const base = { needs, optional: false };
  const model = roles.find((r) => r.port === "model@1");
  switch (kind) {
    case "role":
      return { ...base, kind, key: uniqueKey(def, "write"), role: model?.key ?? "", prompt: from, maxTokens: 4_000, output: "text", timeoutMs: 300_000 };
    case "tool": {
      const role = roles.find((r) => r.port === "tool@1");
      return { ...base, kind, key: uniqueKey(def, "search"), role: role?.key ?? "", args: { query: from }, timeoutMs: 120_000 };
    }
    case "approval":
      return { ...base, kind, key: uniqueKey(def, "review"), title: "Review", show: from, revises: after ? [after] : [], urgent: false };
    case "workspace":
      return { ...base, kind, key: uniqueKey(def, "subtask"), workspace: "self", taskType: "", inputs: {}, timeoutMs: 24 * 3_600_000 };
    case "branch":
      return { ...base, kind, key: uniqueKey(def, "check"), value: "", mode: "first", cases: [{ key: "yes", label: "Yes", when: rule("contains", "yes") }] };
    case "classify":
      return {
        ...base,
        kind,
        key: uniqueKey(def, "route"),
        role: model?.key ?? "",
        value: "",
        categories: [
          { key: "question", label: "Question", description: "" },
          { key: "request", label: "Request", description: "" },
        ],
        other: true,
        maxTokens: 64,
        timeoutMs: 120_000,
      };
    case "merge":
      return { ...base, kind, key: uniqueKey(def, "merge"), mode: "first", separator: "\n\n" };
    case "text":
      return { ...base, kind, key: uniqueKey(def, "text"), template: from };
    case "stop":
      return { ...base, kind, key: uniqueKey(def, "stop"), outcome: "succeed", message: from };
  }
}

export const edgesOf = (def: WorkflowDefinition): Edge[] => contractEdges(def);

/** Replace a step's connectors, keeping an approval's "re-run" list to steps before it. */
export function setNeeds(draft: Draft, key: string, needs: Need[]): Draft {
  const keys = needs.map(needKey);
  return {
    ...draft,
    workflow: {
      ...draft.workflow,
      steps: draft.workflow.steps.map((s) => {
        if (s.key !== key) return s;
        const next = { ...s, needs };
        return next.kind === "approval" ? { ...next, revises: next.revises.filter((r) => keys.includes(r) || isUpstream(draft.workflow, r, keys)) } : next;
      }),
    },
  };
}

/** Add a connector, or replace the one between the same two steps. */
export function connect(draft: Draft, from: string, to: string, opts: { port?: string; type?: Edge["type"] } = {}): Draft {
  const target = draft.workflow.steps.find((s) => s.key === to);
  if (!target) return draft;
  const source = draft.workflow.steps.find((s) => s.key === from);
  const port = opts.type === "error" ? undefined : (opts.port ?? (source ? portsOf(source)[0]?.key : undefined));
  const need = toNeed({ from, type: opts.type ?? "always", ...(port ? { port } : {}) });
  const others = (target.needs ?? []).filter((n) => needKey(n) !== from);
  return setNeeds(draft, to, [...others, need]);
}

export function disconnect(draft: Draft, from: string, to: string): Draft {
  const target = draft.workflow.steps.find((s) => s.key === to);
  return target ? setNeeds(draft, to, (target.needs ?? []).filter((n) => needKey(n) !== from)) : draft;
}

/** Change one connector's type, rules, output, note or label. */
export function updateEdge(draft: Draft, edge: Edge, patch: Partial<Omit<Edge, "from" | "to">>): Draft {
  const target = draft.workflow.steps.find((s) => s.key === edge.to);
  if (!target) return draft;
  const next = { ...edge, ...patch };
  const needs = (target.needs ?? []).map((n) => (needKey(n) === edge.from ? toNeed(next) : n));
  return setNeeds(draft, edge.to, needs);
}

function isUpstream(def: WorkflowDefinition, key: string, needs: string[]): boolean {
  const all = resolveNeeds(def);
  const seen = new Set<string>();
  const stack = [...needs];
  while (stack.length) {
    const k = stack.pop()!;
    if (k === key) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(all.get(k) ?? []));
  }
  return false;
}

export function removeStep(draft: Draft, key: string): Draft {
  const { [key]: _gone, ...layout } = draft.workflow.layout;
  const steps = draft.workflow.steps
    .filter((s) => s.key !== key)
    .map((s) => {
      const next = { ...s, needs: (s.needs ?? []).filter((n) => needKey(n) !== key) };
      if (next.loop?.to === key) delete next.loop;
      return next.kind === "approval" ? { ...next, revises: next.revises.filter((r) => r !== key) } : next;
    });
  const { output, ...rest } = draft.workflow;
  return { ...draft, workflow: { ...rest, steps, layout, ...(output && output !== key ? { output } : {}) } };
}

/** Replace a step. If its named outputs changed, connectors from outputs that are gone move to the first one. */
export function replaceStep(draft: Draft, key: string, step: Step): Draft {
  const ports = portsOf(step).map((p) => p.key);
  const steps = draft.workflow.steps.map((s) => {
    if (s.key === key) return step;
    if (!ports.length || !s.needs) return s;
    return {
      ...s,
      needs: s.needs.map((n) => (typeof n !== "string" && n.step === key && n.port && !ports.includes(n.port) ? { ...n, port: ports[0] } : n)),
    };
  });
  return { ...draft, workflow: { ...draft.workflow, steps } };
}

export function moveNode(draft: Draft, key: string, pos: NodePosition): Draft {
  return { ...draft, workflow: { ...draft.workflow, layout: { ...draft.workflow.layout, [key]: { x: Math.round(pos.x), y: Math.round(pos.y) } } } };
}

export function setNotes(draft: Draft, fn: (notes: CanvasNote[]) => CanvasNote[]): Draft {
  const notes = fn(draft.workflow.notes ?? []);
  const { notes: _n, ...rest } = draft.workflow;
  return { ...draft, workflow: notes.length ? { ...rest, notes } : rest };
}

/** The step whose output becomes the task's result: the chosen one, or the last step that writes. */
export const resultKey = (def: WorkflowDefinition) => def.output ?? [...def.steps].reverse().find((s) => ["role", "workspace", "merge", "text"].includes(s.kind))?.key;

export const nodeHeight = (s: Step) => {
  const n = portsOf(s).length;
  return n ? PORT_TOP + n * PORT_ROW + 8 : NODE_H;
};

/** Bounds of every node and note, for fitting the view. */
export function bounds(draft: Draft) {
  const boxes = [
    ...Object.entries(draft.workflow.layout).map(([k, p]) => {
      const s = draft.workflow.steps.find((x) => x.key === k);
      return { x: p.x, y: p.y, w: NODE_W, h: s ? nodeHeight(s) : NODE_H };
    }),
    ...(draft.workflow.notes ?? []).map((n) => ({ x: n.x, y: n.y, w: NOTE_W, h: 120 })),
  ];
  if (boxes.length === 0) return { x: 0, y: 0, w: NODE_W, h: NODE_H };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export const NOTE_W = 200;

/** Every box on the canvas: steps, the brief and notes. */
function boxesOf(draft: Draft) {
  return [
    ...Object.entries(draft.workflow.layout).map(([k, p]) => {
      const s = draft.workflow.steps.find((x) => x.key === k);
      return { x: p.x, y: p.y, w: NODE_W, h: s ? nodeHeight(s) : NODE_H };
    }),
    ...(draft.workflow.notes ?? []).map((n) => ({ x: n.x, y: n.y, w: NOTE_W, h: 120 })),
  ];
}

/** The first spot at or below (x, y) where a box of this size overlaps nothing. */
export function freeSpot(draft: Draft, x: number, y: number, w = NODE_W, h = NODE_H): NodePosition {
  const boxes = boxesOf(draft);
  const gap = 24;
  let top = y;
  for (let i = 0; i < 200; i++) {
    const hit = boxes.find((b) => x < b.x + b.w + gap && x + w + gap > b.x && top < b.y + b.h + gap && top + h + gap > b.y);
    if (!hit) return { x, y: top };
    top = hit.y + hit.h + gap;
  }
  return { x, y: top };
}

/** The lowest edge of anything on the canvas. */
export const bottomOf = (draft: Draft) => Math.max(0, ...boxesOf(draft).map((b) => b.y + b.h));

import { z } from "zod";
import { conditionSchema, testCondition, type Condition } from "./conditions";

/**
 * Workflows are data, not code: a DAG of steps (SRS 4.6). Because the
 * definition is declarative, the engine makes runs durable by checkpointing
 * each step's result; nothing has to be replayed.
 */

const stepKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, "Step keys are lowercase letters, digits and underscores, starting with a letter.");

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffMs: z.number().int().min(0).max(600_000).default(1_000),
  factor: z.number().min(1).max(10).default(2),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/** An output of an If/Switch or AI router node. "else", "other" and "error" are reserved. */
const portKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "Output keys are lowercase letters, digits and underscores, starting with a letter.")
  .refine((k) => !["else", "other", "error"].includes(k), "else, other and error are reserved output names.");

/**
 * A connector into a step (WF-009). A plain key is an "always" connector.
 * - always: taken when the step before finishes.
 * - if: taken only when `when` holds for the step before's output.
 * - else: taken when none of the "if" connectors leaving the same step (and output) are.
 * - error: taken only when the step before fails; the failure is then handled, not fatal.
 * `port` picks which output of an If/Switch or AI router node it leaves from.
 * `note` is an instruction for the next step about this input.
 */
export const connectorSchema = z.object({
  step: stepKey,
  type: z.enum(["always", "if", "else", "error"]).default("always"),
  when: conditionSchema.optional(),
  port: z.string().max(32).optional(),
  note: z.string().max(2_000).optional(),
  label: z.string().max(60).optional(),
});
export type Connector = z.infer<typeof connectorSchema>;
export type ConnectorType = Connector["type"];
export const needSchema = z.union([stepKey, connectorSchema]);
export type Need = z.infer<typeof needSchema>;

/**
 * A loop connector (WF-010): after this step finishes, run again from `to`
 * (an earlier step, or this one) until the rules hold for this step's output,
 * at most `max` rounds in all. Later steps wait for the last round.
 */
export const loopSchema = z.object({
  to: stepKey,
  /** Stop repeating once these hold. Without rules, it runs all `max` rounds. */
  until: conditionSchema.optional(),
  max: z.number().int().min(1).max(20).default(3),
  /** At the limit without the rules holding: carry on with the last round, or fail the task. */
  onMax: z.enum(["continue", "fail"]).default("continue"),
  /** Tell the step the loop starts at what the last round ended with. */
  carry: z.boolean().default(true),
  label: z.string().max(60).optional(),
});
export type Loop = z.infer<typeof loopSchema>;

const baseStep = {
  key: stepKey,
  /** Steps that must finish first, as keys or connectors. Omitted = the previous step (linear). */
  needs: z.array(needSchema).optional(),
  /** Skip the step, instead of failing, when its role has no node. Later steps see an empty output. */
  optional: z.boolean().default(false),
  /**
   * When several connectors arrive (WF-009):
   * - any (default): wait until each is decided, run if at least one was taken.
   * - all: run only if every one was taken.
   * - first: run as soon as one is taken.
   */
  join: z.enum(["any", "all", "first"]).optional(),
  /** Turned off: the step does not run and passes its input on. */
  disabled: z.boolean().optional(),
  /** Run again from an earlier step until rules hold (WF-010). */
  loop: loopSchema.optional(),
};

export const roleStepSchema = z.object({
  ...baseStep,
  kind: z.literal("role"),
  /** The role this step calls; workflows call roles, never specific models. */
  role: z.string().min(1),
  /** Template rendered with {{input.x}} and {{steps.key.output}}. */
  prompt: z.string().min(1),
  maxTokens: z.number().int().min(16).max(128_000).default(4_000),
  output: z.enum(["text", "json"]).default("text"),
  retry: retryPolicySchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  /** Per-call price for nodes that neither meter nor report usage (COST-004). */
  pricePerCallUsd: z.number().min(0).optional(),
});

export const approvalStepSchema = z.object({
  ...baseStep,
  kind: z.literal("approval"),
  title: z.string().min(1),
  /** Template shown to the approver. */
  show: z.string().default(""),
  /** Steps re-run with the approver's feedback when changes are requested (TASK-004). */
  revises: z.array(stepKey).default([]),
  /** A safety check: it reaches people even during quiet hours (NOTE-004). */
  urgent: z.boolean().default(false),
});

/** Calls one tool of the Tool-port node filling `role` (WF-001). The tool is chosen when the role is filled. */
export const toolStepSchema = z.object({
  ...baseStep,
  kind: z.literal("tool"),
  role: z.string().min(1),
  /** Tool arguments; each value is a template like the prompt of a role step. */
  args: z.record(z.string(), z.string()).default({}),
  retry: retryPolicySchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
  /** Overrides the connection's per-call price (COST-004). */
  pricePerCallUsd: z.number().min(0).optional(),
});

/**
 * Looks something up in the knowledge source filling `role` (Knowledge port,
 * SRS 4.11) and passes the passages on, numbered, with where each came from.
 * The source is chosen when the role is filled.
 */
export const lookupStepSchema = z.object({
  ...baseStep,
  kind: z.literal("lookup"),
  role: z.string().min(1),
  /** What to look for, as a template. */
  query: z.string().min(1).max(10_000),
  /** Most passages to pass on. */
  limit: z.number().int().min(1).max(20).default(5),
  retry: retryPolicySchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
  /** Overrides the connection's per-call price (COST-004). */
  pricePerCallUsd: z.number().min(0).optional(),
});

/**
 * Hands a task to the outside agent filling `role` (Agent port, SRS 4.11) and
 * waits for it, across restarts. Its questions reach the inbox and the answer
 * goes back to the agent (MESH-006). The skill is chosen when the role is filled.
 */
export const agentStepSchema = z.object({
  ...baseStep,
  kind: z.literal("agent"),
  role: z.string().min(1),
  /** What the agent should do, as a template. */
  prompt: z.string().min(1).max(50_000),
  /** Extra named values for the agent, each a template. */
  data: z.record(z.string(), z.string()).default({}),
  /** ask: questions go to the inbox. fail: a question fails the step. */
  onQuestion: z.enum(["ask", "fail"]).default("ask"),
  /** Most this step may spend; reserved before it starts (COST). Omitted = the connection's prices. */
  maxCostUsd: z.number().min(0).max(10_000).optional(),
  /** Outside runs are not idempotent, so a failed one is tried again only when this says so. */
  retry: retryPolicySchema.optional(),
  /** The whole run, including time waiting for answers. */
  timeoutMs: z.number().int().min(10_000).max(7 * 24 * 3_600_000).default(3_600_000),
});

/**
 * Starts a workflow in an outside engine (Workflow port, SRS 4.11) and waits
 * for its result: at once, by polling, or by callback. The workflow is chosen
 * when the role is filled.
 */
export const automationStepSchema = z.object({
  ...baseStep,
  kind: z.literal("automation"),
  role: z.string().min(1),
  /** Named values sent to the workflow, each a template. */
  inputs: z.record(z.string(), z.string()).default({}),
  maxCostUsd: z.number().min(0).max(10_000).optional(),
  retry: retryPolicySchema.optional(),
  timeoutMs: z.number().int().min(10_000).max(7 * 24 * 3_600_000).default(3_600_000),
});

/**
 * How often a workspace step runs the called task type.
 * - times: a fixed number of runs, `parallel` at once.
 * - each: one run per item of a list (JSON array, or one item per line) rendered from `items`.
 * - until: one run after another, each seeing the previous output as {{loop.previous}},
 *   until the output contains `stopWhen` or `max` runs are used up.
 */
export const repeatSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("times"),
    count: z.number().int().min(1).max(50),
    parallel: z.number().int().min(1).max(10).default(1),
  }),
  z.object({
    mode: z.literal("each"),
    items: z.string().min(1),
    max: z.number().int().min(1).max(100).default(20),
    parallel: z.number().int().min(1).max(10).default(3),
  }),
  z.object({
    mode: z.literal("until"),
    stopWhen: z.string().min(1).max(200),
    max: z.number().int().min(1).max(20).default(5),
  }),
]);
export type Repeat = z.infer<typeof repeatSchema>;

/**
 * Runs a task type of a workspace as a sub-task and waits for it: another
 * workspace, or this same one ("self"), which makes recursion possible.
 * Its output is the sub-task's output (a JSON array of outputs for times and each).
 */
export const workspaceStepSchema = z.object({
  ...baseStep,
  kind: z.literal("workspace"),
  /** "self" is this workspace, and survives export. Otherwise the id of a workspace in the same organisation. */
  workspace: z.union([z.literal("self"), z.string().uuid()]).default("self"),
  /** Key of the task type to run there. */
  taskType: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  /** The sub-task's brief: a template for each of the called task type's input fields. */
  inputs: z.record(z.string(), z.string()).default({}),
  /** Run the called workflow only up to this step and what it needs; that step's output is the result. */
  until: stepKey.optional(),
  repeat: repeatSchema.optional(),
  /** The whole call, including every repeat and any approvals inside it. */
  timeoutMs: z.number().int().min(60_000).max(7 * 24 * 3_600_000).default(24 * 3_600_000),
});

/**
 * If / Switch (WF-009): tests a value against each case's rules and takes the
 * matching outputs, or "else" when none match. With one case it is an If.
 */
export const branchStepSchema = z.object({
  ...baseStep,
  kind: z.literal("branch"),
  /** What to test, as a template. Empty = the output of the step before. */
  value: z.string().max(50_000).default(""),
  cases: z
    .array(z.object({ key: portKey, label: z.string().min(1).max(60), when: conditionSchema }))
    .min(1)
    .max(20),
  /** first: the first matching case only. all: every matching case, run in parallel. */
  mode: z.enum(["first", "all"]).default("first"),
});

/** AI router (WF-009): a model reads the value and picks one category; that output is taken. */
export const classifyStepSchema = z.object({
  ...baseStep,
  kind: z.literal("classify"),
  role: z.string().min(1),
  value: z.string().max(50_000).default(""),
  categories: z
    .array(z.object({ key: portKey, label: z.string().min(1).max(60), description: z.string().max(500).default("") }))
    .min(2)
    .max(20),
  /** Add an "other" output for answers that fit no category. Without it, such an answer fails the step. */
  other: z.boolean().default(true),
  maxTokens: z.number().int().min(16).max(2_000).default(64),
  retry: retryPolicySchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
  pricePerCallUsd: z.number().min(0).optional(),
});

/** Merge (WF-009): brings branches back together without a model. */
export const mergeStepSchema = z.object({
  ...baseStep,
  kind: z.literal("merge"),
  /** first: the first non-empty input (after an If, the branch that ran). concat: all of them. json: an object by step. */
  mode: z.enum(["first", "concat", "json"]).default("first"),
  separator: z.string().max(40).default("\n\n"),
});

/** Text (WF-009): writes its output from a template, with no model and no cost. */
export const textStepSchema = z.object({
  ...baseStep,
  kind: z.literal("text"),
  template: z.string().min(1).max(50_000),
});

/** Stop (WF-009): ends the task here, as done with a result or as failed with a reason. */
export const stopStepSchema = z.object({
  ...baseStep,
  kind: z.literal("stop"),
  outcome: z.enum(["succeed", "fail"]).default("succeed"),
  message: z.string().max(10_000).default(""),
});

export const stepSchema = z.discriminatedUnion("kind", [
  roleStepSchema,
  approvalStepSchema,
  toolStepSchema,
  lookupStepSchema,
  workspaceStepSchema,
  agentStepSchema,
  automationStepSchema,
  branchStepSchema,
  classifyStepSchema,
  mergeStepSchema,
  textStepSchema,
  stopStepSchema,
]);
export type BranchStep = z.infer<typeof branchStepSchema>;
export type ClassifyStep = z.infer<typeof classifyStepSchema>;
export type MergeStep = z.infer<typeof mergeStepSchema>;
export type TextStep = z.infer<typeof textStepSchema>;
export type StopStep = z.infer<typeof stopStepSchema>;
export type RoleStep = z.infer<typeof roleStepSchema>;
export type ApprovalStep = z.infer<typeof approvalStepSchema>;
export type ToolStep = z.infer<typeof toolStepSchema>;
export type LookupStep = z.infer<typeof lookupStepSchema>;
export type WorkspaceStep = z.infer<typeof workspaceStepSchema>;
export type AgentStep = z.infer<typeof agentStepSchema>;
export type AutomationStep = z.infer<typeof automationStepSchema>;
/** Steps that hand work to an outside node and wait for it. */
export type ExternalStep = AgentStep | AutomationStep;
/** The port a role must be filled on for a step kind, or null when the step calls no role. */
export function portForStep(s: Step): "model@1" | "tool@1" | "agent@1" | "workflow@1" | "knowledge@1" | null {
  switch (s.kind) {
    case "role":
    case "classify":
      return "model@1";
    case "tool":
      return "tool@1";
    case "lookup":
      return "knowledge@1";
    case "agent":
      return "agent@1";
    case "automation":
      return "workflow@1";
    default:
      return null;
  }
}
export type Step = z.infer<typeof stepSchema>;
export type StepKind = Step["kind"];

/** Where the node editor draws a step. Only the editor reads it. */
export const nodePositionSchema = z.object({ x: z.number().min(-100_000).max(100_000), y: z.number().min(-100_000).max(100_000) });
export type NodePosition = z.infer<typeof nodePositionSchema>;

/** A sticky note on the canvas. Only the editor reads it. */
export const canvasNoteSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/i),
  x: z.number().min(-100_000).max(100_000),
  y: z.number().min(-100_000).max(100_000),
  text: z.string().max(4_000).default(""),
});
export type CanvasNote = z.infer<typeof canvasNoteSchema>;

/** Steps whose failure a connector can catch: the ones that call something. */
export const canFail = (s: Step) =>
  s.kind === "role" || s.kind === "tool" || s.kind === "lookup" || s.kind === "workspace" || s.kind === "classify" || s.kind === "agent" || s.kind === "automation";

/** The named outputs of a step: an If/Switch's cases and "else", an AI router's categories and "other". */
export function portsOf(s: Step): { key: string; label: string }[] {
  if (s.kind === "branch") return [...s.cases.map((c) => ({ key: c.key, label: c.label })), { key: "else", label: "Else" }];
  if (s.kind === "classify") return [...s.categories.map((c) => ({ key: c.key, label: c.label })), ...(s.other ? [{ key: "other", label: "Other" }] : [])];
  return [];
}

export const needKey = (n: Need): string => (typeof n === "string" ? n : n.step);

/** A connector with both ends named. */
export interface Edge {
  from: string;
  to: string;
  type: ConnectorType;
  when?: Condition;
  port?: string;
  note?: string;
  label?: string;
}

/** Every connector in the workflow, with the linear default written out. */
export function edgesOf(def: Pick<WorkflowDefinition, "steps">): Edge[] {
  return def.steps.flatMap((step, i) => {
    const prev = def.steps[i - 1];
    const needs: Need[] = step.needs ?? (prev ? [prev.key] : []);
    return needs.map((n): Edge => {
      if (typeof n === "string") return { from: n, to: step.key, type: "always" };
      const { step: from, ...rest } = n;
      return { from, to: step.key, ...rest, type: rest.type ?? "always" };
    });
  });
}

/** A connector in its stored form: a plain key when it carries nothing but "always". */
export function toNeed(e: Omit<Edge, "to">): Need {
  const extra = e.type !== "always" || e.port || e.note || e.label || e.when;
  if (!extra) return e.from;
  return {
    step: e.from,
    type: e.type,
    ...(e.type === "if" && e.when ? { when: e.when } : {}),
    ...(e.port ? { port: e.port } : {}),
    ...(e.note ? { note: e.note } : {}),
    ...(e.label ? { label: e.label } : {}),
  };
}

/**
 * Whether a connector is taken, given the step before's state. Shared by the
 * engine and the editor. `chosen` is the outputs an If/Switch or router took.
 */
export function connectorTaken(
  edge: Edge,
  source: { status: "succeeded" | "skipped" | "failed" | "not_taken"; output: string; chosen?: string[] },
  siblings: Edge[],
): boolean {
  if (source.status === "not_taken") return false;
  if (source.status === "failed") return edge.type === "error";
  if (edge.type === "error") return false;
  // A skipped step (no node, or turned off) passes through: every output is open.
  if (edge.port && source.status === "succeeded" && source.chosen && !source.chosen.includes(edge.port)) return false;
  if (edge.type === "if") return !!edge.when && testCondition(edge.when, source.output);
  if (edge.type === "else") {
    return !siblings.some((e) => e.type === "if" && (e.port ?? "") === (edge.port ?? "") && !!e.when && testCondition(e.when, source.output));
  }
  return true;
}

export const workflowDefinitionSchema = z
  .object({
    version: z.literal(1),
    steps: z.array(stepSchema).min(1).max(200),
    /** Which step's output becomes the run's output. Defaults to the last step that produces text. */
    output: stepKey.optional(),
    /** Node positions for the editor, by step key. The brief's node is "_brief". */
    layout: z.record(z.string(), nodePositionSchema).optional(),
    /** Sticky notes on the canvas. */
    notes: z.array(canvasNoteSchema).max(100).optional(),
  })
  .superRefine((def, ctx) => {
    const keys = new Set<string>();
    for (const step of def.steps) {
      if (keys.has(step.key)) {
        ctx.addIssue({ code: "custom", message: `Duplicate step key "${step.key}".` });
      }
      keys.add(step.key);
    }
    for (const step of def.steps) {
      for (const dep of (step.needs ?? []).map(needKey)) {
        if (!keys.has(dep)) ctx.addIssue({ code: "custom", message: `Step "${step.key}" needs unknown step "${dep}".` });
        if (dep === step.key) ctx.addIssue({ code: "custom", message: `Step "${step.key}" cannot need itself.` });
      }
      if (step.kind === "approval") {
        for (const r of step.revises) {
          if (!keys.has(r)) ctx.addIssue({ code: "custom", message: `Approval "${step.key}" revises unknown step "${r}".` });
        }
      }
    }
    const byKey = new Map(def.steps.map((st) => [st.key, st]));
    for (const step of def.steps) {
      const seen = new Set<string>();
      for (const from of (step.needs ?? []).map(needKey)) {
        if (seen.has(from)) ctx.addIssue({ code: "custom", message: `Step "${step.key}" is connected from "${from}" twice.` });
        seen.add(from);
      }
      if (step.kind === "branch" && new Set(step.cases.map((c) => c.key)).size !== step.cases.length) {
        ctx.addIssue({ code: "custom", message: `Step "${step.key}" has two cases with the same key.` });
      }
      if (step.kind === "classify" && new Set(step.categories.map((c) => c.key)).size !== step.categories.length) {
        ctx.addIssue({ code: "custom", message: `Step "${step.key}" has two categories with the same key.` });
      }
    }
    for (const step of def.steps) {
      if (!step.loop) continue;
      if (step.kind === "stop") ctx.addIssue({ code: "custom", message: `The Stop step "${step.key}" cannot loop.` });
      else if (!byKey.has(step.loop.to)) ctx.addIssue({ code: "custom", message: `Step "${step.key}" loops back to unknown step "${step.loop.to}".` });
      else if (!upstreamOf(def as WorkflowDefinition, step.key).has(step.loop.to)) {
        ctx.addIssue({ code: "custom", message: `Step "${step.key}" can only loop back to itself or a step that runs before it, not "${step.loop.to}".` });
      }
    }
    // Every connector, the implicit "previous step" ones included.
    for (const e of edgesOf(def as WorkflowDefinition)) {
      const source = byKey.get(e.from);
      if (!source) continue;
      if (source.kind === "stop") ctx.addIssue({ code: "custom", message: `Nothing can run after the Stop step "${e.from}".` });
      if (e.type === "if" && !e.when) ctx.addIssue({ code: "custom", message: `The connector from "${e.from}" to "${e.to}" is "Only if" but has no rule.` });
      if (e.type === "error" && !canFail(source)) ctx.addIssue({ code: "custom", message: `"${e.from}" cannot fail, so an "On failure" connector from it never runs.` });
      const ports = portsOf(source).map((p) => p.key);
      if (e.port && !ports.includes(e.port)) ctx.addIssue({ code: "custom", message: `"${e.from}" has no output "${e.port}".` });
      if (!e.port && ports.length && e.type !== "error") ctx.addIssue({ code: "custom", message: `Choose which output of "${e.from}" connects to "${e.to}".` });
    }
    for (const step of def.steps) {
      if (step.kind === "workspace" && step.repeat?.mode === "each" && !/\{\{\s*(input|steps)\./i.test(step.repeat.items)) {
        ctx.addIssue({ code: "custom", message: `Step "${step.key}" repeats for each item of a list, but its list names no input or step.` });
      }
    }
    if (def.output && !keys.has(def.output)) {
      ctx.addIssue({ code: "custom", message: `Workflow output names unknown step "${def.output}".` });
    }
    const cycle = findCycle(resolveNeeds(def as WorkflowDefinition));
    if (cycle) ctx.addIssue({ code: "custom", message: `Steps form a cycle: ${cycle.join(" -> ")}.` });
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Dependencies of each step with the linear default applied. */
export function resolveNeeds(def: Pick<WorkflowDefinition, "steps">): Map<string, string[]> {
  const needs = new Map<string, string[]>();
  def.steps.forEach((step, i) => {
    const prev = def.steps[i - 1];
    needs.set(step.key, step.needs ? step.needs.map(needKey) : prev ? [prev.key] : []);
  });
  return needs;
}

/** `key` and every step it needs, directly or transitively. */
export function upstreamOf(def: Pick<WorkflowDefinition, "steps">, key: string): Set<string> {
  const needs = resolveNeeds(def);
  const result = new Set<string>();
  const visit = (k: string) => {
    if (result.has(k)) return;
    result.add(k);
    for (const d of needs.get(k) ?? []) visit(d);
  };
  visit(key);
  return result;
}

/**
 * The workflow cut down to `until` and what it needs, for running a task
 * type "up to a step". Every step's needs are written out, because the
 * linear default would otherwise point at steps that were cut.
 */
export function truncateWorkflow(def: WorkflowDefinition, until: string): WorkflowDefinition {
  const keep = upstreamOf(def, until);
  return {
    version: 1,
    steps: def.steps
      .map((s, i): Step => ({ ...s, needs: s.needs ?? (def.steps[i - 1] ? [def.steps[i - 1]!.key] : []) }))
      .filter((s) => keep.has(s.key))
      .map((s) => {
        const next = { ...s, needs: (s.needs ?? []).filter((n) => keep.has(needKey(n))) };
        return next.kind === "approval" ? { ...next, revises: next.revises.filter((r) => keep.has(r)) } : next;
      }),
    output: until,
  };
}

/** The same workflow with every step's needs written out, so it reads the same as a graph. */
export function explicitNeeds(def: WorkflowDefinition): WorkflowDefinition {
  return { ...def, steps: def.steps.map((s, i) => ({ ...s, needs: s.needs ?? (def.steps[i - 1] ? [def.steps[i - 1]!.key] : []) })) };
}

/**
 * The steps a loop runs again: `to` and everything after it. Steps after the
 * loop's end wait for its last round, so re-running them is harmless; side
 * branches that already ran see each round too.
 */
export function loopBody(def: Pick<WorkflowDefinition, "steps">, step: Pick<Step, "key" | "loop">): Set<string> {
  if (!step.loop) return new Set();
  return downstreamOf(def, [step.loop.to]);
}

/** The steps between a loop's start and its end, both included: what one round is. */
export function loopRound(def: Pick<WorkflowDefinition, "steps">, step: Pick<Step, "key" | "loop">): Set<string> {
  if (!step.loop) return new Set();
  const up = upstreamOf(def, step.key);
  return new Set([...downstreamOf(def, [step.loop.to])].filter((k) => up.has(k)));
}

/** True when adding the edge from -> to (to needs from) would make a cycle. */
export function wouldCycle(def: Pick<WorkflowDefinition, "steps">, from: string, to: string): boolean {
  return from === to || upstreamOf(def, from).has(to);
}

/**
 * Rename a step and every reference to it: needs, revises, the output,
 * the layout and {{steps.key...}} in templates.
 */
export function renameStep(def: WorkflowDefinition, from: string, to: string): WorkflowDefinition {
  const ref = new RegExp(`(\\{\\{\\s*steps\\.)${from}(?=[.\\s}])`, "gi");
  const swap = (k: string) => (k === from ? to : k);
  const text = (t: string) => t.replace(ref, `$1${to}`);
  const steps = def.steps.map((s): Step => {
    const base = {
      ...s,
      key: swap(s.key),
      ...(s.needs ? { needs: s.needs.map((n) => (typeof n === "string" ? swap(n) : { ...n, step: swap(n.step) })) } : {}),
      ...(s.loop ? { loop: { ...s.loop, to: swap(s.loop.to) } } : {}),
    };
    switch (base.kind) {
      case "role":
        return { ...base, prompt: text(base.prompt) };
      case "approval":
        return { ...base, show: text(base.show), revises: base.revises.map(swap) };
      case "tool":
        return { ...base, args: Object.fromEntries(Object.entries(base.args).map(([k, v]) => [k, text(v)])) };
      case "lookup":
        return { ...base, query: text(base.query) };
      case "agent":
        return { ...base, prompt: text(base.prompt), data: Object.fromEntries(Object.entries(base.data).map(([k, v]) => [k, text(v)])) };
      case "automation":
        return { ...base, inputs: Object.fromEntries(Object.entries(base.inputs).map(([k, v]) => [k, text(v)])) };
      case "workspace":
        return {
          ...base,
          inputs: Object.fromEntries(Object.entries(base.inputs).map(([k, v]) => [k, text(v)])),
          ...(base.repeat?.mode === "each" ? { repeat: { ...base.repeat, items: text(base.repeat.items) } } : {}),
        };
      case "branch":
      case "classify":
        return { ...base, value: text(base.value) };
      case "text":
        return { ...base, template: text(base.template) };
      case "stop":
        return { ...base, message: text(base.message) };
      case "merge":
        return base;
    }
  });
  const layout = def.layout ? Object.fromEntries(Object.entries(def.layout).map(([k, v]) => [swap(k), v])) : undefined;
  return { ...def, steps, ...(def.output ? { output: swap(def.output) } : {}), ...(layout ? { layout } : {}) };
}

/**
 * Positions for steps the layout does not place: columns by how deep a step
 * is in the graph, rows in definition order. The brief sits in column 0.
 * With `heightOf`, tall nodes (many outputs) push the next row down so nodes never overlap.
 */
export function autoLayout(
  def: Pick<WorkflowDefinition, "steps" | "layout">,
  gapX = 280,
  gapY = 132,
  heightOf?: (s: Step) => number,
): Record<string, NodePosition> {
  const needs = resolveNeeds(def);
  const depth = new Map<string, number>();
  const depthOf = (k: string, seen = new Set<string>()): number => {
    const known = depth.get(k);
    if (known !== undefined) return known;
    if (seen.has(k)) return 0;
    seen.add(k);
    const d = 1 + Math.max(0, ...(needs.get(k) ?? []).map((n) => depthOf(n, seen)));
    depth.set(k, d);
    return d;
  };
  // The next free y in each column.
  const next = new Map<number, number>();
  const out: Record<string, NodePosition> = { _brief: def.layout?._brief ?? { x: 40, y: 40 } };
  for (const step of def.steps) {
    const d = depthOf(step.key);
    const y = next.get(d) ?? 40;
    next.set(d, y + (heightOf ? Math.max(gapY, heightOf(step) + 54) : gapY));
    out[step.key] = def.layout?.[step.key] ?? { x: 40 + d * gapX, y };
  }
  return out;
}

/** Every step that depends on `key`, directly or transitively. */
export function downstreamOf(def: Pick<WorkflowDefinition, "steps">, keys: string[]): Set<string> {
  const needs = resolveNeeds(def);
  const result = new Set<string>(keys);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [step, deps] of needs) {
      if (!result.has(step) && deps.some((d) => result.has(d))) {
        result.add(step);
        grew = true;
      }
    }
  }
  return result;
}

function findCycle(needs: Map<string, string[]>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    const s = state.get(node);
    if (s === "done") return null;
    if (s === "visiting") return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, "visiting");
    stack.push(node);
    for (const dep of needs.get(node) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of needs.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------------ Task types, roles

export const inputFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string(),
  type: z.enum(["text", "longtext"]).default("text"),
  required: z.boolean().default(true),
  placeholder: z.string().optional(),
});
export type InputField = z.infer<typeof inputFieldSchema>;

export const taskTypeTemplateSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string(),
  description: z.string().default(""),
  inputFields: z.array(inputFieldSchema).min(1),
  workflow: workflowDefinitionSchema,
});
export type TaskTypeTemplate = z.infer<typeof taskTypeTemplateSchema>;

export const roleTemplateSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string(),
  description: z.string().default(""),
  instructions: z.string().default(""),
  /** The port a node must implement to fill this role (MKT-006). */
  port: z.enum(["model@1", "tool@1", "agent@1", "workflow@1", "knowledge@1"]).default("model@1"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});
export type RoleTemplate = z.infer<typeof roleTemplateSchema>;

export const workspaceTemplateSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  roles: z.array(roleTemplateSchema).min(1),
  taskTypes: z.array(taskTypeTemplateSchema).min(1),
  budget: z.object({ taskUsd: z.number().positive(), monthUsd: z.number().positive() }),
});
export type WorkspaceTemplate = z.infer<typeof workspaceTemplateSchema>;

/** Validate a brief against a task type's fields (TASK-001). Returns error messages. */
export function validateBrief(fields: InputField[], brief: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    const value = brief[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.required) errors.push(`${field.label} is required.`);
      continue;
    }
    if (typeof value !== "string") errors.push(`${field.label} must be text.`);
    else if (value.length > 50_000) errors.push(`${field.label} is longer than 50,000 characters.`);
  }
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(brief)) {
    if (!known.has(key)) errors.push(`Unknown field "${key}".`);
  }
  return errors;
}

import { describe, expect, it } from "vitest";
import { describeCondition, testCondition, testRule } from "./conditions";
import { autoLayout, connectorTaken, edgesOf, loopBody, loopRound, explicitNeeds, renameStep, truncateWorkflow, workflowDefinitionSchema, wouldCycle, type WorkflowDefinition } from "./workflow";

const def: WorkflowDefinition = workflowDefinitionSchema.parse({
  version: 1,
  steps: [
    { kind: "role", key: "research", role: "r", prompt: "About {{input.topic}}" },
    { kind: "role", key: "draft", role: "w", prompt: "Write from {{steps.research.output}} and {{ steps.research }}" },
    { kind: "role", key: "fact", role: "r", prompt: "Check {{steps.research.output}}", needs: ["research"] },
    { kind: "approval", key: "review", title: "Review", show: "{{steps.draft.output}}", revises: ["draft"], needs: ["draft", "fact"] },
  ],
  layout: { research: { x: 1, y: 2 } },
});

describe("workflow graph helpers", () => {
  it("cuts a workflow down to a step and what it needs, writing every dependency out", () => {
    const cut = truncateWorkflow(def, "draft");
    expect(cut.steps.map((s) => [s.key, s.needs])).toEqual([
      ["research", []],
      ["draft", ["research"]],
    ]);
    expect(cut.output).toBe("draft");
    expect(workflowDefinitionSchema.safeParse(cut).success).toBe(true);
  });

  it("finds cycles before they are drawn", () => {
    expect(wouldCycle(def, "review", "research")).toBe(true);
    expect(wouldCycle(def, "draft", "draft")).toBe(true);
    expect(wouldCycle(def, "fact", "draft")).toBe(false);
  });

  it("renames a step everywhere it is used", () => {
    const next = renameStep(explicitNeeds(def), "research", "dig");
    expect(next.steps.map((s) => s.key)).toEqual(["dig", "draft", "fact", "review"]);
    const draft = next.steps[1]!;
    expect(draft.kind === "role" && draft.prompt).toBe("Write from {{steps.dig.output}} and {{ steps.dig }}");
    expect(next.steps[2]!.needs).toEqual(["dig"]);
    expect(next.layout).toEqual({ dig: { x: 1, y: 2 } });
    // A key that only starts the same is left alone.
    const other = renameStep(def, "draft", "d2");
    expect(other.steps[3]!.kind === "approval" && other.steps[3]!.revises).toEqual(["d2"]);
  });

  it("places unplaced steps in columns by depth, keeping saved positions", () => {
    const pos = autoLayout(def);
    expect(pos.research).toEqual({ x: 1, y: 2 });
    expect(pos.draft!.x).toBe(pos.fact!.x);
    expect(pos.draft!.y).not.toBe(pos.fact!.y);
    expect(pos.review!.x).toBeGreaterThan(pos.draft!.x);
    expect(pos._brief).toEqual({ x: 40, y: 40 });
  });

  it("accepts workspace steps with repeats, and rejects a list that names nothing", () => {
    const base = { kind: "workspace", key: "call", taskType: "custom", inputs: { request: "{{loop.item}}" } };
    expect(workflowDefinitionSchema.safeParse({ version: 1, steps: [{ ...base, repeat: { mode: "each", items: "{{steps.x.output}}" } }, { kind: "role", key: "x", role: "r", prompt: "p" }] }).success).toBe(true);
    const bad = workflowDefinitionSchema.safeParse({ version: 1, steps: [{ ...base, repeat: { mode: "each", items: "a, b" } }] });
    expect(bad.success).toBe(false);
    expect(workflowDefinitionSchema.parse({ version: 1, steps: [base] }).steps[0]).toMatchObject({ workspace: "self", timeoutMs: 86_400_000 });
  });
});

describe("rules and connectors (WF-009)", () => {
  const r = (op: string, value = "", field = "", ignoreCase = true) => ({ op, value, field, ignoreCase }) as Parameters<typeof testRule>[0];

  it("tests text, numbers, yes/no and JSON fields", () => {
    expect(testRule(r("contains", "REFUND"), "I want a refund")).toBe(true);
    expect(testRule(r("contains", "REFUND", "", false), "I want a refund")).toBe(false);
    expect(testRule(r("gt", "7"), "Score: 8/10")).toBe(true);
    expect(testRule(r("lte", "7"), "Score: 8/10")).toBe(false);
    expect(testRule(r("true"), "Yes.")).toBe(true);
    expect(testRule(r("false"), "no")).toBe(true);
    expect(testRule(r("gte", "0.5", "result.score"), '{"result":{"score":0.7}}')).toBe(true);
    expect(testRule(r("equals", "b", "items[1]"), '{"items":["a","b"]}')).toBe(true);
    expect(testRule(r("empty", "", "missing"), '{"x":1}')).toBe(true);
    expect(testRule(r("gt", "1", "x"), "not json")).toBe(false);
    expect(testCondition({ match: "any", rules: [r("contains", "a"), r("contains", "z")] }, "abc")).toBe(true);
    expect(testCondition({ match: "all", rules: [r("contains", "a"), r("contains", "z")] }, "abc")).toBe(false);
    expect(describeCondition({ match: "any", rules: [r("contains", "a"), r("gt", "3", "score")] })).toBe('contains "a" or score is more than "3"');
  });

  it("decides connectors: Only if, Otherwise, On failure and outputs", () => {
    const when = { match: "all" as const, rules: [r("contains", "yes")] };
    const ifEdge = { from: "a", to: "b", type: "if" as const, when };
    const elseEdge = { from: "a", to: "c", type: "else" as const };
    const siblings = [ifEdge, elseEdge];
    const ok = (output: string) => ({ status: "succeeded" as const, output });
    expect(connectorTaken(ifEdge, ok("yes please"), siblings)).toBe(true);
    expect(connectorTaken(elseEdge, ok("yes please"), siblings)).toBe(false);
    expect(connectorTaken(elseEdge, ok("nope"), siblings)).toBe(true);
    expect(connectorTaken({ from: "a", to: "d", type: "error" }, { status: "failed", output: "boom" }, [])).toBe(true);
    expect(connectorTaken({ from: "a", to: "d", type: "always" }, { status: "failed", output: "boom" }, [])).toBe(false);
    expect(connectorTaken({ from: "a", to: "d", type: "always", port: "x" }, { status: "succeeded", output: "", chosen: ["y"] }, [])).toBe(false);
    expect(connectorTaken({ from: "a", to: "d", type: "always" }, { status: "not_taken", output: "" }, [])).toBe(false);
  });

  it("refuses connectors that cannot work", () => {
    const issues = (steps: unknown[]) => {
      const res = workflowDefinitionSchema.safeParse({ version: 1, steps });
      return res.success ? [] : res.error.issues.map((i) => i.message);
    };
    const branch = { kind: "branch", key: "b", cases: [{ key: "x", label: "X", when: { rules: [{ op: "empty" }] } }] };
    expect(issues([branch, { kind: "text", key: "t", template: "t", needs: ["b"] }])).toEqual(['Choose which output of "b" connects to "t".']);
    expect(issues([branch, { kind: "text", key: "t", template: "t", needs: [{ step: "b", port: "nope" }] }])).toEqual(['"b" has no output "nope".']);
    expect(issues([{ kind: "text", key: "a", template: "a" }, { kind: "text", key: "t", template: "t", needs: [{ step: "a", type: "error" }] }])).toEqual([
      '"a" cannot fail, so an "On failure" connector from it never runs.',
    ]);
    expect(issues([{ kind: "text", key: "a", template: "a" }, { kind: "text", key: "t", template: "t", needs: [{ step: "a", type: "if" }] }])).toEqual([
      'The connector from "a" to "t" is "Only if" but has no rule.',
    ]);
    expect(issues([{ kind: "stop", key: "s" }, { kind: "text", key: "t", template: "t" }])).toEqual(['Nothing can run after the Stop step "s".']);
  });

  it("keeps connector details when renaming and cutting", () => {
    const d = workflowDefinitionSchema.parse({
      version: 1,
      steps: [
        { kind: "role", key: "a", role: "r", prompt: "p" },
        { kind: "text", key: "b", template: "{{steps.a.output}}", needs: [{ step: "a", type: "if", note: "n", when: { rules: [{ op: "not_empty" }] } }] },
      ],
    });
    const renamed = renameStep(d, "a", "z");
    expect(renamed.steps[1]!.needs).toEqual([{ step: "z", type: "if", note: "n", when: { match: "all", rules: [{ op: "not_empty", field: "", value: "", ignoreCase: true }] } }]);
    expect(edgesOf(truncateWorkflow(d, "b"))[0]).toMatchObject({ from: "a", to: "b", type: "if", note: "n" });
  });
});

describe("loops (WF-010)", () => {
  const d = workflowDefinitionSchema.parse({
    version: 1,
    steps: [
      { kind: "role", key: "draft", role: "r", prompt: "p" },
      { kind: "role", key: "side", role: "r", prompt: "p", needs: ["draft"] },
      { kind: "role", key: "check", role: "r", prompt: "p", needs: ["draft"], loop: { to: "draft" } },
      { kind: "text", key: "after", template: "t", needs: ["check"] },
    ],
  });
  const check = d.steps[2]!;

  it("knows one round and everything a repeat re-runs", () => {
    expect([...loopRound(d, check)].sort()).toEqual(["check", "draft"]);
    expect([...loopBody(d, check)].sort()).toEqual(["after", "check", "draft", "side"]);
    expect(check.loop).toEqual({ to: "draft", max: 3, onMax: "continue", carry: true });
  });

  it("keeps the loop when the step it returns to is renamed", () => {
    expect(renameStep(d, "draft", "write").steps[2]!.loop!.to).toBe("write");
  });
});

describe("layout", () => {
  it("leaves room under tall nodes so nothing overlaps", () => {
    const d = workflowDefinitionSchema.parse({
      version: 1,
      steps: [
        { kind: "text", key: "a", template: "a" },
        { kind: "text", key: "b", template: "b", needs: [] },
      ],
    });
    // Both sit in column 1; the first is 300 tall, so the second starts below it.
    const pos = autoLayout(d, 280, 132, (s) => (s.key === "a" ? 300 : 78));
    expect(pos.a).toEqual({ x: 320, y: 40 });
    expect(pos.b!.y).toBeGreaterThanOrEqual(40 + 300);
  });
});

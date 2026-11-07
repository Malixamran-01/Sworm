import { workflowDefinitionSchema, type InputField, type WorkflowDefinition } from "@conclave/contract";
import { afterEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "./test-helpers";

/** Branches, connectors and logic nodes (WF-009), run end to end on the mock model. */

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const request: InputField[] = [{ key: "request", label: "Request", type: "text", required: true }];
const rule = (op: string, value = "", field = "") => ({ match: "all" as const, rules: [{ op, value, field, ignoreCase: true }] });
const role = (key: string, prompt: string, extra: Record<string, unknown> = {}) => ({ kind: "role", key, role: "assistant", prompt, ...extra });
const text = (key: string, template: string, extra: Record<string, unknown> = {}) => ({ kind: "text", key, template, ...extra });

/** A workspace whose one task type runs these steps; the steps go through the schema, so defaults apply. */
async function workflow(steps: unknown[]) {
  const ws = await h.conclave.workspaces.create(h.actor, { blank: true, name: "Logic", defaultNode: { connectionId: h.connectionId, model: "mock-small" } });
  const def = workflowDefinitionSchema.parse({ version: 1, steps }) as WorkflowDefinition;
  const saved = await h.conclave.workspaces.saveTaskType(h.actor, ws.id, "custom", { key: "custom", name: "Logic", inputFields: request, workflow: def });
  const taskTypeId = saved.taskTypes[0]!.id;
  return async (value: string) => {
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: value } });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    const latest = new Map(run.steps.filter((s) => s.status !== "superseded").map((s) => [s.key, s]));
    return { run, status: (k: string) => latest.get(k)?.status, output: (k: string) => latest.get(k)?.output };
  };
}

describe("If / Switch and Merge", () => {
  it("takes one branch, skips the other, and merges whichever ran", async () => {
    h = await harness();
    const run = await workflow([
      { kind: "branch", key: "check", value: "{{input.request}}", cases: [{ key: "urgent", label: "Urgent", when: rule("contains", "urgent") }] },
      role("fast", "Rush: {{input.request}}", { needs: [{ step: "check", port: "urgent" }] }),
      role("slow", "Later: {{input.request}}", { needs: [{ step: "check", port: "else" }] }),
      { kind: "merge", key: "result", needs: ["fast", "slow"] },
    ]);

    let r = await run("URGENT: the roof leaks");
    expect(r.run.status).toBe("succeeded");
    expect([r.status("fast"), r.status("slow"), r.status("result")]).toEqual(["succeeded", "not_taken", "succeeded"]);
    expect(r.run.steps.find((s) => s.key === "check")!.nodeLabel).toBe("Took Urgent");
    expect(r.run.output).toBe("[mock-small] Rush: URGENT: the roof leaks");
    expect(r.run.stepsDone).toBe(4);

    r = await run("tidy the desk");
    expect([r.status("fast"), r.status("slow")]).toEqual(["not_taken", "succeeded"]);
    expect(r.run.output).toBe("[mock-small] Later: tidy the desk");
  });

  it("can take every matching case of a switch", async () => {
    h = await harness();
    const run = await workflow([
      {
        kind: "branch",
        key: "route",
        value: "{{input.request}}",
        mode: "all",
        cases: [
          { key: "sales", label: "Sales", when: rule("contains", "price") },
          { key: "legal", label: "Legal", when: rule("contains", "contract") },
        ],
      },
      text("to_sales", "S", { needs: [{ step: "route", port: "sales" }] }),
      text("to_legal", "L", { needs: [{ step: "route", port: "legal" }] }),
      text("to_else", "E", { needs: [{ step: "route", port: "else" }] }),
      { kind: "merge", key: "all", mode: "concat", separator: "+", needs: ["to_sales", "to_legal", "to_else"] },
    ]);
    const r = await run("the price in the contract");
    expect(r.run.output).toBe("S+L");
    expect(r.status("to_else")).toBe("not_taken");
  });
});

describe("connectors", () => {
  it("follows Only if and Otherwise connectors, and passes connector notes to the next step", async () => {
    h = await harness();
    const run = await workflow([
      role("draft", "{{input.request}}"),
      text("yes", "Yes: {{steps.draft.output}}", { needs: [{ step: "draft", type: "if", when: rule("contains", "approve") }] }),
      text("no", "No", { needs: [{ step: "draft", type: "else" }] }),
      role("polish", "Polish {{steps.draft.output}}", { needs: [{ step: "draft", note: "Keep it under 50 words." }] }),
    ]);
    const r = await run("please approve the plan");
    expect([r.status("yes"), r.status("no")]).toEqual(["succeeded", "not_taken"]);
    const polish = await h.conclave.db.query<{ input: { prompt: string } }>(`select input from run_steps where step_key = 'polish'`);
    expect(polish[0]!.input.prompt).toContain("Notes on your inputs:\n- From Draft: Keep it under 50 words.");

    const other = await run("nothing to see");
    expect([other.status("yes"), other.status("no")]).toEqual(["not_taken", "succeeded"]);
  });

  it("tests a field of a JSON output", async () => {
    h = await harness();
    const run = await workflow([
      role("score", "{{input.request}}", { output: "json" }),
      text("big", "big", { needs: [{ step: "score", type: "if", when: rule("contains", "mock", "model") }] }),
    ]);
    // The mock's JSON answer is {"model": "mock-small", ...}.
    expect((await run("anything")).status("big")).toBe("succeeded");
  });

  it("catches a failure with an On failure connector; without one the task fails", async () => {
    h = await harness();
    let run = await workflow([
      role("risky", "[[refuse]] {{input.request}}"),
      text("after", "fine", { needs: ["risky"] }),
      text("rescue", "Recovered: {{steps.risky.output}}", { needs: [{ step: "risky", type: "error" }] }),
    ]);
    let r = await run("go");
    expect(r.run.status).toBe("succeeded");
    expect([r.status("risky"), r.status("after"), r.status("rescue")]).toEqual(["failed", "not_taken", "succeeded"]);
    expect(r.run.output).toBe("Recovered: Simulated refusal.");

    run = await workflow([role("risky", "[[refuse]] {{input.request}}"), text("after", "fine")]);
    r = await run("go");
    expect(r.run.status).toBe("failed");
  });
});

describe("joins, routing, stopping and turning steps off", () => {
  it("joins with all (strict) or any (default) after a branch", async () => {
    h = await harness();
    const steps = (join: string) => [
      { kind: "branch", key: "pick", value: "{{input.request}}", cases: [{ key: "x", label: "X", when: rule("contains", "x") }] },
      text("a", "A", { needs: [{ step: "pick", port: "x" }] }),
      text("b", "B", { needs: [{ step: "pick", port: "else" }] }),
      text("joined", "J {{steps.a.output}}{{steps.b.output}}", { needs: ["a", "b"], join }),
    ];
    expect((await (await workflow(steps("all")))("x")).status("joined")).toBe("not_taken");
    const r = await (await workflow(steps("any")))("x");
    expect(r.status("joined")).toBe("succeeded");
    expect(r.output("joined")).toBe("J A");
  });

  it("routes with the AI router, and sends an answer that names no category to Other", async () => {
    h = await harness();
    const run = await workflow([
      {
        kind: "classify",
        key: "route",
        role: "assistant",
        value: "{{input.request}}",
        categories: [
          { key: "billing", label: "Billing", description: "Invoices and payments" },
          { key: "tech", label: "Technical" },
        ],
      },
      text("b", "billing desk", { needs: [{ step: "route", port: "billing" }] }),
      text("t", "tech desk", { needs: [{ step: "route", port: "tech" }] }),
      text("o", "front desk", { needs: [{ step: "route", port: "other" }] }),
      { kind: "merge", key: "desk", needs: ["b", "t", "o"] },
    ]);
    // The mock model repeats the first line of its prompt, which is the text being sorted.
    let r = await run("A billing question about my invoice");
    expect(r.output("route")).toBe("billing");
    expect(r.run.output).toBe("billing desk");
    r = await run("hello there");
    expect(r.output("route")).toBe("other");
    expect(r.run.output).toBe("front desk");
  });

  it("ends the task at a Stop step, done or failed, and stops other branches", async () => {
    h = await harness();
    const run = await workflow([
      { kind: "branch", key: "gate", value: "{{input.request}}", cases: [{ key: "bad", label: "Bad", when: rule("contains", "spam") }, { key: "short", label: "Short", when: rule("equals", "hi") }] },
      { kind: "stop", key: "refuse", outcome: "fail", message: "Refused: {{input.request}}", needs: [{ step: "gate", port: "bad" }] },
      { kind: "stop", key: "quick", outcome: "succeed", message: "Hello!", needs: [{ step: "gate", port: "short" }] },
      role("answer", "{{input.request}}", { needs: [{ step: "gate", port: "else" }] }),
    ]);
    let r = await run("buy spam now");
    expect(r.run.status).toBe("failed");
    expect(r.run.error).toBe("Refused: buy spam now");
    r = await run("hi");
    expect(r.run.status).toBe("succeeded");
    expect(r.run.output).toBe("Hello!");
    r = await run("a real question");
    expect(r.run.output).toBe("[mock-small] a real question");
  });

  it("skips a turned-off step and passes its input on", async () => {
    h = await harness();
    const run = await workflow([text("first", "from first"), role("off", "never sent", { disabled: true }), text("last", "got: {{steps.off.output}}")]);
    const r = await run("x");
    expect(r.status("off")).toBe("skipped");
    expect(r.run.output).toBe("got: from first");
    const calls = await h.conclave.db.query(`select 1 from usage_ledger`);
    expect(calls).toHaveLength(0);
  });
});

describe("loops (WF-010)", () => {
  const until = (value: string) => ({ match: "all" as const, rules: [{ op: "contains", value, field: "", ignoreCase: true }] });

  it("repeats a step until its output meets the rules, then carries on with the last round", async () => {
    h = await harness();
    const run = await workflow([
      role("draft", "Draft round {{loop.index}} of {{input.request}}", { loop: { to: "draft", until: until("round 3") } , needs: [] }),
      text("done", "Final: {{steps.draft.output}}"),
    ]);
    const r = await run("a plan");
    expect(r.run.status).toBe("succeeded");
    expect(r.run.output).toBe("Final: [mock-small] Draft round 3 of a plan");
    // Three rounds ran; the earlier two are kept as superseded rows, numbered by round.
    const rounds = r.run.steps.filter((s) => s.key === "draft").map((s) => [s.round, s.status]);
    expect(rounds).toEqual([
      [1, "superseded"],
      [2, "superseded"],
      [3, "succeeded"],
    ]);
    // From round 2 on, the start of the loop hears how the last round ended.
    const prompts = await h.conclave.db.query<{ input: { prompt: string }; round: number }>(`select input, round from run_steps where step_key = 'draft' order by round`);
    expect(prompts[0]!.input.prompt).not.toContain("The last round ended with");
    expect(prompts[1]!.input.prompt).toContain("This is round 2. The last round ended with:\n[mock-small] Draft round 1 of a plan");
  });

  it("loops over several steps and reads the last round with {{loop.previous}}", async () => {
    h = await harness();
    const run = await workflow([
      text("write", "v{{loop.index}} after [{{loop.previous}}]", { needs: [] }),
      text("check", "{{steps.write.output}}", { loop: { to: "write", until: until("v3"), carry: false } }),
    ]);
    const r = await run("x");
    expect(r.run.output).toBe("v3 after [v2 after [v1 after []]]");
  });

  it("stops at the round limit: carries on, or fails the task when asked to", async () => {
    h = await harness();
    let run = await workflow([text("try", "attempt {{loop.index}}", { needs: [], loop: { to: "try", until: until("never"), max: 2 } }), text("after", "got {{steps.try.output}}")]);
    let r = await run("x");
    expect(r.run.status).toBe("succeeded");
    expect(r.run.output).toBe("got attempt 2");

    run = await workflow([text("try", "attempt {{loop.index}}", { needs: [], loop: { to: "try", until: until("never"), max: 2, onMax: "fail" } }), text("after", "x")]);
    r = await run("x");
    expect(r.run.status).toBe("failed");
    expect(r.run.error).toBe("Try looped 2 times and its rules never held.");
  });

  it("loops through a branch: a checker sends work back until it passes", async () => {
    h = await harness();
    const run = await workflow([
      text("draft", "draft {{loop.index}}", { needs: [] }),
      { kind: "branch", key: "gate", value: "{{steps.draft.output}}", cases: [{ key: "ok", label: "OK", when: until("draft 2") }], loop: { to: "draft", until: { match: "all", rules: [{ op: "contains", value: "draft 2", field: "", ignoreCase: true }] }, max: 5 } },
      text("ship", "shipped {{steps.draft.output}}", { needs: [{ step: "gate", port: "ok" }] }),
      text("hold", "held", { needs: [{ step: "gate", port: "else" }] }),
    ]);
    const r = await run("x");
    expect(r.run.output).toBe("shipped draft 2");
    expect(r.status("hold")).toBe("not_taken");
  });

  it("refuses a loop to a step that does not run before it", async () => {
    h = await harness();
    await expect(workflow([text("a", "a", { loop: { to: "b" } }), text("b", "b")])).rejects.toThrow(/can only loop back to itself or a step that runs before it/);
  });
});

import { workspaceTemplateSchema } from "@conclave/contract";
import { afterEach, describe, expect, it } from "vitest";
import { blankWorkspace, composeWorkspace, type BuilderAnswers } from "./builder";
import { ConclaveError } from "./errors";
import { harness, type Harness } from "./test-helpers";

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const GOALS = ["research", "write", "summarize", "answer", "custom"] as const;

/** A brief that fills every required field of the task type. */
const briefFor = (fields: { key: string; required: boolean }[]) => Object.fromEntries(fields.map((f) => [f.key, `Sample ${f.key}`]));

async function createAndRun(h: Harness, input: Parameters<Harness["conclave"]["workspaces"]["create"]>[1]) {
  const ws = await h.conclave.workspaces.create(h.actor, { ...input, defaultNode: { connectionId: h.connectionId, model: "mock-small" } });
  const tt = ws.taskTypes[0]!;
  const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId: tt.id, brief: briefFor(tt.inputFields) });
  await h.settle();
  let run = await h.conclave.orchestrator.get(h.actor, started.id);
  if (run.status === "waiting") {
    const item = (await h.conclave.orchestrator.inbox(h.actor, { kind: "approval" })).find((i) => i.runId === run.id && !i.resolved)!;
    await h.conclave.orchestrator.decide(h.actor, item.approvalId!, { decision: "approve" });
    await h.settle();
    run = await h.conclave.orchestrator.get(h.actor, started.id);
  }
  return { ws, run };
}

describe("Guided builder (WS-001)", () => {
  it("gives the same workspace for the same answers", () => {
    const answers: BuilderAnswers = { goal: "research", audience: "Board members", check: true, search: true };
    expect(composeWorkspace(answers)).toEqual(composeWorkspace(answers));
  });

  it("composes a valid package for every goal and option", () => {
    for (const goal of GOALS) {
      for (const approval of [true, false]) {
        for (const check of [true, false]) {
          for (const search of [true, false]) {
            const t = composeWorkspace({ goal, approval, check, search, customGoal: "Plan team offsites." });
            expect(() => workspaceTemplateSchema.parse(t)).not.toThrow();
            const steps = t.taskTypes[0]!.workflow.steps;
            expect(steps.some((s) => s.kind === "approval")).toBe(approval);
            expect(steps.some((s) => s.key === "check")).toBe(check);
            // Summaries work from pasted text, so they never start with a search.
            expect(steps[0]!.kind === "tool").toBe(search && goal !== "summarize");
            // Without a search step no prompt refers to its output.
            if (!steps.some((s) => s.kind === "tool")) {
              expect(JSON.stringify(steps)).not.toContain("steps.search");
            }
          }
        }
      }
    }
  });

  it("folds the audience and custom goal into instructions", () => {
    const t = composeWorkspace({ goal: "custom", customGoal: "Turn meeting notes into action items.", audience: "The sales team", name: "Actions" });
    expect(t.name).toBe("Actions");
    expect(t.roles[0]!.instructions).toContain("Turn meeting notes into action items.");
    expect(t.roles[0]!.instructions).toContain("The sales team");
  });

  it("rejects answers it cannot use", () => {
    expect(() => composeWorkspace({ goal: "dance" as never })).toThrow(ConclaveError);
  });

  it("runs every goal end to end, with a reviewer check and an approval", async () => {
    h = await harness();
    for (const goal of GOALS) {
      const { ws, run } = await createAndRun(h, { answers: { goal, check: true, approval: true, customGoal: "Answer questions about our product." } });
      expect(run.status, `${goal} should finish`).toBe("succeeded");
      expect(run.output).toBe(run.steps.find((s) => s.key === "check")!.output);
      expect(ws.templateKey).toBe(`guided-${goal}`);
    }
  });

  it("previews without creating anything", async () => {
    h = await harness();
    const before = (await h.conclave.workspaces.list(h.actor)).length;
    const preview = h.conclave.workspaces.compose({ goal: "write", search: true });
    expect(preview.roles.map((r) => [r.key, r.port])).toEqual([
      ["searcher", "tool@1"],
      ["writer", "model@1"],
    ]);
    expect(preview.taskTypes[0]!.steps.map((s) => s.kind)).toEqual(["tool", "role", "approval"]);
    expect((await h.conclave.workspaces.list(h.actor)).length).toBe(before);
  });
});

describe("Blank workspaces and packages (WS-001, WS-005)", () => {
  it("starts blank with one assistant and no gate, and runs", async () => {
    expect(blankWorkspace().key).toBe("blank");
    h = await harness();
    const { ws, run } = await createAndRun(h, { blank: true, name: "Scratch" });
    expect(ws.name).toBe("Scratch");
    expect(ws.roles.map((r) => r.key)).toEqual(["assistant"]);
    expect(run.status).toBe("succeeded");
  });

  it("asks for exactly one way to start", async () => {
    h = await harness();
    await expect(h.conclave.workspaces.create(h.actor, {})).rejects.toThrow(/exactly one/);
    await expect(h.conclave.workspaces.create(h.actor, { blank: true, templateKey: "research-brief" })).rejects.toThrow(/exactly one/);
  });

  it("exports and imports to the same roles and task types", async () => {
    h = await harness();
    const exported = await h.conclave.workspaces.exportPackage(h.actor, h.workspaceId);
    // A package carries no connections, models or secrets.
    expect(JSON.stringify(exported)).not.toContain(h.connectionId);

    const imported = await h.conclave.workspaces.create(h.actor, { package: JSON.parse(JSON.stringify(exported)), name: "Copy" });
    const again = await h.conclave.workspaces.exportPackage(h.actor, imported.id);
    expect({ ...again, name: exported.name }).toEqual(exported);
    expect(imported.roles.find((r) => r.key === "searcher")!.port).toBe("tool@1");
    expect(imported.roles.every((r) => r.connectionId === null)).toBe(true);
  });

  it("rejects a broken package with readable reasons", async () => {
    h = await harness();
    await expect(h.conclave.workspaces.create(h.actor, { package: { name: "x" } })).rejects.toMatchObject({ status: 422 });
    const exported = await h.conclave.workspaces.exportPackage(h.actor, h.workspaceId);
    exported.roles = exported.roles.filter((r) => r.key !== "editor");
    await expect(h.conclave.workspaces.create(h.actor, { package: exported })).rejects.toThrow(/does not define/);
  });
});

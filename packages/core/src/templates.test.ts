import { afterEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "./test-helpers";
import { builtInTemplates } from "./templates";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Create a workspace from a template with the mock model on every model role, and run its first task type. */
async function runTemplate(key: string, brief: Record<string, string>) {
  h = await harness();
  const ws = await h.conclave.workspaces.createFromTemplate(h.actor, { templateKey: key, defaultNode: { connectionId: h.connectionId, model: "mock-small" } });
  const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId: ws.taskTypes[0]!.id, brief });
  await h.settle();
  return { ws, run: await h.conclave.orchestrator.get(h.actor, id) };
}

describe("built-in templates", () => {
  it("offers four, each with a different way of composing work", () => {
    expect(builtInTemplates.map((t) => t.key)).toEqual(["research-brief", "support-triage", "field-research", "content-desk"]);
    const kinds = (key: string) => new Set(builtInTemplates.find((t) => t.key === key)!.taskTypes.flatMap((t) => t.workflow.steps.map((s) => s.kind)));
    expect([...kinds("support-triage")]).toEqual(expect.arrayContaining(["lookup", "classify", "merge", "approval"]));
    expect([...kinds("field-research")]).toEqual(expect.arrayContaining(["agent", "approval"]));
    expect([...kinds("content-desk")]).toEqual(expect.arrayContaining(["workspace", "approval"]));
  });

  it("Support Triage routes a message down one branch and stops for approval with a reply", async () => {
    const { run } = await runTemplate("support-triage", { message: "I was charged twice this month.", customer: "Ada" });
    expect(run.status).toBe("waiting");
    const by = new Map(run.steps.map((s) => [s.key, s.status]));
    expect(by.get("lookup")).toBe("skipped");
    expect(by.get("route")).toBe("succeeded");
    // Exactly one of the three writers ran; the others were not taken.
    const writers = ["billing", "bug", "general"].map((k) => by.get(k));
    expect(writers.filter((s) => s === "succeeded")).toHaveLength(1);
    expect(writers.filter((s) => s === "not_taken")).toHaveLength(2);
    expect(by.get("reply")).toBe("succeeded");
    expect(run.steps.find((s) => s.key === "reply")!.output).toBeTruthy();
  });

  it("Field Research runs without an agent connected, skipping the investigation", async () => {
    const { run } = await runTemplate("field-research", { question: "How do tide pools form?" });
    expect(run.status).toBe("waiting");
    expect(run.steps.map((s) => [s.key, s.status])).toEqual([
      ["investigate", "skipped"],
      ["write", "succeeded"],
      ["review", "waiting"],
    ]);
  });

  it("Content Desk writes each planned post as its own sub-task, then sums them up", async () => {
    const { run } = await runTemplate("content-desk", { theme: "Heat pumps in old houses" });
    expect(run.status).toBe("waiting");
    const posts = run.steps.find((s) => s.key === "posts")!;
    expect(posts.status).toBe("succeeded");
    expect(posts.children!.length).toBeGreaterThan(0);
    expect(posts.children!.every((c) => c.status === "succeeded")).toBe(true);
    expect(run.steps.find((s) => s.key === "overview")!.status).toBe("succeeded");
    // Every sub-task is in the campaign's trace, and their cost rolled up into it.
    const trace = await h!.conclave.insights.trace(h!.actor, run.id);
    expect(trace.counts.tasks).toBe(1 + posts.children!.length);
    expect(trace.systems.reduce((n, s) => n + s.costUsd, 0)).toBeCloseTo(run.costUsd, 6);
  });
});

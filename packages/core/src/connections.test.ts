import openaiCompatible from "@conclave/module-openai-compatible";
import { afterEach, describe, expect, it } from "vitest";
import { egressFetch } from "./modules";
import { harness, type Harness } from "./test-helpers";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const SECRET = "sk-live-super-secret-value-123";

describe("Connections", () => {
  it("encrypts secrets and never returns them (CON-002)", async () => {
    h = await harness({ modules: [openaiCompatible] });
    const created = await h.conclave.connections.create(h.actor, {
      moduleId: "conclave/openai-compatible",
      name: "Local server",
      values: { baseUrl: "http://localhost:11434/v1", apiKey: SECRET },
    });
    expect(created.secretKeys).toEqual(["apiKey"]);
    const everything = JSON.stringify([created, await h.conclave.connections.list(h.actor), await h.conclave.connections.get(h.actor, created.id)]);
    expect(everything).not.toContain(SECRET);

    const rows = await h.conclave.db.query(`select * from secrets`);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    const audit = await h.conclave.db.query(`select * from audit_log`);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it("validates config against the module schema", async () => {
    h = await harness({ modules: [openaiCompatible] });
    await expect(
      h.conclave.connections.create(h.actor, { moduleId: "conclave/openai-compatible", name: "Bad", values: { baseUrl: "not a url", nope: 1 } }),
    ).rejects.toThrow(/Unknown setting "nope".*Base URL must be an http or https URL/s);
  });

  it("tests a connection and records its status (CON-003)", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "llama-test" }] });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    h = await harness({ modules: [openaiCompatible], fetch: fetchImpl });
    const conn = await h.conclave.connections.create(h.actor, {
      moduleId: "conclave/openai-compatible",
      name: "Local",
      values: { baseUrl: "http://localhost:11434/v1" },
    });
    const result = await h.conclave.connections.test(h.actor, conn.id);
    expect(result).toMatchObject({ ok: true, status: "working", capabilities: { models: [{ id: "llama-test" }] } });
    expect((await h.conclave.connections.get(h.actor, conn.id)).status).toBe("working");
  });

  it("kill switch stops new calls (CON-009)", async () => {
    h = await harness();
    await h.conclave.connections.setDisabled(h.actor, h.connectionId, true);
    const { id } = await h.conclave.orchestrator.start(h.actor, {
      workspaceId: h.workspaceId,
      taskTypeId: h.taskTypeId,
      brief: { topic: "Anything" },
    });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/kill switch/);
  });
});

describe("Egress (MOD-010)", () => {
  it("lets a module reach only the hosts its manifest declares", async () => {
    const seen: string[] = [];
    const base = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response("ok");
    }) as typeof fetch;
    const guarded = egressFetch(openaiCompatible.manifest, { baseUrl: "https://api.example.com/v1" }, base);
    await guarded("https://api.example.com/v1/models");
    await expect(guarded("https://evil.example.net/steal")).rejects.toThrow(/does not declare/);
    expect(seen).toEqual(["https://api.example.com/v1/models"]);
  });
});

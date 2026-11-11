import { fileURLToPath } from "node:url";
import { NodeCallError } from "@conclave/contract";
import { cmpInstance, createDispatcher, defineModule, httpClient, serveHttp, spawnClient, type CmpClient, type ConclaveModule } from "@conclave/module-sdk";
import { runConformance, testCallContext } from "@conclave/module-sdk/conformance";
import { afterEach, describe, expect, it } from "vitest";
import sample from "./index";

/** The sample module, and the Conclave Module Protocol it is served over (SRS 4.11, MOD-003, MOD-006). */

const SECRET = "test-secret-0123456789-abcdefghijklmnop";
const serveScript = fileURLToPath(new URL("./serve.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The same module, reached through a CMP client: what a dock gives Conclave. */
function overCmp(client: CmpClient, config: Record<string, unknown> = {}): ConclaveModule {
  return defineModule({ manifest: { ...sample.manifest }, create: () => cmpInstance(client, { config }) });
}

const conformance = { config: { stepMs: 5 }, agentAnswer: "the tides", workflow: "slow-count", workflowInputs: { text: "one two three" } };

describe("sample agent", () => {
  it("passes the conformance kit in process", async () => {
    const report = await runConformance(sample, conformance);
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["agent: a run streams known events to a final one", "agent: watching a finished run again yields its final event", "workflow: trigger reaches a final status"]),
    );
  });

  it("asks a question in the interview skill and finishes with the answer", async () => {
    const inst = sample.create({ config: { stepMs: 1 }, secrets: {}, fetch, log: { info() {}, warn() {} } });
    const agent = inst.ports.agent!;
    const handle = await agent.startRun({ skill: "interview", text: "Tell me about tides." }, testCallContext());
    const seen: string[] = [];
    for await (const e of agent.streamEvents(handle, testCallContext())) {
      seen.push(e.type);
      if (e.type === "needs_input") await agent.provideInput(handle, "spring tides", testCallContext());
      if (e.type === "completed") {
        expect(e.text).toMatch(/^Focus: spring tides/);
        break;
      }
    }
    expect(seen).toEqual(["progress", "progress", "progress", "needs_input", "progress", "completed"]);
  });
});

describe("Conclave Module Protocol over HTTP (remote dock)", () => {
  it("passes the conformance kit through signed requests", async () => {
    const served = await serveHttp(sample, { secret: SECRET, config: { stepMs: 5 } });
    closers.push(served.close);
    const report = await runConformance(overCmp(httpClient(served.url, SECRET)), conformance);
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("refuses a wrong secret, a short secret, and plain http to another machine", async () => {
    const served = await serveHttp(sample, { secret: SECRET });
    closers.push(served.close);
    await expect(httpClient(served.url, `${SECRET}-other`).request("health")).rejects.toMatchObject({ code: "auth" });
    await expect(httpClient(served.url, "short").request("health")).rejects.toThrow(/at least 32 characters/);
    await expect(httpClient("http://example.com/cmp", SECRET).request("health")).rejects.toThrow(/over https/);
    await expect(serveHttp(sample, { secret: "short" })).rejects.toThrow(/at least 32/);
  });

  it("refuses a replayed request", async () => {
    const served = await serveHttp(sample, { secret: SECRET });
    closers.push(served.close);
    let captured: { url: string; init: RequestInit } | undefined;
    const recording: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init! };
      return fetch(url, init);
    };
    await httpClient(served.url, SECRET, recording).request("health");
    const again = await fetch(captured!.url, { ...captured!.init, signal: null });
    expect(again.status).toBe(401);
  });

  it("refuses an answer that is not signed by the module", async () => {
    const forged: typeof fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "working", detail: "trust me" } }), { status: 200 });
    await expect(httpClient("https://module.example/cmp", SECRET, forged).request("health")).rejects.toThrow(/not signed with the shared secret/);
  });

  it("carries contract errors across", async () => {
    const served = await serveHttp(sample, { secret: SECRET });
    closers.push(served.close);
    const inst = cmpInstance(httpClient(served.url, SECRET));
    await expect(inst.ports.agent!.startRun({ skill: "nope", text: "x" }, testCallContext())).rejects.toMatchObject({ code: "invalid_request", message: 'No skill "nope".' });
    // Before it has introduced itself every port answers, with a clear refusal; after, only its own remain.
    const fresh = cmpInstance(httpClient(served.url, SECRET));
    await expect(fresh.ports.tool!.listTools()).rejects.toThrow(/Sample agent does not provide tools/);
    expect(Object.keys(inst.ports).sort()).toEqual(["agent", "workflow"]);
    expect(await inst.dockedModule!()).toMatchObject({ id: "conclave/sample-agent", version: "1.0.0", ports: ["agent@1", "workflow@1"] });
  });
});

describe("Conclave Module Protocol over stdio (sidecar dock, Local Bridge)", () => {
  it("passes the conformance kit with the module in its own process", async () => {
    const client = spawnClient([process.execPath, "--import", "tsx", serveScript, "--stdio"], { cwd: repoRoot, env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" } });
    closers.push(() => client.close());
    const report = await runConformance(overCmp(client, { stepMs: 5 }), conformance);
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  }, 60_000);

  it("sends a module's network calls through the host, which may refuse them", async () => {
    const fetcher = defineModule({
      manifest: { id: "test/fetcher", version: "0.1.0", name: "Fetcher", ports: ["tool@1"], docks: ["sidecar"] },
      create: (ctx) => ({
        ports: {
          tool: {
            listTools: async () => [{ name: "get", inputSchema: { type: "object" } }],
            call: async (_n, args) => ({ data: { text: await (await ctx.fetch(String(args.url))).text() } }),
          },
        },
        health: async () => ({ status: "working", detail: "ok" }),
      }),
    });
    // The dispatcher stands in for a module process; its fetch is the host's, as over stdio.
    const asked: string[] = [];
    const hostFetch: typeof fetch = async (url) => {
      asked.push(String(url));
      if (!String(url).startsWith("https://allowed.example/")) throw new NodeCallError("invalid_request", "Not on the allow-list.", false);
      return new Response("hello from allowed");
    };
    const d = createDispatcher(fetcher, { fetch: hostFetch });
    closers.push(() => d.close());
    const ok = (await d.handle("tool.call", { name: "get", args: { url: "https://allowed.example/x" } }, new AbortController().signal)) as { data: { text: string } };
    expect(ok.data.text).toBe("hello from allowed");
    await expect(d.handle("tool.call", { name: "get", args: { url: "https://evil.example/" } }, new AbortController().signal)).rejects.toThrow(/allow-list/);
    expect(asked).toEqual(["https://allowed.example/x", "https://evil.example/"]);
  });

  it("reports a command that cannot start", async () => {
    const client = spawnClient(["definitely-not-a-real-program-xyz"], { env: {} });
    closers.push(() => client.close());
    await expect(client.request("initialize", {})).rejects.toMatchObject({ code: "unavailable" });
  });
});

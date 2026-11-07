import { NodeCallError } from "@conclave/contract";
import { runConformance, testCallContext } from "@conclave/module-sdk/conformance";
import { describe, expect, it } from "vitest";
import openaiCompatible from "./index";

/** A recorded OpenAI-compatible server. */
function fakeServer(opts: { usage?: boolean; status?: number } = {}) {
  const requests: { url: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: url.href, body, headers });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (opts.status) return new Response("nope", { status: opts.status });
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "llama-test" }] });
    if (url.pathname.endsWith("/chat/completions")) {
      const events = [
        { choices: [{ delta: { content: "o" } }] },
        { choices: [{ delta: { content: "k" }, finish_reason: "stop" }] },
        ...(opts.usage === false ? [] : [{ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }]),
      ];
      const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const config = { baseUrl: "http://localhost:11434/v1", inputPricePerMTok: 1, outputPricePerMTok: 2 };

describe("OpenAI-compatible protocol dock", () => {
  it("passes the conformance kit against a recorded server", async () => {
    const { fetchImpl } = fakeServer();
    const report = await runConformance(openaiCompatible, { config, secrets: { apiKey: "k" }, fetch: fetchImpl });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("streams deltas, reads reported usage and sends the key", async () => {
    const { fetchImpl, requests } = fakeServer();
    const instance = openaiCompatible.create({ config, secrets: { apiKey: "sk-test" }, fetch: fetchImpl, log: { info() {}, warn() {} } });
    const deltas: string[] = [];
    const ctx = testCallContext();
    const result = await instance.ports.model!.generate(
      { model: "llama-test", system: "Be brief.", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
      { ...ctx, emit: (e) => deltas.push(String(e.data)) },
    );
    expect(result).toMatchObject({ text: "ok", usage: { inputTokens: 9, outputTokens: 2 }, usageSource: "reported", stopReason: "stop" });
    expect(deltas.join("")).toBe("ok");
    const call = requests.find((r) => r.url.endsWith("/chat/completions"))!;
    expect(call.headers.get("authorization")).toBe("Bearer sk-test");
    expect(call.body).toMatchObject({ model: "llama-test", stream: true, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] });
  });

  it("labels usage as estimated when the server sends none", async () => {
    const { fetchImpl } = fakeServer({ usage: false });
    const instance = openaiCompatible.create({ config, secrets: {}, fetch: fetchImpl, log: { info() {}, warn() {} } });
    const result = await instance.ports.model!.generate({ model: "llama-test", messages: [{ role: "user", content: "hello there" }], maxTokens: 10 }, testCallContext());
    expect(result.usageSource).toBe("estimated");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("maps HTTP failures to contract errors", async () => {
    for (const [status, code] of [
      [401, "auth"],
      [429, "rate_limited"],
      [503, "unavailable"],
    ] as const) {
      const { fetchImpl } = fakeServer({ status });
      const instance = openaiCompatible.create({ config, secrets: {}, fetch: fetchImpl, log: { info() {}, warn() {} } });
      const err = await instance.ports.model!.generate({ model: "x", messages: [{ role: "user", content: "hi" }], maxTokens: 5 }, testCallContext()).catch((e) => e);
      expect(err).toBeInstanceOf(NodeCallError);
      expect(err.code).toBe(code);
    }
  });
});

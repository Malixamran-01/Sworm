import { NodeCallError } from "@conclave/contract";
import { runConformance, testCallContext } from "@conclave/module-sdk/conformance";
import { describe, expect, it } from "vitest";
import anthropic from "./index";

/** A recorded Anthropic API: models list and a streamed message. */
function fakeAnthropic(opts: { stopReason?: string; status?: number } = {}) {
  const requests: { url: string; body: Record<string, unknown> | undefined; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    requests.push({ url: url.href, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (opts.status) {
      return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: opts.status });
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z" }],
        has_more: false,
        first_id: "claude-opus-5-5",
        last_id: "claude-opus-5-5",
      });
    }
    if (url.pathname === "/v1/messages") {
      const model = (requests.at(-1)!.body?.model as string) ?? "claude-opus-5-5";
      const events: [string, unknown][] = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            },
          },
        ],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "o" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "k" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: opts.stopReason ?? "end_turn", stop_sequence: null, ...(opts.stopReason === "refusal" ? { stop_details: { type: "refusal", category: "cyber", explanation: null } } : {}) },
            usage: { output_tokens: 2 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ];
      const sse = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const ctxFor = (fetchImpl: typeof fetch) => ({ config: {}, secrets: { apiKey: "sk-ant-test" }, fetch: fetchImpl, log: { info() {}, warn() {} } });

describe("Anthropic reference module", () => {
  it("passes the conformance kit against a recorded API", async () => {
    const { fetchImpl } = fakeAnthropic();
    const report = await runConformance(anthropic, { secrets: { apiKey: "sk-ant-test" }, fetch: fetchImpl });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("streams text, reports usage, sets effort and opts into server-side fallback", async () => {
    const { fetchImpl, requests } = fakeAnthropic();
    const instance = anthropic.create(ctxFor(fetchImpl));
    const deltas: string[] = [];
    const result = await instance.ports.model!.generate(
      { model: "claude-opus-5-5", system: "Be brief.", messages: [{ role: "user", content: "hi" }], maxTokens: 100, effort: "high" },
      { ...testCallContext(), emit: (e) => deltas.push(String(e.data)) },
    );
    expect(result).toMatchObject({ text: "ok", usage: { inputTokens: 12, outputTokens: 2 }, usageSource: "reported", stopReason: "end_turn" });
    expect(deltas.join("")).toBe("ok");
    const call = requests.find((r) => r.url.includes("/v1/messages"))!;
    // SDK 1.x sends the key as a bearer token; older releases used x-api-key.
    expect(call.headers.get("authorization") ?? `Bearer ${call.headers.get("x-api-key")}`).toBe("Bearer sk-ant-test");
    expect(call.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(call.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 100, system: "Be brief.", output_config: { effort: "high" }, fallbacks: "default", stream: true });
  });

  it("turns a refusal into a refused error", async () => {
    const { fetchImpl } = fakeAnthropic({ stopReason: "refusal" });
    const instance = anthropic.create(ctxFor(fetchImpl));
    const err = await instance.ports.model!.generate({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], maxTokens: 10 }, testCallContext()).catch((e) => e);
    expect(err).toBeInstanceOf(NodeCallError);
    expect(err.code).toBe("refused");
  });

  it("maps a bad key to an auth error and a signed-out status", async () => {
    const { fetchImpl } = fakeAnthropic({ status: 401 });
    const instance = anthropic.create(ctxFor(fetchImpl));
    const err = await instance.ports.model!.generate({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], maxTokens: 10 }, testCallContext()).catch((e) => e);
    expect(err.code).toBe("auth");
    expect((await instance.health()).status).toBe("signed_out");
  });
});

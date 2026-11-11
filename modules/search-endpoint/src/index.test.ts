import { runConformance, testCallContext } from "@conclave/module-sdk/conformance";
import { describe, expect, it } from "vitest";
import endpoint, { readPassages } from "./index";

function fakeSearch(answer: (body: Record<string, unknown>) => unknown, status = 200) {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), body, headers: new Headers(init?.headers) });
    if (status !== 200) return new Response("nope", { status });
    return Response.json(answer(body));
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const config = { url: "https://search.test/query" };
const make = (fetchImpl: typeof fetch, extra: Record<string, string> = {}, secrets: Record<string, string> = {}) =>
  endpoint.create({ config: { ...config, ...extra }, secrets, fetch: fetchImpl, log: { info() {}, warn() {} } });

const standard = () => ({
  passages: [
    { text: "Tide pools form at low tide.", title: "Tide pools", url: "https://docs.test/tide-pools", score: 0.91 },
    { text: "Spring tides come at full moon.", title: "Spring tides", url: "https://docs.test/spring", score: 0.62 },
  ],
});

describe("search endpoint dock", () => {
  it("passes the conformance kit against a recorded endpoint", async () => {
    const { fetchImpl } = fakeSearch(standard);
    const report = await runConformance(endpoint, { config, fetch: fetchImpl });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("sends the query, limit, source, token and trace, and returns passages with where they came from", async () => {
    const { fetchImpl, requests } = fakeSearch(standard);
    const instance = make(fetchImpl, { sources: "handbook, policies" }, { token: "t-1" });
    expect((await instance.ports.knowledge!.listSources()).map((s) => s.id)).toEqual(["*", "handbook", "policies"]);
    const ctx = testCallContext();
    const found = await instance.ports.knowledge!.search({ query: " tide pools ", limit: 3, sources: ["handbook"] }, ctx);
    expect(requests[0]!.body).toEqual({ query: "tide pools", limit: 3, sources: ["handbook"] });
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer t-1");
    expect(requests[0]!.headers.get("traceparent")).toBe(ctx.call.trace.traceparent);
    expect(found.passages[0]).toEqual({ text: "Tide pools form at low tide.", source: { id: "https://docs.test/tide-pools", title: "Tide pools", uri: "https://docs.test/tide-pools" }, score: 0.91 });
    // "Everything" sends no sources field.
    await instance.ports.knowledge!.search({ query: "x", limit: 1, sources: ["*"] }, testCallContext());
    expect(requests[1]!.body).toEqual({ query: "x", limit: 1 });
  });

  it("speaks to endpoints that name the fields differently", async () => {
    const { fetchImpl, requests } = fakeSearch(() => ({ matches: [{ id: "a1", metadata: { page_content: "From metadata.", name: "Doc A" }, similarity: 0.5 }] }));
    const found = await make(fetchImpl, { queryField: "q", limitField: "top_k" }).ports.knowledge!.search({ query: "x", limit: 4 }, testCallContext());
    expect(requests[0]!.body).toEqual({ q: "x", top_k: 4 });
    expect(found.passages).toEqual([{ text: "From metadata.", source: { id: "a1", title: "Doc A" }, score: 0.5 }]);
  });

  it("reads the common answer shapes, orders by score and brings scores into 0 to 1", () => {
    expect(readPassages(["plain text one", "", "plain text two"], 5).map((p) => p.text)).toEqual(["plain text one", "plain text two"]);
    expect(readPassages({ hits: { hits: [{ _id: "x", fields: { body: "Nested hit." } }] } }, 5)).toEqual([{ text: "Nested hit.", source: { id: "result-1" } }]);
    // Scores above 1 are scaled to the best; the list is reordered best first.
    expect(readPassages({ results: [{ content: "weak", score: 4 }, { content: "strong", score: 12 }] }, 5).map((p) => [p.text, p.score])).toEqual([
      ["strong", 1],
      ["weak", 0.333],
    ]);
    // Distances: smaller is better.
    expect(readPassages({ documents: [{ text: "far", distance: 3 }, { text: "near", distance: 0 }] }, 5).map((p) => [p.text, p.score])).toEqual([
      ["near", 1],
      ["far", 0.25],
    ]);
    // Without scores the service's own order is kept, and the limit holds.
    expect(readPassages({ data: [{ text: "one" }, { text: "two" }, { text: "three" }] }, 2).map((p) => p.text)).toEqual(["one", "two"]);
    expect(readPassages({ nothing: true }, 5)).toEqual([]);
  });

  it("uses contract errors, and takes a reported cost", async () => {
    const down = fakeSearch(standard, 503);
    await expect(make(down.fetchImpl).ports.knowledge!.search({ query: "x", limit: 1 }, testCallContext())).rejects.toMatchObject({ code: "unavailable", retryable: true });
    const denied = fakeSearch(standard, 401);
    await expect(make(denied.fetchImpl).ports.knowledge!.search({ query: "x", limit: 1 }, testCallContext())).rejects.toMatchObject({ code: "auth" });
    const priced = fakeSearch(() => ({ results: [{ text: "ok" }], usage: { costUsd: 0.0004 } }));
    expect((await make(priced.fetchImpl).ports.knowledge!.search({ query: "x", limit: 1 }, testCallContext())).usage).toEqual({ costUsd: 0.0004 });
    expect(await make(priced.fetchImpl).health()).toEqual({ status: "working", detail: "Ready to search." });
  });
});

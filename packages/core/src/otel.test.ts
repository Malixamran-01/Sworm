import { traceIdOf } from "@conclave/contract";
import { afterEach, describe, expect, it } from "vitest";
import { OtelExporter, toOtlp } from "./otel";
import { harness, type Harness } from "./test-helpers";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function finishedRun() {
  h = await harness();
  const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: { topic: "Tide pools" } });
  await h.settle();
  const [approval] = await h.conclave.db.query<{ id: string }>(`select id from approvals where run_id = $1`, [id]);
  await h.conclave.orchestrator.decide(h.actor, approval!.id, { decision: "approve" });
  await h.settle();
  return id;
}

type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; attributes: { key: string; value: Record<string, unknown> }[]; status: { code: number } };
const spansOf = (body: ReturnType<typeof toOtlp>) => body.resourceSpans[0]!.scopeSpans[0]!.spans as OtlpSpan[];
const get = (s: OtlpSpan, key: string) => Object.values(s.attributes.find((a) => a.key === key)?.value ?? {})[0];

describe("OpenTelemetry export", () => {
  it("turns a trace into OTLP spans with the ids outside calls carried", async () => {
    const id = await finishedRun();
    const trace = await h!.conclave.insights.trace(h!.actor, id);
    const spans = spansOf(toOtlp(trace));

    // The optional search step never ran, so it is not a span.
    expect(spans).toHaveLength(trace.spans.length - 1);
    expect(spans.every((s) => s.traceId === traceIdOf(id) && /^[0-9a-f]{16}$/.test(s.spanId))).toBe(true);
    const root = spans.find((s) => !s.parentSpanId)!;
    expect(root.name).toBe("task Tide pools");
    expect(spans.filter((s) => s !== root).every((s) => s.parentSpanId === root.spanId)).toBe(true);

    const model = spans.find((s) => get(s, "gen_ai.operation.name") === "chat")!;
    expect(model.name).toBe("chat mock-small");
    expect(model.kind).toBe(3);
    expect(get(model, "gen_ai.request.model")).toBe("mock-small");
    expect(Number(get(model, "gen_ai.usage.input_tokens"))).toBeGreaterThan(0);
    expect(get(model, "conclave.module.id")).toBe("conclave/mock-model");
    expect(get(model, "conclave.policy.allowed")).toBe(true);
    // The span id is the one in the traceparent that went out with the call.
    const sent = trace.spans.find((s) => s.system === "model")!.traceparent!;
    expect(spans.some((s) => sent === `00-${s.traceId}-${s.spanId}-01`)).toBe(true);

    const review = spans.find((s) => get(s, "conclave.step.kind") === "approval")!;
    expect(get(review, "conclave.decision")).toBe("approve");
    expect(review.status.code).toBe(1);
  });

  it("sends each finished task once, and keeps trying while the collector is down", async () => {
    const id = await finishedRun();
    const received: { url: string; body: ReturnType<typeof toOtlp>; auth: string | null }[] = [];
    let down = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (down) return new Response("no", { status: 503 });
      received.push({ url: String(input), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({});
    }) as typeof fetch;
    const exporter = new OtelExporter(h!.conclave.db, h!.conclave.insights, { endpoint: "https://collector.test/", headers: { authorization: "Bearer t" }, serviceName: "conclave-test", fetch: fetchImpl });

    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await exporter.exportDue()).toBe(0);
    } finally {
      console.warn = warn;
    }
    down = false;
    expect(await exporter.exportDue()).toBe(1);
    expect(await exporter.exportDue()).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe("https://collector.test/v1/traces");
    expect(received[0]!.auth).toBe("Bearer t");
    expect(received[0]!.body.resourceSpans[0]!.resource.attributes[0]).toEqual({ key: "service.name", value: { stringValue: "conclave-test" } });
    expect(spansOf(received[0]!.body)[0]!.traceId).toBe(traceIdOf(id));

    // A task still waiting for a person is not sent.
    await h!.conclave.orchestrator.start(h!.actor, { workspaceId: h!.workspaceId, taskTypeId: h!.taskTypeId, brief: { topic: "Open" } });
    await h!.settle();
    expect(await exporter.exportDue()).toBe(0);
  });
});

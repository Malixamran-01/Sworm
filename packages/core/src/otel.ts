import type { TraceDto, TraceSpanDto } from "@conclave/contract";
import type { Db } from "@conclave/db";
import type { Insights } from "./insights";

/**
 * Optional OpenTelemetry export (MESH-009). A finished task's trace is sent
 * once to an OTLP/HTTP collector as JSON. The ids are the ones every outside
 * call already carried in its traceparent, so spans an outside system reports
 * for the same call join this trace as children of the step that made it.
 *
 * Off unless an endpoint is set. The database stays the source of truth; a
 * collector that is down only delays the export.
 */
export interface OtelOptions {
  /** Base URL of an OTLP/HTTP collector; spans go to `<endpoint>/v1/traces`. */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  fetch?: typeof fetch;
  /** How often to look for finished tasks. Default 10 s. */
  everyMs?: number;
}

type Attr = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } };

const attr = (key: string, value: string | number | boolean | null | undefined): Attr[] => {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string") return [{ key, value: { stringValue: value } }];
  if (typeof value === "boolean") return [{ key, value: { boolValue: value } }];
  return [{ key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }];
};

const spanId = (id: string): string => id.replace(/-/g, "").slice(-16);
const nanos = (iso: string): string => `${BigInt(new Date(iso).getTime()) * 1_000_000n}`;

/** The GenAI semantic-convention operation for each kind of system. */
const OPERATION: Partial<Record<TraceSpanDto["system"], string>> = { model: "chat", tool: "execute_tool", agent: "invoke_agent", workflow: "invoke_workflow", knowledge: "retrieval" };

function toSpan(trace: TraceDto, s: TraceSpanDto) {
  const operation = s.type === "step" ? OPERATION[s.system] : undefined;
  // The node label reads "Role · Connection · node"; the last part is the model, tool, skill or workflow.
  const node = s.node?.label?.split(" · ").at(-1);
  const failed = s.status === "failed";
  const outside = s.system === "model" || s.system === "tool" || s.system === "agent" || s.system === "workflow" || s.system === "knowledge";
  return {
    traceId: trace.traceId,
    spanId: spanId(s.id),
    ...(s.parentId ? { parentSpanId: spanId(s.parentId) } : {}),
    name: operation ? `${operation} ${node ?? s.name}` : s.type === "run" ? `task ${s.name}` : s.name,
    // CLIENT for calls that leave Conclave, INTERNAL for everything else.
    kind: s.type === "step" && outside ? 3 : 1,
    startTimeUnixNano: nanos(s.startedAt),
    endTimeUnixNano: nanos(s.finishedAt ?? s.startedAt),
    attributes: [
      ...attr("conclave.span.type", s.type),
      ...attr("conclave.step.kind", s.kind),
      ...attr("conclave.run.id", s.runId),
      ...attr("conclave.workspace.id", s.workspaceId),
      ...attr("conclave.workspace.name", s.hidden ? null : s.workspaceName),
      ...attr("conclave.status", s.status),
      ...attr("conclave.attempt", s.attempt),
      ...attr("conclave.round", s.round > 1 ? s.round : null),
      ...attr("conclave.depth", s.depth),
      ...attr("conclave.connection.id", s.node?.connectionId),
      ...attr("conclave.connection.name", s.node?.connectionName),
      ...attr("conclave.module.id", s.node?.moduleId),
      ...attr("conclave.cost.usd", s.type === "step" ? s.selfCostUsd : s.costUsd),
      ...attr("conclave.cost.source", s.costSource),
      ...attr("conclave.budget.reserved_usd", s.reservedUsd || null),
      ...attr("conclave.policy.effect", s.policy?.effect),
      ...attr("conclave.policy.allowed", s.policy ? s.policy.allowed : null),
      ...attr("conclave.decision", s.decision?.decision),
      ...attr("conclave.external.id", s.externalId),
      ...attr("gen_ai.operation.name", operation),
      ...attr("gen_ai.request.model", s.system === "model" ? node : null),
      ...attr("gen_ai.tool.name", s.system === "tool" ? node : null),
      ...attr("gen_ai.agent.name", s.system === "agent" ? s.node?.connectionName : null),
      ...attr("gen_ai.usage.input_tokens", s.inputTokens || null),
      ...attr("gen_ai.usage.output_tokens", s.outputTokens || null),
      ...attr("error.type", failed ? (s.errorCode ?? "error") : null),
    ],
    status: failed ? { code: 2, message: s.error ?? "" } : s.status === "succeeded" ? { code: 1 } : { code: 0 },
  };
}

/** A whole trace as one OTLP/HTTP JSON request body. Steps that never ran are left out. */
export function toOtlp(trace: TraceDto, serviceName = "conclave") {
  const ran = trace.spans.filter((s) => !["not_taken", "skipped", "pending"].includes(s.status));
  return {
    resourceSpans: [
      {
        resource: { attributes: [...attr("service.name", serviceName)] },
        scopeSpans: [{ scope: { name: "conclave.orchestrator" }, spans: ran.map((s) => toSpan(trace, s)) }],
      },
    ],
  };
}

export class OtelExporter {
  private readonly db: Db;
  private readonly insights: Insights;
  private readonly opts: OtelOptions;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private warned = false;

  constructor(db: Db, insights: Insights, opts: OtelOptions) {
    this.db = db;
    this.insights = insights;
    this.opts = opts;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.exportDue().catch(() => {}), this.opts.everyMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Send every finished top-level task that has not been sent yet. Returns how many went out. */
  async exportDue(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const due = await this.db.query<{ id: string; org_id: string; created_by: string | null }>(
        `select id, org_id, created_by from runs
          where parent_run_id is null and status in ('succeeded', 'failed', 'cancelled') and trace_exported_at is null
            and finished_at > now() - interval '7 days'
          order by finished_at limit 20`,
      );
      let sent = 0;
      const url = `${this.opts.endpoint.replace(/\/+$/, "")}/v1/traces`;
      for (const run of due) {
        const trace = await this.insights.trace({ orgId: run.org_id, userId: run.created_by ?? "" }, run.id);
        try {
          const res = await (this.opts.fetch ?? fetch)(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...this.opts.headers },
            body: JSON.stringify(toOtlp(trace, this.opts.serviceName)),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) throw new Error(`the collector answered ${res.status}`);
        } catch (err) {
          // Say it once, then keep trying quietly: the task stays due until it is sent.
          if (!this.warned) console.warn(`[otel] could not export traces to ${url}: ${err instanceof Error ? err.message : String(err)}. Will keep trying.`);
          this.warned = true;
          break;
        }
        this.warned = false;
        await this.db.query(`update runs set trace_exported_at = now() where id = $1`, [run.id]);
        sent += 1;
      }
      return sent;
    } finally {
      this.busy = false;
    }
  }
}

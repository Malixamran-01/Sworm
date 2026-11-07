/**
 * The node call contract (SRS 8.3). Every node, whatever module serves it,
 * is called with a NodeCall and answers with a NodeResult. Budgets, loop
 * guards, tracing and the Hive depend only on these shapes.
 */

export const costSources = ["metered", "reported", "reconciled", "estimated"] as const;
/** Where a cost figure came from (COST-006). */
export type CostSource = (typeof costSources)[number];

export interface Budget {
  /** Most this call may spend, in USD. */
  usd: number;
  tokens?: number;
  /** ISO timestamp after which the call must stop. */
  deadline?: string;
}

export interface NodeInput {
  text?: string;
  data?: Record<string, unknown>;
  /** blob:// references; payloads travel by reference (SRS 11.3). */
  files?: string[];
}

export interface NodeCall<I extends NodeInput = NodeInput> {
  callId: string;
  runId: string;
  parentCallId: string | null;
  depth: number;
  nodeId: string;
  input: I;
  outputSchema?: Record<string, unknown>;
  budget: Budget;
  /** Permission strings such as "call:node:<id>"; children only ever get a subset. */
  permissions: string[];
  trace: { traceparent: string };
  /** run_id:step_key:attempt — passed to providers that support idempotency. */
  idempotencyKey: string;
}

export type CallStatus = "ok" | "error" | "needs_input" | "pending";

export const errorCodes = [
  "auth",
  "rate_limited",
  "invalid_request",
  "not_found",
  "timeout",
  "unavailable",
  "refused",
  "cancelled",
  "budget_exceeded",
  "loop_detected",
  "internal",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export interface NodeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costSource: CostSource;
}

export interface NodeEvent {
  type: "progress" | "text_delta" | "log";
  data: unknown;
  at: string;
}

export interface NodeResult {
  status: CallStatus;
  output?: { text?: string; data?: unknown };
  usage: Usage;
  events?: NodeEvent[];
  error?: NodeError;
}

/** A typed error modules throw so the orchestrator can decide on retries. */
export class NodeCallError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable?: boolean) {
    super(message);
    this.name = "NodeCallError";
    this.code = code;
    this.retryable = retryable ?? (code === "rate_limited" || code === "timeout" || code === "unavailable");
  }

  toNodeError(): NodeError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function toNodeError(err: unknown): NodeError {
  if (err instanceof NodeCallError) return err.toNodeError();
  if (err instanceof Error && err.name === "AbortError") {
    return { code: "cancelled", message: "The call was cancelled.", retryable: false };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "internal", message, retryable: false };
}

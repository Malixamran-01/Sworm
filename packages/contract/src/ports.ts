import type { NodeCall, NodeEvent } from "./call";

/**
 * Ports (SRS 4.11): typed, versioned interfaces a module plugs into.
 * Core code only knows these; it never names an outside product.
 */
export const portNames = [
  "model",
  "agent",
  "workflow",
  "tool",
  "knowledge",
  "trigger",
  "channel",
  "device",
  "storage",
  "media",
  "identity",
  "secrets",
] as const;
export type PortName = (typeof portNames)[number];

/** A port with its major version, for example "model@1". */
export type PortRef = `${PortName}@${number}`;

export function parsePortRef(ref: string): { port: PortName; major: number } {
  const match = /^([a-z]+)@(\d+)$/.exec(ref);
  if (!match || !(portNames as readonly string[]).includes(match[1]!)) {
    throw new Error(`Invalid port reference "${ref}". Expected <port>@<major>, e.g. model@1.`);
  }
  return { port: match[1] as PortName, major: Number(match[2]) };
}

/** What every port call receives besides its own arguments. */
export interface CallContext {
  call: NodeCall;
  signal: AbortSignal;
  emit(event: Omit<NodeEvent, "at">): void;
}

// ---------------------------------------------------------------- Model port

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Pricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  pricing?: Pricing;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  effort?: Effort;
  responseFormat?: "text" | "json";
}

export interface GenerateResult {
  text: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Prompt-cache reads and writes, when the provider reports them. */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** "estimated" when the provider returned no usage and the module counted characters. */
  usageSource?: "reported" | "estimated";
  stopReason: string;
}

export interface ModelPortV1 {
  listModels(): Promise<ModelInfo[]>;
  generate(req: GenerateRequest, ctx: CallContext): Promise<GenerateResult>;
}

// ----------------------------------------------------------------- Tool port

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** Writes default to sensitive until reviewed (SRS 5.1). */
  sensitive?: boolean;
}

export interface ToolPortV1 {
  listTools(): Promise<ToolInfo[]>;
  call(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<{ data: unknown }>;
}

// ---------------------------------------------------------------- Agent port

export interface AgentRunHandle {
  externalRunId: string;
}

export type AgentEvent =
  | { type: "progress"; text: string }
  | { type: "needs_input"; prompt: string }
  | { type: "completed"; text: string; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "failed"; message: string };

export interface AgentPortV1 {
  listSkills(): Promise<{ id: string; description?: string }[]>;
  startRun(input: { text: string; data?: Record<string, unknown> }, ctx: CallContext): Promise<AgentRunHandle>;
  streamEvents(handle: AgentRunHandle, ctx: CallContext): AsyncIterable<AgentEvent>;
  provideInput(handle: AgentRunHandle, answer: string, ctx: CallContext): Promise<void>;
  cancel(handle: AgentRunHandle): Promise<void>;
}

/**
 * The ports a module instance provides. Ports without an implementation yet
 * are typed as `unknown` so modules can be declared before core supports them.
 */
export interface PortImplementations {
  model?: ModelPortV1;
  tool?: ToolPortV1;
  agent?: AgentPortV1;
  workflow?: unknown;
  knowledge?: unknown;
  trigger?: unknown;
  channel?: unknown;
  device?: unknown;
  storage?: unknown;
  media?: unknown;
  identity?: unknown;
  secrets?: unknown;
}

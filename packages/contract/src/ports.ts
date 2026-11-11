import type { ErrorCode, NodeCall, NodeEvent, NodeInput } from "./call";

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

/** What an outside node reports it spent, when it knows (COST-006). */
export interface ReportedUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface AgentSkill {
  id: string;
  name?: string;
  description?: string;
}

export interface AgentRunInput {
  /** One of listSkills(); omitted means the agent's default. */
  skill?: string;
  text: string;
  data?: Record<string, unknown>;
}

/**
 * A run the agent is doing. Kept in the step's checkpoint, so it must be
 * plain JSON: after a restart the orchestrator passes it back to resume watching.
 */
export interface AgentRunHandle {
  externalRunId: string;
  /** Anything else the module needs to find the run again. */
  state?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: "progress"; text: string }
  /** The agent needs an answer or an approval from a person (MESH-006). */
  | { type: "needs_input"; prompt: string }
  | { type: "completed"; text: string; data?: unknown; usage?: ReportedUsage }
  | { type: "failed"; message: string; code?: ErrorCode; retryable?: boolean };

/**
 * Agent port (SRS 4.11): long-running agents with their own tools and memory.
 * streamEvents may be called again for a run already under way (after a
 * restart or a dropped connection). It yields what happens from then on, and a
 * finished run yields its final event again.
 */
export interface AgentPortV1 {
  listSkills(): Promise<AgentSkill[]>;
  startRun(input: AgentRunInput, ctx: CallContext): Promise<AgentRunHandle>;
  streamEvents(handle: AgentRunHandle, ctx: CallContext): AsyncIterable<AgentEvent>;
  provideInput(handle: AgentRunHandle, answer: string, ctx: CallContext): Promise<void>;
  cancel(handle: AgentRunHandle): Promise<void>;
}

// ------------------------------------------------------------- Workflow port

export interface WorkflowInfo {
  id: string;
  name?: string;
  description?: string;
}

/** An execution in the outside engine; plain JSON, kept in the step's checkpoint. */
export interface WorkflowExecution {
  executionId: string;
  state?: Record<string, unknown>;
}

export type WorkflowStatus =
  | { state: "running"; progress?: string }
  | { state: "succeeded"; output: { text?: string; data?: unknown }; usage?: ReportedUsage }
  | { state: "failed"; message: string; code?: ErrorCode; retryable?: boolean }
  | { state: "cancelled" };

export interface TriggerContext extends CallContext {
  /**
   * A one-time URL the outside engine can POST its result to. Only modules
   * that implement `callback` should hand it out.
   */
  callbackUrl?: string;
}

/**
 * Workflow port (SRS 4.11): outside workflow engines. trigger may finish at
 * once (a synchronous webhook) or return "running"; the orchestrator then
 * polls, or waits for the callback, and survives restarts while it waits.
 */
export interface WorkflowPortV1 {
  listWorkflows(): Promise<WorkflowInfo[]>;
  trigger(workflowId: string, input: NodeInput, ctx: TriggerContext): Promise<{ execution: WorkflowExecution; status: WorkflowStatus }>;
  poll?(execution: WorkflowExecution, ctx: CallContext): Promise<WorkflowStatus>;
  /** Turn a body POSTed to the callback URL into a status. */
  callback?(execution: WorkflowExecution, body: unknown, headers: Record<string, string>): Promise<WorkflowStatus>;
  cancel?(execution: WorkflowExecution): Promise<void>;
}

// ------------------------------------------------------------ Knowledge port

/** A body of knowledge a connection can search: a folder of notes, an index, a collection. */
export interface KnowledgeSource {
  id: string;
  name?: string;
  description?: string;
}

/** One piece of text that answers a query, with where it came from. */
export interface Passage {
  text: string;
  source: {
    /** The document, stable across searches. */
    id: string;
    title?: string;
    /** Where a person can open it: a URL or a path. */
    uri?: string;
  };
  /** How well it fits, 0 to 1, when the store says. Higher is better. */
  score?: number;
}

export interface KnowledgeSearchRequest {
  query: string;
  /** Limit the search to these sources; omitted means all of them. */
  sources?: string[];
  /** Most passages to return. */
  limit: number;
}

export interface KnowledgeSearchResult {
  /** Best first. */
  passages: Passage[];
  usage?: ReportedUsage;
}

/**
 * Knowledge port (SRS 4.11): find the passages that answer a query, in a
 * store that already exists. How the store was filled (chunking, embeddings,
 * indexing) is the module's business and never Conclave's.
 */
export interface KnowledgePortV1 {
  listSources(): Promise<KnowledgeSource[]>;
  search(req: KnowledgeSearchRequest, ctx: CallContext): Promise<KnowledgeSearchResult>;
}

/**
 * The ports a module instance provides. Ports without an implementation yet
 * are typed as `unknown` so modules can be declared before core supports them.
 */
export interface PortImplementations {
  model?: ModelPortV1;
  tool?: ToolPortV1;
  agent?: AgentPortV1;
  workflow?: WorkflowPortV1;
  knowledge?: KnowledgePortV1;
  trigger?: unknown;
  channel?: unknown;
  device?: unknown;
  storage?: unknown;
  media?: unknown;
  identity?: unknown;
  secrets?: unknown;
}

import { NodeCallError, type AgentEvent, type AgentRunHandle, type AgentSkill, type CallContext, type ErrorCode } from "@conclave/contract";
import { defineModule, httpError, requireString, statusForError } from "@conclave/module-sdk";

/**
 * Protocol dock for Agent2Agent (A2A): any agent that publishes an Agent Card
 * and answers JSON-RPC becomes an Agent-port node. It speaks protocol 1.0
 * (SendMessage, TASK_STATE_*) and 0.3 (message/send, lower-case states), and
 * picks by what the card says. Tasks are followed by asking for them again,
 * so a run survives a restart of either side.
 */

type Wire = "1.0" | "0.3";

interface Part {
  text?: string;
  data?: unknown;
  kind?: string;
}
interface Message {
  parts?: Part[];
}
interface Task {
  id: string;
  contextId?: string;
  status?: { state?: string; message?: Message };
  artifacts?: { parts?: Part[] }[];
  metadata?: Record<string, unknown>;
}
interface Card {
  name?: string;
  version?: string;
  url?: string;
  protocolVersion?: string;
  preferredTransport?: string;
  additionalInterfaces?: { url?: string; transport?: string }[];
  supportedInterfaces?: { url?: string; protocolBinding?: string; protocolVersion?: string }[];
  skills?: { id?: string; name?: string; description?: string }[];
}

const METHODS: Record<Wire, { send: string; get: string; cancel: string }> = {
  "1.0": { send: "SendMessage", get: "GetTask", cancel: "CancelTask" },
  "0.3": { send: "message/send", get: "tasks/get", cancel: "tasks/cancel" },
};

/** "TASK_STATE_INPUT_REQUIRED" and "input-required" both become "input-required". */
export const taskState = (raw: unknown): string =>
  String(raw ?? "")
    .replace(/^TASK_STATE_/, "")
    .toLowerCase()
    .replace(/_/g, "-");

const textOf = (parts: Part[] | undefined): string =>
  (parts ?? [])
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
const dataOf = (parts: Part[] | undefined): unknown => (parts ?? []).find((p) => p.data !== undefined && p.data !== null)?.data;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** JSON-RPC error codes the A2A specification defines, as contract errors. */
function rpcError(error: { code?: number; message?: string }): NodeCallError {
  const message = error.message ?? "The agent refused the request.";
  const map: Record<number, ErrorCode> = {
    [-32001]: "not_found", // TaskNotFoundError
    [-32002]: "invalid_request", // TaskNotCancelableError
    [-32004]: "invalid_request", // UnsupportedOperationError
    [-32005]: "invalid_request", // ContentTypeNotSupportedError
    [-32009]: "invalid_request", // VersionNotSupportedError
    [-32600]: "invalid_request",
    [-32601]: "invalid_request",
    [-32602]: "invalid_request",
    [-32603]: "unavailable",
  };
  const code = map[error.code ?? 0] ?? "internal";
  return new NodeCallError(code, `A2A: ${message}`, code === "unavailable");
}

export default defineModule({
  manifest: {
    id: "conclave/a2a",
    version: "1.0.0",
    name: "A2A agent",
    description: "Any agent that speaks Agent2Agent (A2A). Give it the agent's address; its skills come from the Agent Card.",
    ports: ["agent@1"],
    docks: ["protocol"],
    config: [
      {
        key: "url",
        label: "Agent address",
        type: "url",
        required: true,
        placeholder: "https://agent.example.com",
        help: "The agent's base address, or the address of its Agent Card. The card is read from /.well-known/agent-card.json.",
      },
      { key: "token", label: "Access token", type: "secret", help: "Sent as Authorization: Bearer, when the agent needs one." },
      {
        key: "extraHosts",
        label: "Other hosts",
        type: "string",
        placeholder: "rpc.example.com",
        help: "Comma-separated. Only needed when the card sends calls to a different host than the address above.",
      },
      { key: "pollSeconds", label: "Seconds between checks", type: "number", default: 3 },
      { key: "pricePerCallUsd", label: "Price per run (USD)", type: "number", help: "Used when the agent does not report what a run cost." },
      { key: "pricePerMinuteUsd", label: "Price per minute (USD)", type: "number" },
    ],
    permissions: { egress: ["{config.url}", "{config.extraHosts[]}"], secrets: ["token"] },
    outsideVersions: { a2a: "1.0, 0.3" },
    reference: true,
  },
  create(ctx) {
    const address = () => requireString(ctx.config.url, "Agent address");
    const pollMs = Math.max(0, Number(ctx.config.pollSeconds ?? 3) * 1000);
    const headers = (wire?: Wire): Record<string, string> => ({
      accept: "application/json",
      ...(ctx.secrets.token ? { authorization: `Bearer ${ctx.secrets.token}` } : {}),
      // 1.0 agents must be told the version; an empty value means 0.3.
      ...(wire === "1.0" ? { "a2a-version": "1.0" } : {}),
    });

    let cached: { at: number; card: Card; endpoint: string; wire: Wire } | undefined;
    const agent = async (signal?: AbortSignal, fresh = false) => {
      if (cached && !fresh && Date.now() - cached.at < 5 * 60_000) return cached;
      const base = address();
      const candidates = /\.json($|\?)/.test(base)
        ? [base]
        : [new URL("/.well-known/agent-card.json", base).href, new URL("/.well-known/agent.json", base).href];
      let card: Card | undefined;
      let last: NodeCallError | undefined;
      for (const url of candidates) {
        const res = await ctx.fetch(url, { headers: headers(), ...(signal ? { signal } : {}) });
        if (res.ok) {
          card = (await res.json().catch(() => undefined)) as Card | undefined;
          if (card && typeof card === "object") break;
          card = undefined;
          last = new NodeCallError("invalid_request", `${url} is not an Agent Card.`, false);
        } else {
          last = httpError(res.status, `The Agent Card at ${url} answered ${res.status}.`);
          if (res.status !== 404) break;
        }
      }
      if (!card) throw last ?? new NodeCallError("not_found", "No Agent Card found.", false);

      // 1.0 cards list interfaces, preferred first; 0.3 cards have one url and maybe more interfaces.
      const v1 = card.supportedInterfaces?.find((i) => i.protocolBinding === "JSONRPC" && i.url);
      const v03 =
        card.url && (!card.preferredTransport || card.preferredTransport === "JSONRPC")
          ? card.url
          : card.additionalInterfaces?.find((i) => i.transport === "JSONRPC" && i.url)?.url;
      const endpoint = v1?.url ?? v03;
      if (!endpoint) throw new NodeCallError("invalid_request", `${card.name ?? "This agent"} offers no JSON-RPC interface, the only one this dock speaks.`, false);
      const wire: Wire = v1 ? (String(v1.protocolVersion ?? "1.0").startsWith("0.") ? "0.3" : "1.0") : "0.3";
      cached = { at: Date.now(), card, endpoint: new URL(endpoint, base).href, wire };
      return cached;
    };

    const rpc = async <T>(method: keyof (typeof METHODS)[Wire], params: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
      const { endpoint, wire } = await agent(signal);
      const res = await ctx.fetch(endpoint, {
        method: "POST",
        headers: { ...headers(wire), "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: METHODS[wire][method], params }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw httpError(res.status, `The agent answered ${res.status}.`);
      const body = (await res.json().catch(() => null)) as { result?: T; error?: { code?: number; message?: string } } | null;
      if (!body) throw new NodeCallError("unavailable", "The agent's answer was not JSON.", true);
      if (body.error) throw rpcError(body.error);
      return body.result as T;
    };

    const message = (wire: Wire, text: string, data: unknown, ids: { taskId?: string; contextId?: string }, metadata?: Record<string, unknown>) => {
      const parts =
        wire === "1.0"
          ? [{ text }, ...(data !== undefined ? [{ data, mediaType: "application/json" }] : [])]
          : [{ kind: "text", text }, ...(data !== undefined ? [{ kind: "data", data }] : [])];
      return {
        ...(wire === "0.3" ? { kind: "message" } : {}),
        messageId: crypto.randomUUID(),
        role: wire === "1.0" ? "ROLE_USER" : "user",
        parts,
        ...ids,
        ...(metadata ? { metadata } : {}),
      };
    };

    /** Send a message without waiting for the task to finish; the answer is a task or a direct message. */
    const send = async (text: string, data: unknown, ids: { taskId?: string; contextId?: string }, metadata: Record<string, unknown> | undefined, signal?: AbortSignal) => {
      const { wire } = await agent(signal);
      const result = await rpc<Record<string, unknown>>(
        "send",
        { message: message(wire, text, data, ids, metadata), configuration: wire === "1.0" ? { returnImmediately: true } : { blocking: false } },
        signal,
      );
      // 1.0 wraps the answer as { task } or { message }; 0.3 returns it bare, marked by `kind`.
      const task = (result?.task ?? (result?.kind === "task" || (result?.id && result?.status) ? result : undefined)) as Task | undefined;
      const direct = (result?.message ?? (!task ? result : undefined)) as Message | undefined;
      return { task, direct };
    };

    const finalEvent = (task: Task): AgentEvent | null => {
      const state = taskState(task.status?.state);
      const said = textOf(task.status?.message?.parts);
      if (state === "completed") {
        const parts = (task.artifacts ?? []).flatMap((a) => a.parts ?? []);
        const data = dataOf(parts);
        const usage = task.metadata?.usage as { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
        return {
          type: "completed",
          text: textOf(parts) || said,
          ...(data !== undefined ? { data } : {}),
          ...(usage && typeof usage === "object" ? { usage } : {}),
        };
      }
      if (state === "failed") return { type: "failed", message: said || "The agent's task failed.", code: "internal" };
      if (state === "rejected") return { type: "failed", message: said || "The agent turned the task down.", code: "refused", retryable: false };
      if (state === "canceled" || state === "cancelled") return { type: "failed", message: said || "The agent's task was cancelled.", code: "cancelled", retryable: false };
      if (state === "auth-required") {
        return { type: "failed", message: said || "The agent needs credentials this connection does not have.", code: "auth", retryable: false };
      }
      return null;
    };

    return {
      ports: {
        agent: {
          async listSkills(): Promise<AgentSkill[]> {
            const { card } = await agent();
            return (card.skills ?? [])
              .filter((s): s is { id: string; name?: string; description?: string } => typeof s.id === "string" && s.id !== "")
              .map((s) => ({ id: s.id, ...(s.name ? { name: s.name } : {}), ...(s.description ? { description: s.description } : {}) }));
          },

          async startRun(input, call): Promise<AgentRunHandle> {
            const metadata = {
              ...(input.skill ? { skill: input.skill } : {}),
              // So the agent's own telemetry joins the task's trace.
              traceparent: call.call.trace.traceparent,
            };
            const { task, direct } = await send(input.text, input.data, {}, metadata, call.signal);
            if (task) return { externalRunId: task.id, state: { ...(task.contextId ? { contextId: task.contextId } : {}) } };
            // Some agents answer straight away with a message and no task.
            const text = textOf(direct?.parts);
            const data = dataOf(direct?.parts);
            return { externalRunId: `message-${crypto.randomUUID()}`, state: { direct: { text, ...(data !== undefined ? { data } : {}) } } };
          },

          async *streamEvents(handle: AgentRunHandle, call: CallContext): AsyncIterable<AgentEvent> {
            const direct = handle.state?.direct as { text: string; data?: unknown } | undefined;
            if (direct) {
              yield { type: "completed", text: direct.text, ...(direct.data !== undefined ? { data: direct.data } : {}) };
              return;
            }
            let lastNote = "";
            let asked: string | null = null;
            while (!call.signal.aborted) {
              const task = await rpc<Task>("get", { id: handle.externalRunId }, call.signal);
              const done = finalEvent(task);
              if (done) {
                yield done;
                return;
              }
              const note = textOf(task.status?.message?.parts);
              if (taskState(task.status?.state) === "input-required") {
                // Asked once; the answer goes back through provideInput and the task moves on.
                const prompt = note || "The agent needs more information to carry on.";
                if (asked !== prompt) {
                  asked = prompt;
                  yield { type: "needs_input", prompt };
                }
              } else if (note && note !== lastNote) {
                asked = null;
                lastNote = note;
                yield { type: "progress", text: note };
              }
              await sleep(pollMs, call.signal);
            }
          },

          async provideInput(handle, answer, call) {
            const contextId = typeof handle.state?.contextId === "string" ? handle.state.contextId : undefined;
            await send(answer, undefined, { taskId: handle.externalRunId, ...(contextId ? { contextId } : {}) }, undefined, call.signal);
          },

          async cancel(handle) {
            if (handle.state?.direct) return;
            try {
              await rpc("cancel", { id: handle.externalRunId });
            } catch (err) {
              // A task that already ended cannot be cancelled, which is what was wanted.
              if (!(err instanceof NodeCallError) || (err.code !== "invalid_request" && err.code !== "not_found")) throw err;
            }
          },
        },
      },

      async health(signal) {
        try {
          const { card, wire } = await agent(signal, true);
          const skills = card.skills?.length ?? 0;
          return { status: "working", detail: `${card.name ?? "Agent"} answers, A2A ${wire}, ${skills} skill${skills === 1 ? "" : "s"}.` };
        } catch (err) {
          return statusForError(err);
        }
      },
      async outsideVersion(signal) {
        try {
          return (await agent(signal)).card.version ?? null;
        } catch {
          return null;
        }
      },
      async discover(signal) {
        const { card } = await agent(signal);
        return { skills: (card.skills ?? []).filter((s) => s.id).map((s) => ({ id: s.id!, ...(s.name ? { name: s.name } : {}) })) };
      },
    };
  },
});

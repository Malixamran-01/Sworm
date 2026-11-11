import { NodeCallError, newId, type AgentEvent, type AgentRunHandle, type CallContext, type NodeCall, type WorkflowStatus } from "@conclave/contract";
import { declaredPorts, type ConclaveModule, type ModuleContext } from "./index";
import { manifestSchema } from "./manifest";

/**
 * Conformance kit (MOD-006). Runs a module against the ports it declares.
 * Passing it is required for the Verified badge and for the built-in dock.
 */

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ConformanceReport {
  moduleId: string;
  version: string;
  passed: boolean;
  checks: ConformanceCheck[];
}

export interface ConformanceOptions {
  config?: ModuleContext["config"];
  secrets?: Record<string, string>;
  /** Recorded or mocked outside system; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Model used for model@1 generate checks; defaults to the first listed model. */
  model?: string;
  /** Tool and arguments used for tool@1 call checks; defaults to the first listed tool with no arguments. */
  tool?: string;
  toolArgs?: Record<string, unknown>;
  /** Query used for knowledge@1 search checks; defaults to a short one. */
  knowledgeQuery?: string;
  /** Skill and task for agent@1 checks; defaults to the first skill and a short task. */
  agentSkill?: string;
  agentTask?: string;
  /** Answer given if the agent asks a question during the check. */
  agentAnswer?: string;
  /** Workflow and inputs for workflow@1 checks; defaults to the first workflow and no inputs. */
  workflow?: string;
  workflowInputs?: Record<string, unknown>;
  /** How long a run may take before the check fails. Default 30 s. */
  runTimeoutMs?: number;
}

const AGENT_EVENTS = new Set(["progress", "needs_input", "completed", "failed"]);
const WORKFLOW_STATES = new Set(["running", "succeeded", "failed", "cancelled"]);
/** Handles are kept in checkpoints, so they must survive a JSON round trip unchanged. */
const plainJson = (value: unknown, what: string) => {
  if (JSON.stringify(JSON.parse(JSON.stringify(value))) !== JSON.stringify(value)) throw new Error(`${what} is not plain JSON.`);
};

export function testCallContext(signal?: AbortSignal): CallContext {
  const call: NodeCall = {
    callId: newId(),
    runId: newId(),
    parentCallId: null,
    depth: 0,
    nodeId: "conformance",
    input: {},
    budget: { usd: 1 },
    permissions: [],
    trace: { traceparent: "00-00000000000000000000000000000000-0000000000000000-00" },
    idempotencyKey: `conformance:${newId()}`,
  };
  return { call, signal: signal ?? new AbortController().signal, emit: () => {} };
}

export async function runConformance(mod: ConclaveModule, opts: ConformanceOptions = {}): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      checks.push({ name, passed: true, ...(detail ? { detail } : {}) });
    } catch (err) {
      checks.push({ name, passed: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  await check("manifest is valid", async () => {
    manifestSchema.parse(mod.manifest);
  });

  const ctx: ModuleContext = {
    config: opts.config ?? {},
    secrets: opts.secrets ?? {},
    fetch: opts.fetch ?? fetch,
    log: { info: () => {}, warn: () => {} },
  };
  let instance: ReturnType<ConclaveModule["create"]> | undefined;
  await check("module creates an instance", async () => {
    instance = mod.create(ctx);
  });
  if (!instance) return finish(mod, checks);
  const inst = instance;

  for (const port of declaredPorts(mod.manifest)) {
    await check(`implements declared port "${port}"`, async () => {
      if (!inst.ports[port]) throw new Error(`Manifest declares ${port}@1 but the instance has no ${port} port.`);
    });
  }

  await check("health reports a known status", async () => {
    const health = await inst.health();
    const known = ["working", "rate_limited", "signed_out", "unreachable", "unknown"];
    if (!known.includes(health.status)) throw new Error(`Unknown status "${health.status}".`);
    return `${health.status}: ${health.detail}`;
  });

  const model = inst.ports.model;
  if (model) {
    let modelId = opts.model;
    await check("model: listModels returns models", async () => {
      const models = await model.listModels();
      if (!Array.isArray(models)) throw new Error("listModels did not return an array.");
      for (const m of models) if (typeof m.id !== "string" || !m.id) throw new Error("A model has no id.");
      modelId ??= models[0]?.id;
      return `${models.length} model(s)`;
    });

    await check("model: generate returns text and integer usage", async () => {
      if (!modelId) throw new Error("No model to test with.");
      const result = await model.generate(
        { model: modelId, messages: [{ role: "user", content: "Reply with the word ok." }], maxTokens: 32 },
        testCallContext(),
      );
      if (typeof result.text !== "string") throw new Error("text is not a string.");
      const { inputTokens, outputTokens } = result.usage;
      if (!Number.isInteger(inputTokens) || inputTokens < 0) throw new Error("usage.inputTokens is not a non-negative integer.");
      if (!Number.isInteger(outputTokens) || outputTokens < 0) throw new Error("usage.outputTokens is not a non-negative integer.");
    });

    await check("model: generate honours cancellation", async () => {
      if (!modelId) throw new Error("No model to test with.");
      const controller = new AbortController();
      controller.abort();
      try {
        await model.generate(
          { model: modelId, messages: [{ role: "user", content: "Count to ten." }], maxTokens: 32 },
          testCallContext(controller.signal),
        );
      } catch (err) {
        if (err instanceof NodeCallError && err.code === "cancelled") return;
        if (err instanceof Error && err.name === "AbortError") return;
        throw new Error(`Expected a cancelled error, got: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw new Error("generate resolved even though the call was already cancelled.");
    });

    await check("model: errors use contract error codes", async () => {
      try {
        await model.generate({ model: "", messages: [], maxTokens: 1 }, testCallContext());
      } catch (err) {
        if (err instanceof NodeCallError) return `threw ${err.code}`;
        throw new Error(`Threw a ${err instanceof Error ? err.name : typeof err} instead of a NodeCallError.`);
      }
      throw new Error("An empty request should be rejected.");
    });
  }

  const tools = inst.ports.tool;
  if (tools) {
    let toolName = opts.tool;
    await check("tool: listTools returns tools with input schemas", async () => {
      const list = await tools.listTools();
      if (!Array.isArray(list)) throw new Error("listTools did not return an array.");
      for (const t of list) {
        if (typeof t.name !== "string" || !t.name) throw new Error("A tool has no name.");
        if (typeof t.inputSchema !== "object" || t.inputSchema === null) throw new Error(`Tool ${t.name} has no input schema.`);
      }
      toolName ??= list[0]?.name;
      return `${list.length} tool(s)`;
    });

    if (toolName) {
      await check("tool: call returns data", async () => {
        const result = await tools.call(toolName!, opts.toolArgs ?? {}, testCallContext());
        if (!result || !("data" in result)) throw new Error("call did not return { data }.");
      });
    }

    await check("tool: call honours cancellation", async () => {
      const controller = new AbortController();
      controller.abort();
      try {
        await tools.call(toolName ?? "anything", {}, testCallContext(controller.signal));
      } catch (err) {
        if (err instanceof NodeCallError && err.code === "cancelled") return;
        throw new Error(`Expected a cancelled error, got: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw new Error("call resolved even though the call was already cancelled.");
    });

    await check("tool: errors use contract error codes", async () => {
      try {
        await tools.call("", {}, testCallContext());
      } catch (err) {
        if (err instanceof NodeCallError) return `threw ${err.code}`;
        throw new Error(`Threw a ${err instanceof Error ? err.name : typeof err} instead of a NodeCallError.`);
      }
      throw new Error("An empty tool name should be rejected.");
    });
  }

  const knowledge = inst.ports.knowledge;
  if (knowledge) {
    await check("knowledge: listSources returns sources", async () => {
      const list = await knowledge.listSources();
      if (!Array.isArray(list)) throw new Error("listSources did not return an array.");
      for (const s of list) if (typeof s.id !== "string" || !s.id) throw new Error("A source has no id.");
      return `${list.length} source(s)`;
    });

    await check("knowledge: search returns passages with a source, best first, within the limit", async () => {
      const found = await knowledge.search({ query: opts.knowledgeQuery ?? "what is this about", limit: 3 }, testCallContext());
      if (!found || !Array.isArray(found.passages)) throw new Error("search did not return { passages }.");
      if (found.passages.length > 3) throw new Error(`Asked for 3 passages and got ${found.passages.length}.`);
      let last = Infinity;
      for (const p of found.passages) {
        if (typeof p.text !== "string" || !p.text) throw new Error("A passage has no text.");
        if (typeof p.source?.id !== "string" || !p.source.id) throw new Error("A passage does not say which document it came from.");
        if (p.score !== undefined) {
          if (typeof p.score !== "number" || p.score < 0 || p.score > 1) throw new Error("A score is not between 0 and 1.");
          if (p.score > last + 1e-9) throw new Error("Passages are not ordered best first.");
          last = p.score;
        }
      }
      plainJson(found.passages, "The passages");
      return `${found.passages.length} passage(s)`;
    });

    await check("knowledge: search honours cancellation", async () => {
      const controller = new AbortController();
      controller.abort();
      try {
        await knowledge.search({ query: "anything", limit: 1 }, testCallContext(controller.signal));
      } catch (err) {
        if (err instanceof NodeCallError && err.code === "cancelled") return;
        throw new Error(`Expected a cancelled error, got: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw new Error("search resolved even though the call was already cancelled.");
    });

    await check("knowledge: errors use contract error codes", async () => {
      try {
        await knowledge.search({ query: "", limit: 1 }, testCallContext());
      } catch (err) {
        if (err instanceof NodeCallError) return `threw ${err.code}`;
        throw new Error(`Threw a ${err instanceof Error ? err.name : typeof err} instead of a NodeCallError.`);
      }
      throw new Error("An empty query should be rejected.");
    });
  }

  const agent = inst.ports.agent;
  if (agent) {
    let skill = opts.agentSkill;
    const timeout = opts.runTimeoutMs ?? 30_000;
    await check("agent: listSkills returns skills", async () => {
      const skills = await agent.listSkills();
      if (!Array.isArray(skills)) throw new Error("listSkills did not return an array.");
      for (const s of skills) if (typeof s.id !== "string" || !s.id) throw new Error("A skill has no id.");
      skill ??= skills[0]?.id;
      return `${skills.length} skill(s)`;
    });

    let handle: AgentRunHandle | undefined;
    let final: AgentEvent | undefined;
    await check("agent: a run streams known events to a final one", async () => {
      handle = await agent.startRun({ ...(skill ? { skill } : {}), text: opts.agentTask ?? "Write one sentence about the sea." }, testCallContext());
      if (typeof handle?.externalRunId !== "string" || !handle.externalRunId) throw new Error("startRun returned no externalRunId.");
      plainJson(handle, "The run handle");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const seen: string[] = [];
      try {
        for await (const event of agent.streamEvents(handle, testCallContext(controller.signal))) {
          if (!AGENT_EVENTS.has(event.type)) throw new Error(`Unknown event type "${String((event as { type: unknown }).type)}".`);
          seen.push(event.type);
          if (event.type === "needs_input") {
            if (opts.agentAnswer === undefined) {
              final = event;
              break;
            }
            await agent.provideInput(handle, opts.agentAnswer, testCallContext());
          }
          if (event.type === "completed" || event.type === "failed") {
            final = event;
            break;
          }
        }
      } finally {
        clearTimeout(timer);
      }
      if (!final) throw new Error(`No final event within ${timeout / 1000} s (saw ${seen.join(", ") || "nothing"}).`);
      return seen.join(" → ");
    });

    if (handle && final && final.type !== "needs_input") {
      await check("agent: watching a finished run again yields its final event", async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
          for await (const event of agent.streamEvents(handle!, testCallContext(controller.signal))) {
            if (event.type === final!.type) return;
          }
        } finally {
          clearTimeout(timer);
        }
        throw new Error("A second streamEvents on a finished run did not yield its final event: a restarted host could not finish the step.");
      });
    }

    await check("agent: cancel resolves", async () => {
      const h = await agent.startRun({ ...(skill ? { skill } : {}), text: "A run to cancel." }, testCallContext());
      await agent.cancel(h);
    });

    await check("agent: errors use contract error codes", async () => {
      try {
        await agent.startRun({ skill: "no-such-skill-for-conformance", text: "x" }, testCallContext());
      } catch (err) {
        if (err instanceof NodeCallError) return `threw ${err.code}`;
        throw new Error(`Threw a ${err instanceof Error ? err.name : typeof err} instead of a NodeCallError.`);
      }
      return "accepted an unknown skill (allowed when an agent has no fixed skills)";
    });
  }

  const flow = inst.ports.workflow;
  if (flow) {
    let workflowId = opts.workflow;
    const timeout = opts.runTimeoutMs ?? 30_000;
    await check("workflow: listWorkflows returns workflows", async () => {
      const list = await flow.listWorkflows();
      if (!Array.isArray(list)) throw new Error("listWorkflows did not return an array.");
      for (const w of list) if (typeof w.id !== "string" || !w.id) throw new Error("A workflow has no id.");
      workflowId ??= list[0]?.id;
      return `${list.length} workflow(s)`;
    });

    if (workflowId) {
      await check("workflow: trigger reaches a final status", async () => {
        const { execution, status } = await flow.trigger(workflowId!, { data: opts.workflowInputs ?? {} }, testCallContext());
        if (typeof execution?.executionId !== "string" || !execution.executionId) throw new Error("trigger returned no executionId.");
        plainJson(execution, "The execution handle");
        let current: WorkflowStatus = status;
        const until = Date.now() + timeout;
        while (current.state === "running") {
          if (!flow.poll) return "running; the result comes by callback";
          if (Date.now() > until) throw new Error(`Still running after ${timeout / 1000} s.`);
          await new Promise((r) => setTimeout(r, 200));
          current = await flow.poll(execution, testCallContext());
        }
        if (!WORKFLOW_STATES.has(current.state)) throw new Error(`Unknown state "${String(current.state)}".`);
        return current.state;
      });
    }

    await check("workflow: errors use contract error codes", async () => {
      try {
        await flow.trigger("no-such-workflow-for-conformance", { data: {} }, testCallContext());
      } catch (err) {
        if (err instanceof NodeCallError) return `threw ${err.code}`;
        throw new Error(`Threw a ${err instanceof Error ? err.name : typeof err} instead of a NodeCallError.`);
      }
      return "accepted an unknown workflow id (allowed when a module serves one workflow)";
    });
  }

  await inst.close?.();
  return finish(mod, checks);
}

function finish(mod: ConclaveModule, checks: ConformanceCheck[]): ConformanceReport {
  return {
    moduleId: mod.manifest.id,
    version: mod.manifest.version,
    passed: checks.every((c) => c.passed),
    checks,
  };
}

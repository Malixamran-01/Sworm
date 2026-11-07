import { NodeCallError, newId, type CallContext, type NodeCall } from "@conclave/contract";
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
}

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

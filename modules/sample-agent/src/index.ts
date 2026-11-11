import { NodeCallError, type AgentEvent, type WorkflowStatus } from "@conclave/contract";
import { defineModule } from "@conclave/module-sdk";

/**
 * A sample module made only with the public Module SDK (MOD-010, MOD-014's
 * gate): an agent with two skills and a small workflow engine. It does its
 * work locally, so it runs anywhere and costs nothing. Use it as a template.
 *
 * Skills:
 * - brief: works in steps, reporting progress, and returns a short brief.
 * - interview: asks a person what to focus on first, then answers.
 * Workflows:
 * - word-count: answers at once.
 * - slow-count: answers after a while; poll for it.
 */

interface Run {
  events: AgentEvent[];
  wake: Set<() => void>;
  cancelled: boolean;
  text: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const firstSentence = (text: string) => (/^[^.!?\n]+[.!?]?/.exec(text.trim())?.[0] ?? text.trim()).slice(0, 300);

export default defineModule({
  manifest: {
    id: "conclave/sample-agent",
    version: "1.0.0",
    name: "Sample agent",
    description: "Writes short briefs, asks what to focus on, and counts words. Built with the public Module SDK as a template for your own.",
    ports: ["agent@1", "workflow@1"],
    docks: ["remote", "sidecar", "bridge"],
    config: [{ key: "stepMs", label: "Milliseconds per step", type: "number", default: 400 }],
    permissions: { egress: [], secrets: [] },
  },
  create(ctx) {
    const stepMs = Number(ctx.config.stepMs ?? 400) || 0;
    const runs = new Map<string, Run>();
    const executions = new Map<string, { done: number; text: string; cancelled: boolean }>();
    let counter = 0;

    const push = (id: string, event: AgentEvent) => {
      const run = runs.get(id);
      if (!run || run.cancelled) return;
      run.events.push(event);
      for (const w of run.wake) w();
      run.wake.clear();
    };
    const finish = (text: string, prefix: string) => {
      const count = words(text).length;
      return {
        type: "completed" as const,
        text: `${prefix}\n\nIn one line: ${firstSentence(text)}\nLength of the request: ${count} words.`,
        data: { words: count },
        usage: { inputTokens: count, outputTokens: 40, costUsd: 0 },
      };
    };

    return {
      ports: {
        agent: {
          listSkills: async () => [
            { id: "brief", name: "Write a brief", description: "Works in steps and returns a short brief." },
            { id: "interview", name: "Ask, then answer", description: "Asks what to focus on before it answers." },
          ],
          async startRun(input) {
            const id = `sample-${++counter}-${Date.now().toString(36)}`;
            runs.set(id, { events: [], wake: new Set(), cancelled: false, text: input.text });
            const skill = input.skill ?? "brief";
            if (skill !== "brief" && skill !== "interview") throw new NodeCallError("invalid_request", `No skill "${skill}".`, false);
            void (async () => {
              for (const step of ["Reading the request", "Outlining", skill === "interview" ? "Deciding what to ask" : "Writing"]) {
                await sleep(stepMs);
                push(id, { type: "progress", text: step });
              }
              if (skill === "interview") push(id, { type: "needs_input", prompt: "What should I focus on?" });
              else push(id, finish(input.text, "Brief"));
            })();
            return { externalRunId: id };
          },
          async *streamEvents(handle, call) {
            const run = runs.get(handle.externalRunId);
            if (!run) throw new NodeCallError("not_found", "This agent no longer knows that run (it may have restarted).", false);
            let i = 0;
            while (!call.signal.aborted && !run.cancelled) {
              while (i < run.events.length) {
                const event = run.events[i++]!;
                yield event;
                if (event.type === "completed" || event.type === "failed") return;
              }
              await new Promise<void>((resolve) => {
                run.wake.add(resolve);
                call.signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
          },
          async provideInput(handle, answer) {
            const run = runs.get(handle.externalRunId);
            if (!run) throw new NodeCallError("not_found", "Unknown run.", false);
            push(handle.externalRunId, { type: "progress", text: `Focusing on: ${answer.slice(0, 120)}` });
            setTimeout(() => push(handle.externalRunId, finish(run.text, `Focus: ${answer}`)), stepMs);
          },
          async cancel(handle) {
            const run = runs.get(handle.externalRunId);
            if (run) run.cancelled = true;
          },
        },
        workflow: {
          listWorkflows: async () => [
            { id: "word-count", name: "Count words", description: "Answers at once." },
            { id: "slow-count", name: "Count words slowly", description: "Answers after a few steps; poll for it." },
          ],
          async trigger(workflowId, input) {
            const text = Object.values(input.data ?? {})
              .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
              .join(" ");
            const id = `exec-${++counter}`;
            if (workflowId === "word-count") return { execution: { executionId: id }, status: { state: "succeeded", output: { data: { words: words(text).length } } } };
            if (workflowId !== "slow-count") throw new NodeCallError("not_found", `No workflow "${workflowId}".`, false);
            executions.set(id, { done: Date.now() + stepMs * 3, text, cancelled: false });
            return { execution: { executionId: id }, status: { state: "running", progress: "Counting" } };
          },
          async poll(execution): Promise<WorkflowStatus> {
            const e = executions.get(execution.executionId);
            if (!e) return { state: "failed", message: "Unknown execution." };
            if (e.cancelled) return { state: "cancelled" };
            if (Date.now() < e.done) return { state: "running", progress: "Still counting" };
            return { state: "succeeded", output: { data: { words: words(e.text).length } } };
          },
          async cancel(execution) {
            const e = executions.get(execution.executionId);
            if (e) e.cancelled = true;
          },
        },
      },
      health: async () => ({ status: "working", detail: "Ready." }),
      discover: async () => ({ skills: [{ id: "brief" }, { id: "interview" }], workflows: [{ id: "word-count" }, { id: "slow-count" }] }),
    };
  },
});

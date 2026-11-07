import { workspaceTemplateSchema, type BuilderAnswers as BuilderAnswersDto, type InputField, type RoleTemplate, type Step, type WorkspaceTemplate } from "@conclave/contract";
import { z } from "zod";
import { invalid } from "./errors";

/**
 * Guided workspace builder (WS-001). A few answers compose roles, task types
 * and a workflow from fixed building blocks. No model is involved, so the
 * same answers always give the same workspace.
 */
export const builderAnswersSchema = z.object({
  goal: z.enum(["research", "write", "summarize", "answer", "custom"]),
  /** For "custom": what the assistant should do, in plain words. */
  customGoal: z.string().max(2_000).optional(),
  /** Who the results are for; folded into instructions. */
  audience: z.string().max(200).optional(),
  /** A person approves before anything is delivered. */
  approval: z.boolean().default(true),
  /** A reviewer role checks the work against the brief before it reaches you. */
  check: z.boolean().default(false),
  /** Start from a search tool (any MCP server); skipped when none is connected. */
  search: z.boolean().default(false),
  name: z.string().max(120).optional(),
  budgetMonthUsd: z.number().positive().max(100_000).optional(),
  budgetTaskUsd: z.number().positive().max(10_000).optional(),
});
export type BuilderAnswers = z.input<typeof builderAnswersSchema>;
// The schema and the shared DTO describe the same answers.
const _sameShape: BuilderAnswersDto = {} as BuilderAnswers;
void _sameShape;

interface Goal {
  name: string;
  description: string;
  taskName: string;
  inputs: InputField[];
  /** The roles doing the main work, in order; each produces one step. */
  workers: { role: RoleTemplate; prompt: string; maxTokens: number }[];
}

const forAudience = (audience?: string) => (audience?.trim() ? ` The results are for: ${audience.trim()}.` : "");

function goals(a: z.infer<typeof builderAnswersSchema>): Record<z.infer<typeof builderAnswersSchema>["goal"], Goal> {
  const who = forAudience(a.audience);
  return {
    research: {
      name: "Research",
      description: "Researches a topic and turns the findings into a clear brief.",
      taskName: "Research brief",
      inputs: [
        { key: "topic", label: "Topic", type: "text", required: true, placeholder: "What should the brief cover?" },
        { key: "notes", label: "Notes", type: "longtext", required: false, placeholder: "Anything the researcher should know" },
      ],
      workers: [
        {
          role: {
            key: "researcher",
            name: "Researcher",
            description: "Finds the key facts, angles and open questions.",
            instructions: `You are a careful researcher. List key facts, useful angles, objections and open questions. Say what you are unsure of and never invent sources or figures.${who}`,
            port: "model@1",
            effort: "high",
          },
          prompt: "Topic: {{input.topic}}\nNotes: {{input.notes}}\n\nSearch results, if any:\n{{steps.search.output}}\n\nReturn structured research notes.",
          maxTokens: 6000,
        },
        {
          role: {
            key: "editor",
            name: "Editor",
            description: "Turns research notes into a brief people can act on.",
            instructions: `You are an editor. Write a brief with a one-paragraph summary, then short sections with headings. Keep every caveat.${who}`,
            port: "model@1",
            effort: "high",
          },
          prompt: 'Write the brief on "{{input.topic}}".\n\nResearch notes:\n{{steps.research.output}}',
          maxTokens: 6000,
        },
      ],
    },
    write: {
      name: "Writing",
      description: "Writes posts, articles and copy from a short brief.",
      taskName: "Piece of writing",
      inputs: [
        { key: "topic", label: "What to write", type: "text", required: true, placeholder: "A LinkedIn post about our new feature" },
        { key: "tone", label: "Tone", type: "text", required: false, placeholder: "Friendly, plain, confident" },
        { key: "notes", label: "Notes", type: "longtext", required: false, placeholder: "Facts, links or points to include" },
      ],
      workers: [
        {
          role: {
            key: "writer",
            name: "Writer",
            description: "Writes the piece in the requested tone.",
            instructions: `You are a skilled writer. Follow the brief exactly, keep it concrete and readable, and match the requested tone.${who}`,
            port: "model@1",
            effort: "high",
          },
          prompt: "Write: {{input.topic}}\nTone: {{input.tone}}\nNotes: {{input.notes}}\n\nSearch results, if any:\n{{steps.search.output}}",
          maxTokens: 4000,
        },
      ],
    },
    summarize: {
      name: "Summaries",
      description: "Summarizes documents, threads and notes into what matters.",
      taskName: "Summary",
      inputs: [
        { key: "text", label: "Text to summarize", type: "longtext", required: true, placeholder: "Paste the document or thread" },
        { key: "focus", label: "Focus", type: "text", required: false, placeholder: "Decisions and next steps" },
      ],
      workers: [
        {
          role: {
            key: "summarizer",
            name: "Summarizer",
            description: "Pulls out what matters, without adding anything.",
            instructions: `You summarize faithfully. Lead with the main point, then the decisions, numbers and open questions. Never add facts that are not in the text.${who}`,
            port: "model@1",
            effort: "medium",
          },
          prompt: "Focus: {{input.focus}}\n\nText:\n{{input.text}}",
          maxTokens: 3000,
        },
      ],
    },
    answer: {
      name: "Answers",
      description: "Answers questions from the context you give it.",
      taskName: "Question",
      inputs: [
        { key: "question", label: "Question", type: "text", required: true, placeholder: "What should we decide about…?" },
        { key: "context", label: "Context", type: "longtext", required: false, placeholder: "Background, documents, constraints" },
      ],
      workers: [
        {
          role: {
            key: "analyst",
            name: "Analyst",
            description: "Answers clearly and shows the reasoning.",
            instructions: `You answer precisely. Give the answer first, then the reasons and any assumptions. Say when the context is not enough.${who}`,
            port: "model@1",
            effort: "high",
          },
          prompt: "Question: {{input.question}}\n\nContext:\n{{input.context}}\n\nSearch results, if any:\n{{steps.search.output}}",
          maxTokens: 4000,
        },
      ],
    },
    custom: {
      name: "Assistant",
      description: a.customGoal?.trim() ? a.customGoal.trim().slice(0, 200) : "A general assistant for one kind of request.",
      taskName: "Request",
      inputs: [{ key: "request", label: "Request", type: "longtext", required: true, placeholder: "What do you need?" }],
      workers: [
        {
          role: {
            key: "assistant",
            name: "Assistant",
            description: "Handles each request.",
            instructions: `${a.customGoal?.trim() || "You are a helpful assistant. Do what the request asks, clearly and completely."}${who}`,
            port: "model@1",
            effort: "high",
          },
          prompt: "{{input.request}}\n\nSearch results, if any:\n{{steps.search.output}}",
          maxTokens: 4000,
        },
      ],
    },
  };
}

/** Each worker's step is named for what it does, so the workflow reads "Writer: write". */
const STEP_KEYS: Record<string, string> = { researcher: "research", editor: "draft", writer: "write", summarizer: "summarize", analyst: "answer", assistant: "respond" };
const keyOf = (role: RoleTemplate) => STEP_KEYS[role.key] ?? role.key;

/** Compose a workspace template from builder answers. Deterministic. */
export function composeWorkspace(input: BuilderAnswers): WorkspaceTemplate {
  const parsed = builderAnswersSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => `${i.path.join(".") || "answers"}: ${i.message}`));
  const a = parsed.data;
  if (a.goal === "custom" && a.search === undefined) a.search = false;
  const goal = goals(a)[a.goal];

  const roles: RoleTemplate[] = [];
  const steps: Step[] = [];
  const searchFirst = a.search && a.goal !== "summarize";

  if (searchFirst) {
    roles.push({ key: "searcher", name: "Searcher", description: "Optional: a search tool from any MCP server.", instructions: "", port: "tool@1" });
    const query = goal.inputs[0]!.key;
    steps.push({ key: "search", kind: "tool", role: "searcher", optional: true, args: { query: `{{input.${query}}}` }, timeoutMs: 120_000 } as Step);
  }

  let last = "";
  for (const w of goal.workers) {
    roles.push(w.role);
    const key = keyOf(w.role);
    steps.push({ key, kind: "role", role: w.role.key, prompt: searchFirst ? w.prompt : w.prompt.replace(/\n*Search results, if any:\n\{\{steps\.search\.output\}\}/, ""), maxTokens: w.maxTokens, output: "text", timeoutMs: 300_000, optional: false } as Step);
    last = key;
  }

  if (a.check) {
    roles.push({
      key: "reviewer",
      name: "Reviewer",
      description: "Checks the work against the brief and fixes what is off.",
      instructions:
        "You review work against its brief. Fix factual slips, gaps and unclear wording, keep what is good, and return only the improved final version.",
      port: "model@1",
      effort: "high",
    });
    steps.push({
      key: "check",
      kind: "role",
      role: "reviewer",
      prompt: `The brief:\n${goal.inputs.map((f) => `${f.label}: {{input.${f.key}}}`).join("\n")}\n\nThe work to review:\n{{steps.${last}.output}}`,
      maxTokens: 6000,
      output: "text",
      timeoutMs: 300_000,
      optional: false,
    } as Step);
    last = "check";
  }

  if (a.approval) {
    steps.push({ key: "review", kind: "approval", title: `Approve the ${goal.taskName.toLowerCase()}`, show: `{{steps.${last}.output}}`, revises: [last], optional: false } as Step);
  }

  const template = workspaceTemplateSchema.parse({
    key: `guided-${a.goal}`,
    name: a.name?.trim() || goal.name,
    description: goal.description,
    budget: { taskUsd: a.budgetTaskUsd ?? 1, monthUsd: a.budgetMonthUsd ?? 25 },
    roles,
    taskTypes: [
      {
        key: a.goal,
        name: goal.taskName,
        description: goal.description,
        inputFields: goal.inputs,
        workflow: { version: 1, output: last, steps },
      },
    ],
  });
  return template;
}

/** A blank workspace: one assistant role and one request task type, ready to reshape. */
export function blankWorkspace(name?: string): WorkspaceTemplate {
  return { ...composeWorkspace({ goal: "custom", approval: false, check: false, search: false, ...(name ? { name } : {}) }), key: "blank" };
}

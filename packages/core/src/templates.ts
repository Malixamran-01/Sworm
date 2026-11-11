import { workspaceTemplateSchema, type WorkspaceTemplate } from "@conclave/contract";

/**
 * Built-in workspace templates. The Research Brief template is the Phase 1
 * gate: a text-only, end-to-end task on the user's own keys (SRS 12.2).
 */
const researchBrief: WorkspaceTemplate = workspaceTemplateSchema.parse({
  key: "research-brief",
  name: "Research Brief",
  description: "A researcher gathers facts and angles, an editor turns them into a brief, and you approve it before it is saved.",
  budget: { taskUsd: 1, monthUsd: 50 },
  roles: [
    {
      key: "researcher",
      name: "Researcher",
      description: "Finds the key facts, angles and open questions.",
      instructions:
        "You are a careful researcher. List the key facts, useful angles, likely objections and open questions for the topic. " +
        "Be specific, say what you are unsure of, and never invent sources or figures.",
      effort: "high",
    },
    {
      key: "searcher",
      name: "Searcher",
      description: "Optional: a search tool from any MCP server, so research starts from fresh sources.",
      port: "tool@1",
    },
    {
      key: "editor",
      name: "Editor",
      description: "Turns research notes into a clear brief for the audience.",
      instructions:
        "You are an editor. Turn research notes into a brief the stated audience can act on: a one-paragraph summary, " +
        "then short sections with headings. Plain words, no filler, keep every caveat the researcher raised.",
      effort: "high",
    },
  ],
  taskTypes: [
    {
      key: "research-brief",
      name: "Research brief",
      description: "Research a topic and get an approved brief.",
      inputFields: [
        { key: "topic", label: "Topic", type: "text", required: true, placeholder: "What should the brief cover?" },
        { key: "audience", label: "Audience", type: "text", required: false, placeholder: "Who will read it?" },
        { key: "notes", label: "Notes", type: "longtext", required: false, placeholder: "Anything the researcher should know" },
      ],
      workflow: {
        version: 1,
        output: "draft",
        steps: [
          {
            key: "search",
            kind: "tool",
            role: "searcher",
            optional: true,
            args: { query: "{{input.topic}}" },
          },
          {
            key: "research",
            kind: "role",
            role: "researcher",
            maxTokens: 6000,
            prompt:
              "Topic: {{input.topic}}\nAudience: {{input.audience}}\nNotes from the requester: {{input.notes}}\n\n" +
              "Search results, if any (cite them where you use them):\n{{steps.search.output}}\n\n" +
              "Research this topic for the audience. Return structured notes: key facts, angles, objections, open questions.",
          },
          {
            key: "draft",
            kind: "role",
            role: "editor",
            maxTokens: 6000,
            prompt:
              "Write the brief on \"{{input.topic}}\" for this audience: {{input.audience}}.\n\nResearch notes:\n{{steps.research.output}}",
          },
          {
            key: "review",
            kind: "approval",
            title: "Approve the brief",
            show: "{{steps.draft.output}}",
            revises: ["draft"],
          },
        ],
      },
    },
  ],
});

/**
 * Branching (WF-009): an AI router reads the message and one of three writers
 * answers, then the branches meet again before a person approves.
 */
const supportTriage: WorkspaceTemplate = workspaceTemplateSchema.parse({
  key: "support-triage",
  name: "Support Triage",
  description: "Sorts a customer message into billing, a bug or anything else, drafts the right kind of reply, and you approve it before it goes anywhere.",
  budget: { taskUsd: 0.5, monthUsd: 30 },
  roles: [
    {
      key: "triager",
      name: "Triager",
      description: "Reads the message and decides what kind of request it is.",
      instructions: "You sort customer messages. Answer with the one category that fits best and nothing else.",
      effort: "low",
    },
    {
      key: "responder",
      name: "Responder",
      description: "Writes the reply in your support voice.",
      instructions:
        "You write customer support replies. Be warm and brief, answer the question that was asked, say plainly what happens next, " +
        "and never promise a refund, a date or a fix that the notes you were given do not support.",
      effort: "medium",
    },
    {
      key: "knowledge",
      name: "Knowledge",
      description: "Optional: your help centre or docs, as a notes folder or a search endpoint.",
      port: "knowledge@1",
    },
  ],
  taskTypes: [
    {
      key: "reply",
      name: "Reply to a customer",
      description: "Sort a message and draft the reply for approval.",
      inputFields: [
        { key: "message", label: "Customer message", type: "longtext", required: true, placeholder: "Paste what the customer wrote" },
        { key: "customer", label: "Customer", type: "text", required: false, placeholder: "Name or account, if you know it" },
      ],
      workflow: {
        version: 1,
        output: "reply",
        steps: [
          { key: "lookup", kind: "lookup", role: "knowledge", optional: true, query: "{{input.message}}", limit: 4 },
          {
            key: "route",
            kind: "classify",
            role: "triager",
            value: "{{input.message}}",
            categories: [
              { key: "billing", label: "Billing", description: "Charges, invoices, refunds, plans and payment problems." },
              { key: "bug", label: "Bug", description: "Something is broken, shows an error or behaves wrongly." },
            ],
            // Anything else, how-to questions included, takes the "other" output.
            other: true,
          },
          {
            key: "billing",
            kind: "role",
            role: "responder",
            needs: [{ step: "route", port: "billing" }],
            maxTokens: 1500,
            prompt:
              "Customer: {{input.customer}}\nMessage:\n{{input.message}}\n\nHelp centre results, if any:\n{{steps.lookup.output}}\n\n" +
              "This is a billing question. Reply to it. Do not promise a refund; say that billing will check the account and what the customer should send, if anything.",
          },
          {
            key: "bug",
            kind: "role",
            role: "responder",
            needs: [{ step: "route", port: "bug" }],
            maxTokens: 1500,
            prompt:
              "Customer: {{input.customer}}\nMessage:\n{{input.message}}\n\nHelp centre results, if any:\n{{steps.lookup.output}}\n\n" +
              "This is a bug report. Reply to it: thank them, say what you understood, ask for the one or two details an engineer would need, and offer a workaround only if the results give one.",
          },
          {
            key: "general",
            kind: "role",
            role: "responder",
            needs: [{ step: "route", port: "other" }],
            maxTokens: 1500,
            prompt:
              "Customer: {{input.customer}}\nMessage:\n{{input.message}}\n\nHelp centre results, if any:\n{{steps.lookup.output}}\n\n" +
              "Answer the question in clear steps. If the results do not cover it, say so and say who will follow up.",
          },
          { key: "reply", kind: "merge", mode: "first", needs: ["billing", "bug", "general"] },
          { key: "review", kind: "approval", title: "Approve the reply", show: "{{steps.reply.output}}" },
        ],
      },
    },
  ],
});

/**
 * Agent port (SRS 4.11): an outside agent does the legwork, may ask a person
 * a question on the way, and a model writes it up.
 */
const fieldResearch: WorkspaceTemplate = workspaceTemplateSchema.parse({
  key: "field-research",
  name: "Field Research",
  description: "An outside agent investigates with its own tools and may ask you a question on the way; a writer turns what it found into a report you approve.",
  budget: { taskUsd: 2, monthUsd: 60 },
  roles: [
    {
      key: "investigator",
      name: "Investigator",
      description: "An agent from any connection: A2A, your own module, or one on your computer through the Local Bridge.",
      instructions: "Investigate the question with the tools you have. Say what you checked, what you found, and what you could not confirm.",
      port: "agent@1",
    },
    {
      key: "writer",
      name: "Writer",
      description: "Turns the findings into a short report.",
      instructions: "You write short reports from findings. Lead with the answer, then the evidence, then what is still unknown. Never add facts that are not in the findings.",
      effort: "high",
    },
  ],
  taskTypes: [
    {
      key: "report",
      name: "Research report",
      description: "Hand a question to an agent and get an approved report.",
      inputFields: [
        { key: "question", label: "Question", type: "text", required: true, placeholder: "What do you want to find out?" },
        { key: "context", label: "Context", type: "longtext", required: false, placeholder: "Anything the agent should know or start from" },
      ],
      workflow: {
        version: 1,
        output: "write",
        steps: [
          {
            key: "investigate",
            kind: "agent",
            role: "investigator",
            optional: true,
            prompt: "Question: {{input.question}}\n\nContext from the requester:\n{{input.context}}",
            timeoutMs: 3_600_000,
          },
          {
            key: "write",
            kind: "role",
            role: "writer",
            maxTokens: 5000,
            prompt:
              "Question: {{input.question}}\nContext: {{input.context}}\n\nWhat the investigator found (empty if no agent is connected yet):\n{{steps.investigate.output}}\n\n" +
              "Write the report.",
          },
          { key: "review", kind: "approval", title: "Approve the report", show: "{{steps.write.output}}", revises: ["write"] },
        ],
      },
    },
  ],
});

/**
 * Workspace steps (WF-008): a planner lists pieces of work and the workflow
 * starts one sub-task for each, three at a time, each with a share of the budget.
 */
const contentDesk: WorkspaceTemplate = workspaceTemplateSchema.parse({
  key: "content-desk",
  name: "Content Desk",
  description: "A planner breaks a theme into posts, each post is written as its own sub-task side by side, and you approve the set with an overview.",
  budget: { taskUsd: 2, monthUsd: 60 },
  roles: [
    {
      key: "planner",
      name: "Planner",
      description: "Breaks a theme into separate pieces and sums up the result.",
      instructions: "You plan content. When asked for a list, give one item per line and nothing else: no numbers, no bullets, no preamble.",
      effort: "medium",
    },
    {
      key: "writer",
      name: "Writer",
      description: "Writes one post.",
      instructions: "You write short, specific posts. One idea per post, a concrete example, no filler and no hashtags unless asked.",
      effort: "high",
    },
  ],
  taskTypes: [
    {
      key: "campaign",
      name: "Campaign",
      description: "Plan a set of posts on a theme and write them all.",
      inputFields: [
        { key: "theme", label: "Theme", type: "text", required: true, placeholder: "What is the campaign about?" },
        { key: "audience", label: "Audience", type: "text", required: false, placeholder: "Who is it for?" },
      ],
      workflow: {
        version: 1,
        output: "overview",
        steps: [
          {
            key: "plan",
            kind: "role",
            role: "planner",
            maxTokens: 400,
            prompt: "Theme: {{input.theme}}\nAudience: {{input.audience}}\n\nList three post topics for this theme, one per line.",
          },
          {
            key: "posts",
            kind: "workspace",
            workspace: "self",
            taskType: "post",
            inputs: { topic: "{{loop.item}}", audience: "{{input.audience}}" },
            repeat: { mode: "each", items: "{{steps.plan.output}}", max: 5, parallel: 3 },
          },
          {
            key: "overview",
            kind: "role",
            role: "planner",
            maxTokens: 3000,
            prompt: "These posts were written for the theme \"{{input.theme}}\":\n{{steps.posts.output}}\n\nGive each post a title and print them in order, then add a two-sentence overview of the set.",
          },
          { key: "review", kind: "approval", title: "Approve the campaign", show: "{{steps.overview.output}}", revises: ["overview"] },
        ],
      },
    },
    {
      key: "post",
      name: "Post",
      description: "Write one post on a topic.",
      inputFields: [
        { key: "topic", label: "Topic", type: "text", required: true },
        { key: "audience", label: "Audience", type: "text", required: false },
      ],
      workflow: {
        version: 1,
        output: "write",
        steps: [{ key: "write", kind: "role", role: "writer", maxTokens: 1200, prompt: "Write a post on: {{input.topic}}\nAudience: {{input.audience}}" }],
      },
    },
  ],
});

export const builtInTemplates: WorkspaceTemplate[] = [researchBrief, supportTriage, fieldResearch, contentDesk];

export function findTemplate(key: string): WorkspaceTemplate | undefined {
  return builtInTemplates.find((t) => t.key === key);
}

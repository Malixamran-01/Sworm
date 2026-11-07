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

export const builtInTemplates: WorkspaceTemplate[] = [researchBrief];

export function findTemplate(key: string): WorkspaceTemplate | undefined {
  return builtInTemplates.find((t) => t.key === key);
}

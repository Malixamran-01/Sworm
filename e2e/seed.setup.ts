import { expect, test as setup } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { SAMPLE_SIDECAR } from "./server";

/**
 * Seeds a fresh instance: an owner (random password, never printed), the mock
 * model, two workspaces, and one task waiting at its approval, so every screen
 * has real content to check.
 */
setup("seed an owner, workspaces and a waiting task", async ({ request, baseURL }) => {
  const headers = { "x-requested-with": "conclave" };
  const password = randomBytes(18).toString("base64url");
  const setupRes = await request.post("/v1/auth/setup", { headers, data: { name: "Ada Lovelace", email: "ada@e2e.test", password, orgName: "E2E Labs" } });
  expect(setupRes.ok()).toBeTruthy();

  const conn = await (await request.post("/v1/connections", { headers, data: { moduleId: "conclave/mock-model", name: "Mock model", values: {} } })).json();
  const ws = await (
    await request.post("/v1/workspaces", { headers, data: { templateKey: "research-brief", defaultNode: { connectionId: conn.id, model: "mock-small" } } })
  ).json();
  await request.post("/v1/workspaces", { headers, data: { answers: { goal: "write", check: true }, name: "Writing desk" } });
  const task = await (
    await request.post(`/v1/workspaces/${ws.id}/tasks`, { headers, data: { taskTypeId: ws.taskTypes[0].id, brief: { topic: "Heat pumps for small offices" } } })
  ).json();

  // Wait until the task reaches its approval step.
  await expect
    .poll(async () => (await (await request.get(`/v1/tasks/${task.id}`)).json()).status, { timeout: 30_000 })
    .toBe("waiting");

  // Agent and Workflow ports (SRS 4.11): the sample agent as a sidecar, and a task where it asks a question.
  const agent = await (
    await request.post("/v1/connections", { headers, data: { moduleId: "conclave/sidecar", name: "Sample agent", values: { command: SAMPLE_SIDECAR, settings: '{"stepMs": 20}' } } })
  ).json();
  const outside = await (await request.post("/v1/workspaces", { headers, data: { blank: true, name: "Outside help", defaultNode: { connectionId: conn.id, model: "mock-small" } } })).json();
  await request.post(`/v1/workspaces/${outside.id}/roles`, { headers, data: { key: "researcher", name: "Researcher", port: "agent@1" } });
  await request.post(`/v1/workspaces/${outside.id}/roles`, { headers, data: { key: "counter", name: "Counter", port: "workflow@1" } });
  await request.put(`/v1/workspaces/${outside.id}/roles/researcher`, { headers, data: { connectionId: agent.id, model: "interview" } });
  await request.put(`/v1/workspaces/${outside.id}/roles/counter`, { headers, data: { connectionId: agent.id, model: "slow-count" } });
  const saved = await request.post(`/v1/workspaces/${outside.id}/task-types`, {
    headers,
    data: {
      key: "field-brief",
      name: "Field brief",
      inputFields: [{ key: "request", label: "Request", type: "longtext", required: true }],
      workflow: {
        version: 1,
        steps: [
          { kind: "agent", key: "research", role: "researcher", prompt: "Research {{input.request}}.", timeoutMs: 1_800_000 },
          { kind: "automation", key: "count", role: "counter", inputs: { text: "{{steps.research.output}}" }, needs: ["research"], timeoutMs: 600_000 },
        ],
      },
    },
  });
  expect(saved.ok()).toBeTruthy();
  const fieldBrief = (await saved.json()).taskTypes.find((t: { key: string }) => t.key === "field-brief");
  const asking = await (await request.post(`/v1/workspaces/${outside.id}/tasks`, { headers, data: { taskTypeId: fieldBrief.id, brief: { request: "Tidal energy" } } })).json();
  await expect
    .poll(async () => !!(await (await request.get(`/v1/tasks/${asking.id}`)).json()).steps?.[0]?.question, { timeout: 30_000 })
    .toBe(true);

  mkdirSync("e2e/.auth", { recursive: true });
  const state = await request.storageState();
  writeFileSync("e2e/.auth/owner.json", JSON.stringify(state));
  writeFileSync("e2e/.auth/owner-dark.json", JSON.stringify({ ...state, origins: [{ origin: baseURL!, localStorage: [{ name: "conclave.theme", value: "dark" }] }] }));
  writeFileSync("e2e/.auth/ids.json", JSON.stringify({ workspaceId: ws.id, taskId: task.id, outsideId: outside.id, askingTaskId: asking.id }));
});

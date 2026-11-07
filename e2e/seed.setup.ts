import { expect, test as setup } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

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

  mkdirSync("e2e/.auth", { recursive: true });
  const state = await request.storageState();
  writeFileSync("e2e/.auth/owner.json", JSON.stringify(state));
  writeFileSync("e2e/.auth/owner-dark.json", JSON.stringify({ ...state, origins: [{ origin: baseURL!, localStorage: [{ name: "conclave.theme", value: "dark" }] }] }));
  writeFileSync("e2e/.auth/ids.json", JSON.stringify({ workspaceId: ws.id, taskId: task.id }));
});

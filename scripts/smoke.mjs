#!/usr/bin/env node
// End-to-end smoke test against a running instance (the Phase 1 gate path):
// set up the owner, connect the mock model, create a Research Brief workspace,
// run a task, approve it, and check the result.
//   node scripts/smoke.mjs http://127.0.0.1:8787
const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const email = process.env.SMOKE_EMAIL ?? "smoke@example.com";
const password = process.env.SMOKE_PASSWORD ?? "smoke-test-password";
let cookie = "";

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), "x-requested-with": "conclave", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

const step = (msg) => console.log(`- ${msg}`);
const started = Date.now();

const state = await call("GET", "/v1/auth/state");
if (state.setupRequired) {
  await call("POST", "/v1/auth/setup", { name: "Smoke", email, password, ...(process.env.SETUP_CODE ? { setupCode: process.env.SETUP_CODE } : {}) });
  step("owner account created");
} else {
  await call("POST", "/v1/auth/sign-in", { email, password });
  step("signed in");
}

const conn = await call("POST", "/v1/connections", { moduleId: "conclave/mock-model", name: "Smoke mock", values: {} });
const test = await call("POST", `/v1/connections/${conn.id}/test`);
if (!test.ok) throw new Error(`connection test failed: ${test.detail}`);
step("mock model connected");

const ws = await call("POST", "/v1/workspaces", { templateKey: "research-brief", name: `Smoke ${Date.now()}`, defaultNode: { connectionId: conn.id, model: "mock-small" } });
const run = await call("POST", `/v1/workspaces/${ws.id}/tasks`, { taskTypeId: ws.taskTypes[0].id, brief: { topic: "Smoke test topic" } });
step(`task started (${run.id})`);

async function waitFor(status) {
  for (let i = 0; i < 120; i++) {
    const r = await call("GET", `/v1/tasks/${run.id}`);
    if (r.status === status) return r;
    if (["failed", "cancelled"].includes(r.status)) throw new Error(`task ${r.status}: ${r.error}`);
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`task did not reach ${status}`);
}

await waitFor("waiting");
const inbox = await call("GET", "/v1/inbox?kind=approval");
const item = inbox.find((i) => i.runId === run.id && !i.resolved);
await call("POST", `/v1/approvals/${item.approvalId}`, { decision: "approve" });
step("approved");
const done = await waitFor("succeeded");
if (!done.output) throw new Error("the finished task has no output");
step(`finished: $${done.costUsd.toFixed(4)}, ${done.steps.length} steps, ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log("SMOKE OK");

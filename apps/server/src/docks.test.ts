import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addTarget, pair, runBridge } from "@conclave/bridge";
import type { ConnectionDto, ConnectionTestDto, RunDetailDto, WorkspaceDetailDto } from "@conclave/contract";
import { createConclave, remoteSigningKey, SecretVault, type Conclave } from "@conclave/core";
import { createTestDb } from "@conclave/db";
import mockModel from "@conclave/module-mock-model";
import { remoteDock } from "@conclave/module-remote-dock";
import sample from "@conclave/module-sample-agent";
import { ed25519Signer, serveHttp } from "@conclave/module-sdk";
import { sidecarDock } from "@conclave/module-sidecar-dock";
import webhookWorkflow from "@conclave/module-webhook-workflow";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { BridgeHub, bridgeDock } from "./bridge";

/**
 * Agent and Workflow ports through every dock, end to end over the real API
 * (SRS 4.11, 5.2, 8.8): the sample module, built only with the public SDK,
 * served remotely, as a sidecar, and through the Local Bridge.
 */

const PASSWORD = "correct horse battery";
const SECRET = "dock-test-secret-0123456789-abcdefghij";
const serveScript = fileURLToPath(new URL("../../../modules/sample-agent/src/serve.ts", import.meta.url));
const SIDECAR = `"${process.execPath}" --import tsx "${serveScript}" --stdio`;

let conclave: Conclave;
let app: FastifyInstance;
let base = "";
let cookie = "";
let serverKey = "";
const cleanup: (() => Promise<void> | void)[] = [];

beforeEach(async () => {
  const db = await createTestDb();
  const hub = new BridgeHub();
  const masterKey = SecretVault.generateMasterKey();
  serverKey = ed25519Signer(remoteSigningKey(masterKey)).publicKey;
  // The URL is known only once the app listens; callbacks need it, so it is set after.
  conclave = await createConclave({
    db,
    modules: [mockModel, remoteDock({ signer: ed25519Signer(remoteSigningKey(masterKey)) }), webhookWorkflow, sidecarDock({ allowed: [SIDECAR] }), bridgeDock(hub)],
    masterKey,
    orchestrator: { externalCheckMs: 500 },
  });
  await conclave.bootstrapOwner();
  app = await buildApp({ conclave, bridge: hub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  (conclave.orchestrator as unknown as { opts: { publicUrl: string } }).opts.publicUrl = base;
  conclave.startBackground({ pollMs: 20, healthCheckMs: 0 });
  const res = await app.inject({ method: "POST", url: "/v1/auth/setup", payload: { name: "Ada", email: "ada@example.com", password: PASSWORD, orgName: "Ada Co" } });
  cookie = String([res.headers["set-cookie"]].flat()[0]).split(";")[0]!;
});

afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  await conclave.stop();
  await app.close();
  await conclave.db.close();
});

async function api<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown) {
  const res = await app.inject({ method, url, headers: { cookie, "x-requested-with": "conclave" }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T };
}

/** A workspace whose one task hands the request to the role "outside", filled by the connection. */
async function workspace(connectionId: string, port: "agent@1" | "workflow@1", pick: string) {
  const mock = await api<{ id: string }>("POST", "/v1/connections", { moduleId: "conclave/mock-model", name: "Mock", values: {} });
  const ws = (await api<WorkspaceDetailDto>("POST", "/v1/workspaces", { blank: true, name: "Docked", defaultNode: { connectionId: mock.body.id, model: "mock-small" } })).body;
  expect((await api("POST", `/v1/workspaces/${ws.id}/roles`, { key: "outside", name: "Outside", port })).status).toBe(201);
  expect((await api("PUT", `/v1/workspaces/${ws.id}/roles/outside`, { connectionId, model: pick })).status).toBe(200);
  const step =
    port === "agent@1"
      ? { kind: "agent", key: "work", role: "outside", prompt: "Brief me on {{input.request}}. It matters.", timeoutMs: 120_000 }
      : { kind: "automation", key: "work", role: "outside", inputs: { text: "{{input.request}}" }, timeoutMs: 120_000 };
  const saved = await api<WorkspaceDetailDto>("POST", `/v1/workspaces/${ws.id}/task-types`, {
    key: "job",
    name: "Job",
    inputFields: [{ key: "request", label: "Request", type: "text", required: true }],
    workflow: { version: 1, steps: [step] },
  });
  expect(saved.status).toBe(201);
  return { ws, taskTypeId: saved.body.taskTypes.find((t) => t.key === "job")!.id };
}

async function waitFor(runId: string, ok: (r: RunDetailDto) => boolean, ms = 20_000): Promise<RunDetailDto> {
  const until = Date.now() + ms;
  for (;;) {
    const run = (await api<RunDetailDto>("GET", `/v1/tasks/${runId}`)).body;
    if (ok(run)) return run;
    if (Date.now() > until) throw new Error(`Task stuck at ${run.status}: ${JSON.stringify(run.steps.map((s) => [s.key, s.status, s.error, s.progress]))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function start(wsId: string, taskTypeId: string, request: string) {
  const res = await api<RunDetailDto>("POST", `/v1/workspaces/${wsId}/tasks`, { taskTypeId, brief: { request } });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe("remote dock", () => {
  it("finds the module's ports, runs its agent, and passes a question through the inbox", async () => {
    const served = await serveHttp(sample, { secret: SECRET, config: { stepMs: 10 } });
    cleanup.push(served.close);
    const conn = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/remote", name: "Agents server", values: { url: served.url, secret: SECRET } })).body;
    expect(conn.dock).toBe("remote");

    const test = (await api<ConnectionTestDto>("POST", `/v1/connections/${conn.id}/test`)).body;
    expect(test).toMatchObject({ ok: true, status: "working" });
    expect(test.detail).toMatch(/^Sample agent 1\.0\.0: Ready\./);
    const after = (await api<ConnectionDto>("GET", `/v1/connections/${conn.id}`)).body;
    expect(after.ports).toEqual(["agent@1", "workflow@1"]);
    expect(after.docked).toMatchObject({ id: "conclave/sample-agent", version: "1.0.0" });
    expect((await api<{ id: string }[]>("GET", `/v1/connections/${conn.id}/skills`)).body.map((s) => s.id)).toEqual(["brief", "interview"]);

    const { ws, taskTypeId } = await workspace(conn.id, "agent@1", "interview");
    const runId = await start(ws.id, taskTypeId, "tides");
    let run = await waitFor(runId, (r) => !!r.steps[0]?.question);
    expect(run.status).toBe("waiting");
    expect(run.steps[0]!.progress).toEqual(["Reading the request", "Outlining", "Deciding what to ask"]);

    const answered = await api<RunDetailDto>("POST", `/v1/approvals/${run.steps[0]!.question!.approvalId}`, { decision: "approve", note: "spring tides" });
    expect(answered.status).toBe(200);
    run = await waitFor(runId, (r) => r.status === "succeeded");
    expect(run.output).toMatch(/^Focus: spring tides\n\nIn one line: Brief me on tides\./);
  });

  it("needs no shared secret when the module is given this server's public key", async () => {
    const served = await serveHttp(sample, { hostKeys: [serverKey], config: { stepMs: 10 } });
    cleanup.push(served.close);
    // The form tells the person which key to give the module.
    const mods = (await api<{ id: string; configFields: { key: string; help?: string; required: boolean }[] }[]>("GET", "/v1/modules")).body;
    const secretField = mods.find((m) => m.id === "conclave/remote")!.configFields.find((f) => f.key === "secret")!;
    expect(secretField.required).toBe(false);
    expect(secretField.help).toContain(serverKey);

    const conn = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/remote", name: "Keyed", values: { url: served.url, moduleKey: served.publicKey } })).body;
    expect(conn.secretKeys).toEqual([]);
    expect((await api<ConnectionTestDto>("POST", `/v1/connections/${conn.id}/test`)).body).toMatchObject({ ok: true, status: "working" });
    const { ws, taskTypeId } = await workspace(conn.id, "agent@1", "brief");
    const run = await waitFor(await start(ws.id, taskTypeId, "tides"), (r) => r.status === "succeeded");
    expect(run.output).toMatch(/^Brief/);

    // A module that was given some other server's key refuses this one.
    const other = await serveHttp(sample, { hostKeys: [ed25519Signer(remoteSigningKey(SecretVault.generateMasterKey())).publicKey] });
    cleanup.push(other.close);
    const refused = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/remote", name: "Stranger", values: { url: other.url } })).body;
    expect((await api<ConnectionTestDto>("POST", `/v1/connections/${refused.id}/test`)).body).toMatchObject({ ok: false, status: "signed_out" });
  });

  it("reports a wrong secret as signed out", async () => {
    const served = await serveHttp(sample, { secret: SECRET });
    cleanup.push(served.close);
    const conn = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/remote", name: "Wrong", values: { url: served.url, secret: `${SECRET}-nope` } })).body;
    const test = (await api<ConnectionTestDto>("POST", `/v1/connections/${conn.id}/test`)).body;
    expect(test).toMatchObject({ ok: false, status: "signed_out" });
  });
});

describe("sidecar dock", () => {
  it("starts the module process and runs a polled workflow through it", async () => {
    const conn = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/sidecar", name: "Counter", values: { command: SIDECAR, settings: '{"stepMs": 10}' } })).body;
    expect(conn.dock).toBe("sidecar");
    expect((await api<ConnectionTestDto>("POST", `/v1/connections/${conn.id}/test`)).body).toMatchObject({ ok: true });
    const { ws, taskTypeId } = await workspace(conn.id, "workflow@1", "slow-count");
    const runId = await start(ws.id, taskTypeId, "one two three four");
    const run = await waitFor(runId, (r) => r.status === "succeeded");
    expect(JSON.parse(run.output!)).toEqual({ words: 4 });
  }, 60_000);

  it("refuses a command the server admin has not allowed", async () => {
    const conn = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/sidecar", name: "Other", values: { command: "node -e 1" } })).body;
    const test = (await api<ConnectionTestDto>("POST", `/v1/connections/${conn.id}/test`)).body;
    expect(test.ok).toBe(false);
    expect(test.detail).toMatch(/not on the server's list of allowed sidecars/);
  });
});

describe("webhook workflow", () => {
  let hook: Server;
  let hookUrl = "";
  const received: { body: Record<string, unknown>; signature: string | undefined }[] = [];
  beforeEach(async () => {
    received.length = 0;
    hook = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        received.push({ body, signature: req.headers["x-conclave-signature"] as string | undefined });
        res.writeHead(200, { "content-type": "application/json" });
        if (body.callbackUrl) {
          res.end(JSON.stringify({ ok: true }));
          // The workflow finishes later and posts its result back.
          setTimeout(() => void fetch(String(body.callbackUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Lead saved" }) }), 50);
        } else res.end(JSON.stringify({ data: { saved: (body.input as { text: string }).text } }));
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const addr = hook.address();
    hookUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/hook`;
    cleanup.push(() => new Promise<void>((r) => hook.close(() => r())));
  });

  it("uses the webhook's response as the result, and signs the request", async () => {
    const conn = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/webhook-workflow", name: "Hook", values: { url: hookUrl, secret: "s3cret" } })).body;
    const { ws, taskTypeId } = await workspace(conn.id, "workflow@1", "webhook");
    const run = await waitFor(await start(ws.id, taskTypeId, "Ada Lovelace"), (r) => r.status === "succeeded");
    expect(JSON.parse(run.output!)).toEqual({ saved: "Ada Lovelace" });
    expect(received[0]!.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("takes the result from the callback URL in callback mode", async () => {
    const conn = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/webhook-workflow", name: "Hook", values: { url: hookUrl, mode: "callback" } })).body;
    const { ws, taskTypeId } = await workspace(conn.id, "workflow@1", "webhook");
    const run = await waitFor(await start(ws.id, taskTypeId, "x"), (r) => r.status === "succeeded");
    expect(run.output).toBe("Lead saved");
    expect(String(received[0]!.body.callbackUrl)).toMatch(new RegExp(`^${base}/v1/hooks/runs/`));
    // Spent once the step is done.
    const again = await fetch(String(received[0]!.body.callbackUrl), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(again.status).toBe(404);
  });
});

describe("Local Bridge", () => {
  it("pairs with a code and a confirmation, then runs an agent on the paired computer", async () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    let shown = "";
    let confirmedWho = "";
    const paired = pair(base, "Ada's laptop", {
      home,
      pollMs: 50,
      showCode: (code) => (shown = code),
      confirm: async (who) => ((confirmedWho = `${who.name} ${who.email} ${who.org}`), true),
    });
    while (!shown) await new Promise((r) => setTimeout(r, 20));
    expect(shown).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await api("POST", "/v1/bridge/claim", { code: "WRONG-CODE" })).status).toBe(422);
    expect((await api("POST", "/v1/bridge/claim", { code: shown.toLowerCase() })).status).toBe(200);
    const device = await paired;
    expect(confirmedWho).toBe("Ada ada@example.com Ada Co");
    // The person is told about the new device.
    const inbox = (await api<{ title: string }[]>("GET", "/v1/inbox")).body;
    expect(inbox.map((i) => i.title)).toContain("New device paired: Ada's laptop");

    // Nothing is reachable until a target is added on the computer.
    const conn = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/bridge", name: "Laptop agent", values: { device: "Ada's laptop", target: "sample" } })).body;
    const controller = new AbortController();
    let ready = false;
    // The bridge stops with a reason when the server drops the device; that is checked below.
    const running = runBridge({ home, signal: controller.signal, log: () => {}, onReady: () => (ready = true) }).then(
      () => null,
      (err: Error) => err,
    );
    cleanup.push(async () => {
      controller.abort();
      await running;
    });
    while (!ready) await new Promise((r) => setTimeout(r, 20));
    let test = (await api<ConnectionTestDto>("POST", `/v1/connections/${conn.id}/test`)).body;
    expect(test.ok).toBe(false);
    expect(test.detail).toMatch(/no target called "sample"/);

    addTarget({ name: "sample", kind: "stdio", command: SIDECAR, egress: [] }, home);
    test = (await api<ConnectionTestDto>("POST", `/v1/connections/${conn.id}/test`)).body;
    expect(test).toMatchObject({ ok: true });
    const devices = (await api<{ name: string; online: boolean; targets: unknown[] }[]>("GET", "/v1/devices")).body;
    expect(devices[0]).toMatchObject({ name: "Ada's laptop", online: true });

    const { ws, taskTypeId } = await workspace(conn.id, "agent@1", "brief");
    const run = await waitFor(await start(ws.id, taskTypeId, "harbours"), (r) => r.status === "succeeded", 40_000);
    expect(run.output).toMatch(/^Brief\n\nIn one line: Brief me on harbours\./);
    expect(readFileSync(join(home, "activity.log"), "utf8")).toMatch(/sample agent\.startRun/);

    // Removing the device cuts it off at once.
    expect((await api("DELETE", `/v1/devices/${device.deviceId}`)).status).toBe(204);
    test = (await api<ConnectionTestDto>("POST", `/v1/connections/${conn.id}/test`)).body;
    expect(test.ok).toBe(false);
    // The bridge is told it was removed, and stops for good instead of reconnecting.
    expect(((await running) as Error | null)?.message).toBe("This device was removed.");
  }, 90_000);

  it("refuses calls not signed by the server it paired with", async () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    let shown = "";
    const paired = pair(base, "Desk", { home, pollMs: 50, showCode: (c) => (shown = c), confirm: async () => true });
    while (!shown) await new Promise((r) => setTimeout(r, 20));
    await api("POST", "/v1/bridge/claim", { code: shown });
    await paired;
    addTarget({ name: "sample", kind: "stdio", command: SIDECAR, egress: [] }, home);
    // Pretend the device pinned some other server's key.
    const file = join(home, "device.json");
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), serverKey: other }));

    const controller = new AbortController();
    let ready = false;
    // The bridge stops with a reason when the server drops the device; that is checked below.
    const running = runBridge({ home, signal: controller.signal, log: () => {}, onReady: () => (ready = true) }).then(
      () => null,
      (err: Error) => err,
    );
    cleanup.push(async () => {
      controller.abort();
      await running;
    });
    while (!ready) await new Promise((r) => setTimeout(r, 20));
    const conn = (await api<ConnectionDto>("POST", "/v1/connections", { moduleId: "conclave/bridge", name: "Desk agent", values: { device: "Desk", target: "sample" } })).body;
    const test = (await api<ConnectionTestDto>("POST", `/v1/connections/${conn.id}/test`)).body;
    expect(test.ok).toBe(false);
    expect(test.detail).toMatch(/not signed by the server this computer paired with/);
  }, 60_000);
});

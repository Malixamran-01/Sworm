import { generateKeyPairSync, sign } from "node:crypto";
import type { RunDetailDto, ServerMessage, WorkspaceDetailDto } from "@conclave/contract";
import { createConclave, SecretVault, type Conclave } from "@conclave/core";
import { createTestDb } from "@conclave/db";
import mockModel from "@conclave/module-mock-model";
import openaiCompatible from "@conclave/module-openai-compatible";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "./app";
import { IdentityProviders } from "./auth/oidc";

let conclave: Conclave;
let app: FastifyInstance;
let ownerCookie = "";

const PASSWORD = "correct horse battery";

async function boot(extra: Partial<AppOptions> = {}) {
  const db = await createTestDb();
  conclave = await createConclave({ db, modules: [mockModel, openaiCompatible], masterKey: SecretVault.generateMasterKey() });
  await conclave.bootstrapOwner();
  app = await buildApp({ conclave, ...extra });
  const res = await app.inject({ method: "POST", url: "/v1/auth/setup", payload: { name: "Ada", email: "ada@example.com", password: PASSWORD, orgName: "Ada Co" } });
  expect(res.statusCode).toBe(200);
  ownerCookie = cookieFrom(res.headers["set-cookie"]);
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app.close();
  await conclave.stop();
  await conclave.db.close();
});

function cookieFrom(header: string | string[] | undefined): string {
  const line = [header ?? []].flat()[0] ?? "";
  return line.split(";")[0] ?? "";
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
async function api<T>(method: Method, url: string, body?: unknown, auth: { cookie?: string; bearer?: string; csrf?: boolean } = { cookie: "owner" }) {
  const headers: Record<string, string> = {};
  if (auth.cookie) headers.cookie = auth.cookie === "owner" ? ownerCookie : auth.cookie;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.csrf !== false) headers["x-requested-with"] = "conclave";
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T, headers: res.headers };
}

async function setupWorkspace() {
  const conn = await api<{ id: string }>("POST", "/v1/connections", { moduleId: "conclave/mock-model", name: "Mock", values: {} });
  const ws = await api<WorkspaceDetailDto>("POST", "/v1/workspaces", { templateKey: "research-brief", defaultNode: { connectionId: conn.body.id, model: "mock-small" } });
  return ws.body;
}

async function invite(role: "editor" | "runner" | "viewer", email: string) {
  const created = await api<{ link: string }>("POST", "/v1/org/invites", { email, role });
  const token = created.body.link.split("/invite/")[1]!;
  const res = await app.inject({ method: "POST", url: `/v1/auth/invites/${token}/accept`, payload: { name: email.split("@")[0], email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return cookieFrom(res.headers["set-cookie"]);
}

const advance = async () => {
  const worker = conclave.engine.startWorker(conclave.orchestrator.advance, { autoStart: false });
  await worker.drain();
  await worker.stop();
  await conclave.relay.drain();
};

describe("Access control (ACC-005)", () => {
  it("gives every API route an access rule", () => {
    const missing = app.routeTable.filter((r) => r.url.startsWith("/v1/") && r.method !== "HEAD" && !r.guard).map((r) => `${r.method} ${r.url}`);
    expect(missing).toEqual([]);
    expect(app.routeTable.filter((r) => r.url.startsWith("/v1/")).length).toBeGreaterThan(30);
  });

  it("requires a session or token, and the CSRF header for browser writes", async () => {
    expect((await api("GET", "/v1/health", undefined, {})).status).toBe(200);
    expect((await api("GET", "/v1/workspaces", undefined, {})).status).toBe(401);
    expect((await api("GET", "/v1/workspaces")).status).toBe(200);
    const noHeader = await api("POST", "/v1/workspaces", { templateKey: "research-brief" }, { cookie: "owner", csrf: false });
    expect(noHeader.status).toBe(403);
  });

  it("lets each role do exactly what it may", async () => {
    const ws = await setupWorkspace();
    const viewer = await invite("viewer", "vic@example.com");
    const runner = await invite("runner", "rui@example.com");
    const body = { taskTypeId: ws.taskTypes[0]!.id, brief: { topic: "Roles" } };

    expect((await api("GET", `/v1/workspaces/${ws.id}`, undefined, { cookie: viewer })).status).toBe(200);
    expect((await api("POST", `/v1/workspaces/${ws.id}/tasks`, body, { cookie: viewer })).status).toBe(403);
    expect((await api("POST", "/v1/connections", { moduleId: "conclave/mock-model", name: "x", values: {} }, { cookie: runner })).status).toBe(403);
    expect((await api("POST", "/v1/org/invites", { role: "viewer" }, { cookie: runner })).status).toBe(403);
    const started = await api<RunDetailDto>("POST", `/v1/workspaces/${ws.id}/tasks`, body, { cookie: runner });
    expect(started.status).toBe(201);
    expect((await api("POST", `/v1/tasks/${started.body.id}/cancel`, undefined, { cookie: viewer })).status).toBe(403);
    expect((await api("POST", `/v1/tasks/${started.body.id}/cancel`, undefined, { cookie: runner })).status).toBe(200);
  });

  it("hides personal workspaces from other members", async () => {
    const editor = await invite("editor", "eda@example.com");
    const mine = await api<WorkspaceDetailDto>("POST", "/v1/workspaces", { templateKey: "research-brief", name: "Private", private: true });
    expect((await api("GET", `/v1/workspaces/${mine.body.id}`, undefined, { cookie: editor })).status).toBe(404);
    const list = await api<{ name: string }[]>("GET", "/v1/workspaces", undefined, { cookie: editor });
    expect(list.body.map((w) => w.name)).not.toContain("Private");
  });

  it("limits access tokens to their scopes, without the CSRF header", async () => {
    const ws = await setupWorkspace();
    const made = await api<{ token: string }>("POST", "/v1/tokens", { name: "Read only", scopes: ["workspace:read"] });
    expect(made.status).toBe(201);
    const bearer = made.body.token;
    expect((await api("GET", "/v1/workspaces", undefined, { bearer, csrf: false })).status).toBe(200);
    const run = await api("POST", `/v1/workspaces/${ws.id}/tasks`, { taskTypeId: ws.taskTypes[0]!.id, brief: { topic: "x" } }, { bearer, csrf: false });
    expect(run.status).toBe(403);
    expect((await api("GET", "/v1/workspaces", undefined, { bearer: "cnc_wrong", csrf: false })).status).toBe(401);
  });
});

describe("Sign-in", () => {
  it("signs in and out, and rate-limits guessing", async () => {
    const ok = await app.inject({ method: "POST", url: "/v1/auth/sign-in", payload: { email: "ada@example.com", password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieFrom(ok.headers["set-cookie"]);
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/i);
    expect((await api("GET", "/v1/me", undefined, { cookie })).body).toMatchObject({ user: { email: "ada@example.com" }, role: "owner" });
    await api("POST", "/v1/auth/sign-out", undefined, { cookie });
    expect((await api("GET", "/v1/me", undefined, { cookie })).status).toBe(401);

    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await app.inject({ method: "POST", url: "/v1/auth/sign-in", payload: { email: "ada@example.com", password: "wrong wrong wrong" } })).statusCode;
    }
    expect(last).toBe(429);
  });

  it("asks for the setup code on a public instance", async () => {
    await app.close();
    await conclave.stop();
    await conclave.db.close();
    const db = await createTestDb();
    conclave = await createConclave({ db, modules: [mockModel], masterKey: SecretVault.generateMasterKey() });
    app = await buildApp({ conclave, setupCode: "424242" });
    const payload = { name: "Ada", email: "ada@example.com", password: PASSWORD };
    expect((await app.inject({ method: "POST", url: "/v1/auth/setup", payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/auth/setup", payload: { ...payload, setupCode: "424242" } })).statusCode).toBe(200);
  });

  it("signs in through an OIDC provider and checks the ID token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const issuer = "https://id.example.test";
    let nonce = "";
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
      if (url === `${issuer}/token`) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("code_verifier")).toBeTruthy();
        const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
        const head = enc({ alg: "RS256", kid: "k1" });
        const claims = enc({ iss: issuer, aud: "client-1", sub: "user-42", email: "gia@example.com", email_verified: true, name: "Gia", nonce, exp: Math.floor(Date.now() / 1000) + 300 });
        const sig = sign("sha256", Buffer.from(`${head}.${claims}`), privateKey).toString("base64url");
        return Response.json({ id_token: `${head}.${claims}.${sig}` });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const providers = new IdentityProviders([{ id: "test", name: "Test IdP", kind: "oidc", issuer, clientId: "client-1", clientSecret: "s" }], "http://localhost:8787", fake);
    await app.close();
    app = await buildApp({ conclave, providers });
    await api("POST", "/v1/org/invites", { email: "gia@example.com", role: "runner" });

    const state = await api<{ providers: { id: string }[] }>("GET", "/v1/auth/state", undefined, {});
    expect(state.body.providers).toEqual([{ id: "test", name: "Test IdP", startUrl: "/v1/auth/oidc/test/start" }]);

    const start = await app.inject({ method: "GET", url: "/v1/auth/oidc/test/start" });
    expect(start.statusCode).toBe(302);
    const authorize = new URL(String(start.headers.location));
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    nonce = authorize.searchParams.get("nonce")!;

    const back = await app.inject({ method: "GET", url: `/v1/auth/oidc/test/callback?code=abc&state=${authorize.searchParams.get("state")}` });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("/");
    const me = await api<{ user: { email: string }; role: string }>("GET", "/v1/me", undefined, { cookie: cookieFrom(back.headers["set-cookie"]) });
    expect(me.body).toMatchObject({ user: { email: "gia@example.com" }, role: "runner" });

    // A replayed state is refused.
    const replay = await app.inject({ method: "GET", url: `/v1/auth/oidc/test/callback?code=abc&state=${authorize.searchParams.get("state")}` });
    expect(String(replay.headers.location)).toMatch(/^\/sign-in\?error=/);
  });
});

describe("REST API", () => {
  it("runs a Research Brief task through the API", async () => {
    const ws = await setupWorkspace();
    const estimate = await api<{ confidence: string }>("POST", `/v1/workspaces/${ws.id}/estimate`, { taskTypeId: ws.taskTypes[0]!.id, brief: { topic: "x" } });
    expect(estimate.body.confidence).toBe("none");

    const started = await api<RunDetailDto>("POST", `/v1/workspaces/${ws.id}/tasks`, {
      taskTypeId: ws.taskTypes[0]!.id,
      brief: { topic: "Solar on warehouse roofs", audience: "Facilities leads" },
    });
    expect(started.status).toBe(201);
    await advance();

    const inbox = await api<{ approvalId: string }[]>("GET", "/v1/inbox?kind=approval");
    expect(inbox.body).toHaveLength(1);
    expect((await api("POST", `/v1/approvals/${inbox.body[0]!.approvalId}`, { decision: "approve" })).status).toBe(200);
    await advance();
    expect((await api<RunDetailDto>("GET", `/v1/tasks/${started.body.id}`)).body.status).toBe("succeeded");
  });

  it("returns problem details for invalid input", async () => {
    const ws = await setupWorkspace();
    const res = await api<{ errors: string[] }>("POST", `/v1/workspaces/${ws.id}/tasks`, { taskTypeId: ws.taskTypes[0]!.id, brief: {} });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body.errors).toContain("Topic is required.");
    expect((await api("GET", "/v1/tasks/018f0000-0000-7000-8000-000000000000")).status).toBe(404);
  });

  it("returns the same task for a repeated Idempotency-Key", async () => {
    const ws = await setupWorkspace();
    const body = { taskTypeId: ws.taskTypes[0]!.id, brief: { topic: "Once only" } };
    const send = () => app.inject({ method: "POST", url: `/v1/workspaces/${ws.id}/tasks`, payload: body, headers: { cookie: ownerCookie, "x-requested-with": "conclave", "idempotency-key": "abc" } });
    const a = JSON.parse((await send()).body);
    const b = JSON.parse((await send()).body);
    expect(b.id).toBe(a.id);
  });

  it("never returns saved secrets", async () => {
    const created = await api<{ id: string }>("POST", "/v1/connections", {
      moduleId: "conclave/openai-compatible",
      name: "Server",
      values: { baseUrl: "http://localhost:1234/v1", apiKey: "sk-never-show-me" },
    });
    expect(created.status).toBe(201);
    const all = JSON.stringify([(await api("GET", "/v1/connections")).body, (await api("GET", `/v1/connections/${created.body.id}`)).body]);
    expect(all).not.toContain("sk-never-show-me");
  });
});

describe("Realtime", () => {
  it("streams run events to a signed-in socket", async () => {
    const ws = await setupWorkspace();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as { port: number };
    const token = (await api<{ token: string }>("POST", "/v1/tokens", { name: "socket", scopes: ["workspace:read"] })).body.token;

    const anonymous = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`);
    const refused = await new Promise<boolean>((resolve) => {
      anonymous.addEventListener("error", () => resolve(true), { once: true });
      anonymous.addEventListener("open", () => resolve(false), { once: true });
    });
    expect(refused).toBe(true);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`, { headers: { authorization: `Bearer ${token}` } } as never);
    const messages: ServerMessage[] = [];
    socket.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "subscribe", topics: [`workspace:${ws.id}:runs`] }));
    await new Promise((r) => setTimeout(r, 100));

    await api("POST", `/v1/workspaces/${ws.id}/tasks`, { taskTypeId: ws.taskTypes[0]!.id, brief: { topic: "Live" } });
    await advance();
    await new Promise((r) => setTimeout(r, 200));
    socket.close();

    const events = messages.filter((m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event");
    expect(events.some((e) => e.envelope.event.type === "run.updated" && e.envelope.event.run.status === "waiting")).toBe(true);
  });
});

describe("Two-factor and notifications over HTTP (ACC-002, NOTE-003)", () => {
  it("gives no session cookie for a password alone once two-factor is on", async () => {
    const { base32Decode, totp } = await import("@conclave/core");
    const setup = await api<{ secret: string }>("POST", "/v1/me/totp/setup", {});
    const seed = base32Decode(setup.body.secret);
    expect((await api("POST", "/v1/me/totp/enable", { code: totp(seed, new Date()) })).status).toBe(200);

    const first = await app.inject({ method: "POST", url: "/v1/auth/sign-in", payload: { email: "ada@example.com", password: PASSWORD } });
    expect(first.statusCode).toBe(200);
    expect(first.headers["set-cookie"]).toBeUndefined();
    const { mfaRequired } = JSON.parse(first.body) as { mfaRequired: { ticket: string; methods: string[] } };
    expect(mfaRequired.methods).toContain("totp");

    const done = await app.inject({ method: "POST", url: "/v1/auth/mfa", payload: { ticket: mfaRequired.ticket, code: totp(seed, new Date(Date.now() + 30_000)) } });
    expect(done.statusCode).toBe(200);
    expect(cookieFrom(done.headers["set-cookie"])).toMatch(/^conclave_session=/);
  });

  it("does not let an access token change sign-in methods", async () => {
    const token = await api<{ token: string }>("POST", "/v1/tokens", { name: "script", scopes: ["workspace:read"] });
    const res = await api("POST", "/v1/me/totp/setup", {}, { bearer: token.body.token, csrf: false });
    expect(res.status).toBe(403);
  });

  it("serves notification settings and refuses pushes to hosts that are not push services", async () => {
    const s = await api<{ prefs: { desktop: boolean }; server: { pushPublicKey: string } }>("GET", "/v1/me/notifications");
    expect(s.body.prefs.desktop).toBe(true);
    expect(s.body.server.pushPublicKey.length).toBeGreaterThan(80);
    const bad = await api("POST", "/v1/me/push-subscriptions", { endpoint: "https://127.0.0.1/hook", keys: { p256dh: "x", auth: "y" } });
    expect(bad.status).toBe(422);
  });
});

describe("Editing workflows over HTTP (WF-007, WF-008)", () => {
  it("saves a workflow with a workspace step, lists call targets, and keeps runners out", async () => {
    const ws = await setupWorkspace();
    const targets = await api<{ workspaceId: string; taskTypes: { key: string }[] }[]>("GET", "/v1/call-targets");
    expect(targets.body.map((t) => t.workspaceId)).toContain(ws.id);

    const role = await api<WorkspaceDetailDto>("POST", `/v1/workspaces/${ws.id}/roles`, { name: "Second opinion", port: "model@1" });
    expect(role.status).toBe(201);
    expect(role.body.roles.map((r) => r.key)).toContain("second_opinion");

    const body = {
      key: "nested",
      name: "Nested",
      inputFields: [{ key: "topic", label: "Topic" }],
      workflow: {
        version: 1,
        steps: [
          { kind: "workspace", key: "brief", taskType: "research-brief", inputs: { topic: "{{input.topic}}" }, until: "draft" },
          { kind: "role", key: "check", role: "second_opinion", prompt: "Check {{steps.brief.output}}", needs: ["brief"] },
        ],
        layout: { brief: { x: 300, y: 40 } },
      },
    };
    const created = await api<WorkspaceDetailDto>("POST", `/v1/workspaces/${ws.id}/task-types`, body);
    expect(created.status).toBe(201);
    expect(created.body.taskTypes.find((t) => t.key === "nested")!.workflow.layout).toEqual({ brief: { x: 300, y: 40 } });

    // Problems come back as a list that names the step.
    const broken = await api<{ errors: string[] }>("PUT", `/v1/workspaces/${ws.id}/task-types/nested`, {
      ...body,
      workflow: { ...body.workflow, steps: [{ ...body.workflow.steps[1], needs: [] }] },
    });
    expect(broken.status).toBe(422);
    expect(broken.body.errors).toEqual(['check uses the output of "brief", which is not a step.']);

    const runner = await invite("runner", "run@example.com");
    expect((await api("PUT", `/v1/workspaces/${ws.id}/task-types/nested`, body, { cookie: runner })).status).toBe(403);
    expect((await api("DELETE", `/v1/workspaces/${ws.id}/task-types/nested`)).status).toBe(200);
  });
});

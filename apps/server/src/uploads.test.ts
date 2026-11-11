import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConclave, SecretVault, type Conclave, type Principal } from "@conclave/core";
import { createTestDb } from "@conclave/db";
import mockModel from "@conclave/module-mock-model";
import { testCallContext } from "@conclave/module-sdk/conformance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { ModuleUploads } from "./uploads";

/** A module as someone would upload it: one file, no imports, a default export. */
const source = (id: string, version = "1.0.0") => `
export default {
  manifest: {
    id: "${id}", version: "${version}", name: "Probe", description: "Looks around.",
    ports: ["tool@1"], docks: ["sidecar"],
    config: [{ key: "greeting", label: "Greeting", type: "string", default: "hello" }, { key: "token", label: "Token", type: "secret" }],
    permissions: { egress: ["allowed.test"], secrets: ["token"] },
  },
  create(ctx) {
    return {
      ports: {
        tool: {
          listTools: async () => [{ name: "probe", inputSchema: { type: "object" }, sensitive: false }],
          async call(name, args) {
            if (name === "env") return { data: { keys: Object.keys(process.env), pid: process.pid } };
            if (name === "fetch") return { data: { status: (await ctx.fetch(String(args.url))).status } };
            return { data: { said: ctx.config.greeting + " " + args.who, hasToken: !!ctx.secrets.token, version: "${version}" } };
          },
        },
      },
      health: async () => ({ status: "working", detail: "Ready." }),
    };
  },
};`;

let conclave: Conclave;
let owner: Principal;
let dir: string;
const fetched: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "conclave-uploads-"));
  fetched.length = 0;
  conclave = await createConclave({
    db: await createTestDb(),
    modules: [mockModel],
    masterKey: SecretVault.generateMasterKey(),
    fetch: (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response("ok", { status: 202 });
    }) as typeof fetch,
  });
  owner = { ...(await conclave.bootstrapOwner()), role: "owner", scopes: null, via: "session" };
});

afterEach(async () => {
  for (const c of await conclave.db.query<{ id: string }>(`select id from connections`)) conclave.connections.runtime.evict(c.id);
  await conclave.stop();
  await conclave.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("modules installed from the app (MOD-002)", () => {
  it("is off unless the server admin turns it on", async () => {
    const off = new ModuleUploads(conclave, dir, false);
    await expect(off.inspect(source("acme/probe"))).rejects.toMatchObject({ status: 403 });
    await expect(off.install(owner, source("acme/probe"))).rejects.toMatchObject({ status: 403 });
    const app = await buildApp({ conclave });
    const res = await app.inject({ method: "GET", url: "/v1/modules/uploads" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("shows what a file declares without installing it, and refuses what is not a module", async () => {
    const uploads = new ModuleUploads(conclave, dir, true);
    const seen = await uploads.inspect(source("acme/probe"));
    expect(seen).toMatchObject({ replaces: null, blocked: null, module: { id: "acme/probe", name: "Probe", ports: ["tool@1"], source: "installed", permissions: { egress: ["allowed.test"], secrets: ["token"] } } });
    expect(seen.module.configFields.map((f) => f.key)).toEqual(["greeting", "token"]);
    expect(conclave.registry.has("acme/probe")).toBe(false);
    expect(readdirSync(dir)).toEqual([]);

    await expect(uploads.inspect("export default { manifest: { id: 'Bad Id' }, create() {} }")).rejects.toMatchObject({ status: 422, detail: expect.stringContaining("manifest is not valid") });
    await expect(uploads.inspect("throw new Error('boom at load')")).rejects.toMatchObject({ status: 422, detail: expect.stringContaining("boom at load") });
    await expect(uploads.inspect("")).rejects.toMatchObject({ status: 422 });
    // A module cannot take the place of one the server ships with.
    expect((await uploads.inspect(source("conclave/mock-model"))).blocked).toMatch(/already ships with this server/);
    await expect(uploads.install(owner, source("conclave/mock-model"))).rejects.toMatchObject({ status: 409 });
  });

  it("runs an installed module in its own process, with its settings, a bare environment and only the hosts it declared", async () => {
    process.env.CONCLAVE_TEST_SERVER_SECRET = "must-not-leak";
    const uploads = new ModuleUploads(conclave, dir, true);
    const dto = await uploads.install(owner, source("acme/probe"));
    expect(dto).toMatchObject({ id: "acme/probe", source: "installed" });
    expect(conclave.registry.list().find((m) => m.id === "acme/probe")).toBeDefined();

    const conn = await conclave.connections.create(owner, { moduleId: "acme/probe", name: "Probe", values: { greeting: "hi", token: "t-1" } });
    expect(await conclave.connections.test(owner, conn.id)).toMatchObject({ ok: true, status: "working" });
    expect((await conclave.connections.tools(owner, conn.id)).map((t) => t.name)).toEqual(["probe"]);

    const { instance } = await conclave.connections.instance(owner, conn.id);
    const tool = instance.ports.tool!;
    expect(await tool.call("probe", { who: "Ada" }, testCallContext())).toEqual({ data: { said: "hi Ada", hasToken: true, version: "1.0.0" } });

    const env = (await tool.call("env", {}, testCallContext())).data as { keys: string[]; pid: number };
    expect(env.pid).not.toBe(process.pid);
    expect(env.keys).not.toContain("CONCLAVE_TEST_SERVER_SECRET");
    expect(env.keys.filter((k) => k.startsWith("CONCLAVE_"))).toEqual(["CONCLAVE_CMP"]);

    // Its network calls come back through the server's egress check.
    expect(await tool.call("fetch", { url: "https://allowed.test/x" }, testCallContext())).toEqual({ data: { status: 202 } });
    await expect(tool.call("fetch", { url: "https://elsewhere.test/x" }, testCallContext())).rejects.toThrow(/its manifest does not declare/);
    expect(fetched).toEqual(["https://allowed.test/x"]);
    delete process.env.CONCLAVE_TEST_SERVER_SECRET;

    const audit = await conclave.insights.audit(owner, { area: "module" });
    expect(audit.entries.map((e) => e.action)).toEqual(["module.installed"]);
  });

  it("replaces an earlier upload, keeps one in use, and comes back after a restart", async () => {
    const uploads = new ModuleUploads(conclave, dir, true);
    await uploads.install(owner, source("acme/probe"));
    const conn = await conclave.connections.create(owner, { moduleId: "acme/probe", name: "Probe", values: {} });
    const call = async () => ((await (await conclave.connections.instance(owner, conn.id)).instance.ports.tool!.call("probe", { who: "x" }, testCallContext())).data as { version: string }).version;
    expect(await call()).toBe("1.0.0");

    expect((await uploads.inspect(source("acme/probe", "1.1.0"))).replaces).toBe("1.0.0");
    await uploads.install(owner, source("acme/probe", "1.1.0"));
    expect(await call()).toBe("1.1.0");
    expect(await uploads.list()).toMatchObject([{ module: { id: "acme/probe", version: "1.1.0" }, connections: 1 }]);

    await expect(uploads.remove(owner, "acme/probe")).rejects.toMatchObject({ status: 409 });
    await expect(uploads.remove(owner, "conclave/mock-model")).rejects.toMatchObject({ status: 404 });

    // A new server process finds the file again.
    conclave.connections.runtime.evict(conn.id);
    conclave.registry.remove("acme/probe");
    const restarted = new ModuleUploads(conclave, dir, true);
    expect(await restarted.loadAll()).toEqual({ loaded: ["acme/probe"], problems: [] });
    expect(await call()).toBe("1.1.0");

    conclave.connections.runtime.evict(conn.id);
    await conclave.connections.remove(owner, conn.id);
    await restarted.remove(owner, "acme/probe");
    expect(conclave.registry.has("acme/probe")).toBe(false);
    expect(existsSync(join(dir, "acme__probe.mjs"))).toBe(false);
  });

  it("does not load earlier uploads when the feature has been turned off", async () => {
    await new ModuleUploads(conclave, dir, true).install(owner, source("acme/probe"));
    conclave.registry.remove("acme/probe");
    const off = new ModuleUploads(conclave, dir, false);
    expect(await off.loadAll()).toMatchObject({ loaded: [], problems: [{ file: "acme__probe.mjs" }] });
    expect(conclave.registry.has("acme/probe")).toBe(false);
  });
});

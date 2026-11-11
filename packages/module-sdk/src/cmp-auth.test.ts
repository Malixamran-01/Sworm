import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { cmpAudience, cmpInstance, defineModule, ed25519Signer, httpClient, serveHttp } from "./index";

const echo = defineModule({
  manifest: { id: "test/echo", version: "1.0.0", name: "Echo", ports: ["tool@1"], docks: ["remote"] },
  create: () => ({
    ports: { tool: { listTools: async () => [{ name: "echo", inputSchema: {} }], call: async (_n, args) => ({ data: args }) } },
    health: async () => ({ status: "working", detail: "Ready." }),
  }),
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const serve = async (opts: Parameters<typeof serveHttp>[1]) => {
  const served = await serveHttp(echo, opts);
  closers.push(served.close);
  return served;
};
const key = () => ed25519Signer(generateKeyPairSync("ed25519").privateKey);
const SECRET_A = "first-secret-0123456789-abcdefghijklmnop";
const SECRET_B = "second-secret-0123456789-abcdefghijklmno";

describe("key-signed requests to a remote module", () => {
  it("works with this server's key and no shared secret", async () => {
    const host = key();
    const served = await serve({ hostKeys: [host.publicKey] });
    const instance = cmpInstance(httpClient(served.url, { signer: host }));
    expect(await instance.health()).toEqual({ status: "working", detail: "Echo 1.0.0: Ready." });
    expect(await instance.ports.tool!.listTools()).toEqual([{ name: "echo", inputSchema: {} }]);
  });

  it("refuses a server whose key the module was not given", async () => {
    const served = await serve({ hostKeys: [key().publicKey] });
    await expect(httpClient(served.url, { signer: key() }).request("health", {})).rejects.toMatchObject({ code: "auth", message: expect.stringContaining("refused this server's key") });
  });

  it("accepts several server keys, so a server's key can be changed without a gap", async () => {
    const before = key();
    const after = key();
    const served = await serve({ hostKeys: [before.publicKey, after.publicKey] });
    await expect(httpClient(served.url, { signer: before }).request("health", {})).resolves.toMatchObject({ status: "working" });
    await expect(httpClient(served.url, { signer: after }).request("health", {})).resolves.toMatchObject({ status: "working" });
  });

  it("refuses a request that was signed for another module's address", async () => {
    const host = key();
    const served = await serve({ hostKeys: [host.publicKey], audience: "https://agents.example.com/cmp/" });
    // The module knows its public address; this request was made for the loopback one.
    await expect(httpClient(served.url, { signer: host }).request("health", {})).rejects.toMatchObject({ code: "auth" });
    expect(cmpAudience("https://agents.example.com/cmp/?x=1#y")).toBe("https://agents.example.com/cmp");
  });

  it("uses each request once: a copy sent again is refused", async () => {
    const host = key();
    const served = await serve({ hostKeys: [host.publicKey] });
    let captured: { url: string; init: RequestInit } | undefined;
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), init: init! };
      return fetch(input, init);
    }) as typeof fetch;
    await httpClient(served.url, { signer: host }, recording).request("health", {});
    const { signal: _signal, ...again } = captured!.init;
    const replay = await fetch(captured!.url, again);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "Replayed request" });
  });

  it("refuses an answer that was changed on the way, or signed by another key than the one pinned", async () => {
    const host = key();
    const served = await serve({ hostKeys: [host.publicKey] });
    const tampering = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(input, init);
      return new Response((await res.text()).replace("Ready.", "Hacked."), { status: res.status, headers: res.headers });
    }) as typeof fetch;
    await expect(httpClient(served.url, { signer: host }, tampering).request("health", {})).rejects.toMatchObject({ code: "auth", message: expect.stringContaining("not signed with its key") });

    await expect(httpClient(served.url, { signer: host, moduleKey: served.publicKey }).request("health", {})).resolves.toMatchObject({ status: "working" });
    await expect(httpClient(served.url, { signer: host, moduleKey: key().publicKey }).request("health", {})).rejects.toMatchObject({ code: "auth", message: expect.stringContaining("different key than the one pinned") });
  });
});

describe("shared secrets", () => {
  it("accepts the old and the new secret while one is being changed", async () => {
    const served = await serve({ secret: [SECRET_A, SECRET_B] });
    await expect(httpClient(served.url, SECRET_A).request("health", {})).resolves.toMatchObject({ status: "working" });
    await expect(httpClient(served.url, SECRET_B).request("health", {})).resolves.toMatchObject({ status: "working" });
    await expect(httpClient(served.url, `${SECRET_A}-wrong`).request("health", {})).rejects.toMatchObject({ code: "auth" });
  });

  it("serves both ways at once, and needs at least one", async () => {
    const host = key();
    const served = await serve({ secret: SECRET_A, hostKeys: [host.publicKey] });
    await expect(httpClient(served.url, SECRET_A).request("health", {})).resolves.toMatchObject({ status: "working" });
    await expect(httpClient(served.url, { signer: host }).request("health", {})).resolves.toMatchObject({ status: "working" });
    await expect(serveHttp(echo, {})).rejects.toThrow(/signing secret, or the public key/);
    await expect(serveHttp(echo, { secret: "short" })).rejects.toThrow(/at least 32 characters/);
  });
});

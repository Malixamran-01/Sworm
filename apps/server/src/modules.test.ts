import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadInstalledModules } from "./modules";

const root = mkdtempSync(join(tmpdir(), "conclave-modules-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const source = (id: string) => `
export default {
  manifest: { id: "${id}", version: "1.0.0", name: "Echo", ports: ["tool@1"], docks: ["built-in"] },
  create() {
    return {
      ports: { tool: { listTools: async () => [{ name: "echo", inputSchema: {} }], call: async (_n, args) => ({ data: args }) } },
      health: async () => ({ status: "working", detail: "Ready." }),
    };
  },
};`;

describe("installed modules", () => {
  it("loads files and folders from the modules folder without touching core", async () => {
    const dir = join(root, "a");
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "echo.mjs"), source("acme/echo"));
    writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify({ type: "module", main: "main.mjs" }));
    writeFileSync(join(dir, "pkg", "main.mjs"), source("acme/packaged"));
    writeFileSync(join(dir, "notes.txt"), "not a module");

    const { modules, problems } = await loadInstalledModules({ dir });
    expect(problems).toEqual([]);
    expect(modules.map((m) => m.module.manifest.id)).toEqual(["acme/echo", "acme/packaged"]);
    // The manifest is normalised, so defaults are there even when the file used no SDK.
    expect(modules[0]!.module.manifest.permissions).toEqual({ egress: [], secrets: [] });
    const instance = modules[0]!.module.create({ config: {}, secrets: {}, fetch, log: { info() {}, warn() {} } });
    expect(await instance.ports.tool!.listTools()).toEqual([{ name: "echo", inputSchema: {} }]);
  });

  it("leaves out broken modules with a reason, and never replaces a built-in one", async () => {
    const dir = join(root, "b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1-bad-manifest.mjs"), source("Not An Id"));
    writeFileSync(join(dir, "2-no-create.mjs"), `export default { manifest: {} };`);
    writeFileSync(join(dir, "3-throws.mjs"), `throw new Error("boom");`);
    writeFileSync(join(dir, "4-clash.mjs"), source("conclave/mcp"));
    writeFileSync(join(dir, "5-good.mjs"), source("acme/good"));

    const { modules, problems } = await loadInstalledModules({ dir, taken: ["conclave/mcp"], specs: ["./missing.mjs"], cwd: dir });
    expect(modules.map((m) => m.module.manifest.id)).toEqual(["acme/good"]);
    expect(problems.map((p) => p.reason)).toEqual([
      "no such file, or the folder has no entry file.",
      expect.stringContaining("manifest is not valid"),
      expect.stringContaining("no create() function"),
      "boom",
      expect.stringContaining("already installed"),
    ]);
  });

  it("loads modules named by path, and a missing folder has none", async () => {
    const dir = join(root, "c");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "one.mjs"), source("acme/one"));
    const { modules, problems } = await loadInstalledModules({ dir: join(root, "nope"), specs: ["./one.mjs"], cwd: dir });
    expect(problems).toEqual([]);
    expect(modules.map((m) => m.from)).toEqual(["./one.mjs"]);
  });
});

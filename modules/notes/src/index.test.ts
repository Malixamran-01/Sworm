import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConformance, testCallContext } from "@conclave/module-sdk/conformance";
import { afterAll, describe, expect, it } from "vitest";
import { chunksOf, notesModule, tokenize } from "./index";

const base = mkdtempSync(join(tmpdir(), "conclave-notes-"));
const outside = mkdtempSync(join(tmpdir(), "conclave-outside-"));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

mkdirSync(join(base, "vault", "coast"), { recursive: true });
mkdirSync(join(base, "vault", "kitchen"), { recursive: true });
mkdirSync(join(base, "vault", ".obsidian"), { recursive: true });
writeFileSync(
  join(base, "vault", "coast", "Tide pools.md"),
  "---\ntags: [sea]\n---\n# Tide pools\n\nTide pools form where the sea leaves water behind in rock hollows at low tide.\n\n## Who lives there\n\nAnemones, limpets and small crabs live in tide pools. They cope with heat and salt.\n",
);
writeFileSync(join(base, "vault", "coast", "Spring tides.md"), "Spring tides are the highest tides. They come at full moon and new moon, when sun and moon pull together.\n");
writeFileSync(join(base, "vault", "kitchen", "Bread.md"), "# Bread\n\nKnead the dough for ten minutes. Let it rise until doubled.\n");
writeFileSync(join(base, "vault", "Inbox.txt"), "Call the harbour office about the tide tables.\n");
writeFileSync(join(base, "vault", ".obsidian", "workspace.md"), "tide tide tide settings that must not be searched\n");
writeFileSync(join(base, "vault", "photo.png"), "not text");
writeFileSync(join(outside, "secret.md"), "tide secrets that live outside the knowledge directory\n");

const notes = notesModule({ baseDir: base });
const make = (folder = "vault") => notes.create({ config: { folder }, secrets: {}, fetch, log: { info() {}, warn() {} } });
const search = async (query: string, extra: { sources?: string[]; limit?: number } = {}, folder = "vault") =>
  (await make(folder).ports.knowledge!.search({ query, limit: extra.limit ?? 5, ...(extra.sources ? { sources: extra.sources } : {}) }, testCallContext())).passages;

describe("notes folder", () => {
  it("passes the conformance kit", async () => {
    const report = await runConformance(notes, { config: { folder: "vault" }, knowledgeQuery: "tide pools" });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("lists each sub-folder as a source, and says what it found", async () => {
    const instance = make();
    expect(await instance.ports.knowledge!.listSources()).toEqual([
      { id: "*", name: "All notes", description: "4 files" },
      { id: ".", name: "Notes at the top of the folder" },
      { id: "coast", name: "coast" },
      { id: "kitchen", name: "kitchen" },
    ]);
    expect(await instance.health()).toEqual({ status: "working", detail: "4 files, 5 passages." });
  });

  it("finds the passage that answers, with the note and heading it came from", async () => {
    const found = await search("who lives in tide pools");
    expect(found[0]).toEqual({
      text: "Anemones, limpets and small crabs live in tide pools. They cope with heat and salt.",
      source: { id: "coast/Tide pools.md", title: "Tide pools › Who lives there", uri: "coast/Tide pools.md" },
      score: 1,
    });
    // Best first, scores relative to the best, and front matter is not content.
    expect(found.map((p) => p.score)).toEqual([...found.map((p) => p.score)].sort((a, b) => b! - a!));
    expect(found.some((p) => p.text.includes("tags:"))).toBe(false);
    // A plural in the question finds the singular in the note.
    expect((await search("spring tide moon"))[0]!.source.id).toBe("coast/Spring tides.md");
    expect(await search("quantum chromodynamics")).toEqual([]);
  });

  it("keeps to the chosen source and the limit, and never reads hidden folders or other file types", async () => {
    expect((await search("tide", { sources: ["kitchen"] })).length).toBe(0);
    expect((await search("dough rise", { sources: ["kitchen"] }))[0]!.source.id).toBe("kitchen/Bread.md");
    expect((await search("tide", { sources: ["."] })).map((p) => p.source.id)).toEqual(["Inbox.txt"]);
    expect(await search("tide", { limit: 2 })).toHaveLength(2);
    const all = await search("tide settings searched", { limit: 20 });
    expect(all.some((p) => p.source.id.includes(".obsidian"))).toBe(false);
    await expect(search("tide", { sources: ["nope"] })).rejects.toMatchObject({ code: "not_found" });
  });

  it("reads nothing outside the server's knowledge directory", async () => {
    await expect(search("tide", {}, "../" + outside.split(/[\\/]/).at(-1))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(search("tide", {}, outside)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(search("tide", {}, "missing")).rejects.toMatchObject({ code: "not_found" });
    expect((await make("missing").health()).status).toBe("unreachable");

    // A link that points out of the folder is not followed.
    let linked = true;
    try {
      symlinkSync(outside, join(base, "vault", "elsewhere"), "junction");
    } catch {
      linked = false; // Some systems do not let tests make links.
    }
    if (linked) expect((await search("secrets outside directory", { limit: 20 })).some((p) => p.text.includes("secrets"))).toBe(false);
  });

  it("splits notes at headings and long paragraphs, and folds simple plurals", () => {
    expect(chunksOf("# A\n\none\n\n## B\n\ntwo", "Note")).toEqual([
      { title: "Note › A", text: "one" },
      { title: "Note › B", text: "two" },
    ]);
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some words in it to fill the space.`).join("\n\n");
    const parts = chunksOf(long, "Long");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.text.length <= 1800)).toBe(true);
    expect(tokenize("The Tides and the stories of glass")).toEqual(["tide", "story", "glass"]);
  });
});

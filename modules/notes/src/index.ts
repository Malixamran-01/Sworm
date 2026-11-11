import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { NodeCallError, type KnowledgeSource, type Passage } from "@conclave/contract";
import { defineModule, type ConclaveModule } from "@conclave/module-sdk";

/**
 * A folder of notes as a knowledge source (Knowledge port, SRS 4.11): Markdown
 * and text files, such as an Obsidian vault or a docs folder, searched where
 * they lie. Nothing is copied, embedded or sent anywhere: the files are read,
 * split at headings and paragraphs, and ranked by the words they share with
 * the query (BM25). It needs no model and no key.
 *
 * The folder must be inside the one directory the server admin set aside for
 * knowledge. A connection names a sub-folder of it; each of that folder's own
 * sub-folders is a source.
 */
export interface NotesOptions {
  /** The only place on this server a notes connection may read. */
  baseDir: string;
}

const EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1024 * 1024;
const CHUNK_CHARS = 900;
const FRESH_MS = 30_000;
const ALL = "*";

interface Chunk {
  source: string;
  path: string;
  title: string;
  text: string;
  terms: Map<string, number>;
  length: number;
}
interface Index {
  at: number;
  chunks: Chunk[];
  sources: string[];
  /** In how many chunks each word appears. */
  df: Map<string, number>;
  avgLength: number;
  files: number;
  skipped: number;
}

const STOP = new Set("a an and are as at be but by for from has have how i in is it its of on or that the this to was were what when where which who why will with you your".split(" "));

/** Words of a text, lower-cased, with accents kept and a light plural fold so "tides" finds "tide". */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(raw.length > 4 && raw.endsWith("ies") ? `${raw.slice(0, -3)}y` : raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Split a note into passages: at headings first, then at blank lines when a section is long. */
export function chunksOf(text: string, fallbackTitle: string): { title: string; text: string }[] {
  // Front matter is settings, not content.
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const sections: { title: string; lines: string[] }[] = [{ title: fallbackTitle, lines: [] }];
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading) sections.push({ title: `${fallbackTitle} › ${heading[1]}`, lines: [] });
    else sections.at(-1)!.lines.push(line);
  }
  const out: { title: string; text: string }[] = [];
  for (const section of sections) {
    let current = "";
    for (const para of section.lines.join("\n").split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p) continue;
      if (current && current.length + p.length > CHUNK_CHARS) {
        out.push({ title: section.title, text: current });
        current = "";
      }
      current = current ? `${current}\n\n${p}` : p;
      // One very long paragraph is cut so a passage stays readable.
      while (current.length > CHUNK_CHARS * 2) {
        out.push({ title: section.title, text: current.slice(0, CHUNK_CHARS * 2) });
        current = current.slice(CHUNK_CHARS * 2);
      }
    }
    if (current) out.push({ title: section.title, text: current });
  }
  return out;
}

export function notesModule(opts: NotesOptions): ConclaveModule {
  const base = resolve(opts.baseDir);

  return defineModule({
    manifest: {
      id: "conclave/notes",
      version: "1.0.0",
      name: "Notes folder",
      description: "Markdown and text files in a folder on this server, such as an Obsidian vault or your docs. Searched where they are; nothing is copied or sent anywhere.",
      ports: ["knowledge@1"],
      docks: ["built-in"],
      config: [
        {
          key: "folder",
          label: "Folder",
          type: "string",
          placeholder: "handbook",
          help: `A folder inside the server's knowledge directory (${base}). Leave empty for all of it. Each sub-folder becomes a source.`,
        },
      ],
      permissions: { egress: [], secrets: [] },
      reference: true,
    },
    create(ctx) {
      /** The folder this connection reads, checked to be inside the knowledge directory even through links. */
      const root = (): string => {
        const wanted = String(ctx.config.folder ?? "").trim();
        if (/(^|[\\/])\.\.([\\/]|$)/.test(wanted) || /^([a-zA-Z]:|[\\/])/.test(wanted)) {
          throw new NodeCallError("invalid_request", "Folder is a name inside the server's knowledge directory, not a path elsewhere.", false);
        }
        const dir = resolve(base, wanted);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          throw new NodeCallError("not_found", wanted ? `There is no folder "${wanted}" in the server's knowledge directory.` : `The server's knowledge directory (${base}) does not exist yet.`, false);
        }
        const real = realpathSync(dir);
        const realBase = realpathSync(base);
        if (real !== realBase && !real.startsWith(realBase + sep)) throw new NodeCallError("refused", "That folder leads outside the server's knowledge directory.", false);
        return real;
      };

      let index: Index | null = null;
      const build = (): Index => {
        const dir = root();
        const chunks: Chunk[] = [];
        const sources = new Set<string>();
        let files = 0;
        let skipped = 0;
        const walk = (at: string) => {
          for (const name of readdirSync(at).sort()) {
            if (name.startsWith(".") || name === "node_modules") continue;
            const full = join(at, name);
            let stat;
            try {
              // Links are followed only when they stay inside the folder.
              const real = realpathSync(full);
              if (real !== dir && !real.startsWith(dir + sep)) continue;
              stat = statSync(real);
            } catch {
              continue;
            }
            if (stat.isDirectory()) walk(full);
            else if (EXTENSIONS.has(extname(name).toLowerCase())) {
              if (files >= MAX_FILES || stat.size > MAX_FILE_BYTES) {
                skipped += 1;
                continue;
              }
              files += 1;
              const path = relative(dir, full).split(sep).join("/");
              const source = path.includes("/") ? path.split("/")[0]! : ".";
              sources.add(source);
              const title = name.replace(/\.[^.]+$/, "");
              for (const c of chunksOf(readFileSync(full, "utf8"), title)) {
                const words = tokenize(`${c.title} ${c.text}`);
                if (!words.length) continue;
                const terms = new Map<string, number>();
                for (const w of words) terms.set(w, (terms.get(w) ?? 0) + 1);
                chunks.push({ source, path, title: c.title, text: c.text, terms, length: words.length });
              }
            }
          }
        };
        walk(dir);
        const df = new Map<string, number>();
        for (const c of chunks) for (const term of c.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
        const avgLength = chunks.reduce((n, c) => n + c.length, 0) / Math.max(1, chunks.length);
        return { at: Date.now(), chunks, sources: [...sources].sort(), df, avgLength, files, skipped };
      };
      // Notes change while people work; a short-lived index keeps searches quick without going stale.
      const current = (): Index => (index && Date.now() - index.at < FRESH_MS ? index : (index = build()));

      const sourceList = (i: Index): KnowledgeSource[] => [
        { id: ALL, name: "All notes", description: `${i.files} file${i.files === 1 ? "" : "s"}` },
        ...i.sources.map((s) => ({ id: s, name: s === "." ? "Notes at the top of the folder" : s })),
      ];

      return {
        ports: {
          knowledge: {
            listSources: async () => sourceList(current()),

            async search(req, call) {
              if (call.signal.aborted) throw new NodeCallError("cancelled", "The call was cancelled.", false);
              const words = [...new Set(tokenize(req.query ?? ""))];
              if (!words.length) throw new NodeCallError("invalid_request", "Give a few words to look for.", false);
              const i = current();
              const wanted = (req.sources ?? []).filter((s) => s !== ALL);
              const unknown = wanted.filter((s) => !i.sources.includes(s));
              if (unknown.length) throw new NodeCallError("not_found", `There is no source "${unknown[0]}" in this folder.`, false);
              const pool = wanted.length ? i.chunks.filter((c) => wanted.includes(c.source)) : i.chunks;
              const n = i.chunks.length;
              const scored: { chunk: Chunk; score: number }[] = [];
              for (const chunk of pool) {
                let score = 0;
                for (const w of words) {
                  const tf = chunk.terms.get(w);
                  if (!tf) continue;
                  const idf = Math.log(1 + (n - (i.df.get(w) ?? 0) + 0.5) / ((i.df.get(w) ?? 0) + 0.5));
                  score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (chunk.length / i.avgLength)));
                }
                if (score > 0) scored.push({ chunk, score });
              }
              scored.sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path));
              const top = scored[0]?.score ?? 1;
              const limit = Math.max(1, Math.min(50, Math.floor(req.limit) || 5));
              const passages: Passage[] = scored.slice(0, limit).map(({ chunk, score }) => ({
                text: chunk.text,
                source: { id: chunk.path, title: chunk.title, uri: chunk.path },
                // Relative to the best match: these are ranks from word counts, not probabilities.
                score: Math.round((score / top) * 1000) / 1000,
              }));
              return { passages, usage: { costUsd: 0 } };
            },
          },
        },

        async health() {
          try {
            index = build();
            if (!index.files) return { status: "working", detail: "The folder has no Markdown or text files yet." };
            return {
              status: "working",
              detail: `${index.files} file${index.files === 1 ? "" : "s"}, ${index.chunks.length} passages${index.skipped ? `; ${index.skipped} left out for size or count` : ""}.`,
            };
          } catch (err) {
            return { status: "unreachable", detail: err instanceof Error ? err.message : String(err) };
          }
        },
        async discover() {
          return { sources: sourceList(current()).map((s) => ({ id: s.id, ...(s.name ? { name: s.name } : {}) })) };
        },
      };
    },
  });
}

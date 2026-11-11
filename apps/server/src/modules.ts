import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { manifestSchema, type ConclaveModule } from "@conclave/module-sdk";

/**
 * Modules installed on this server without changing Conclave (MOD-002).
 *
 * A module is a file or package whose default export is `{ manifest, create }`,
 * usually made with `defineModule` from the Module SDK. They come from:
 * - a folder (CONCLAVE_MODULES_DIR, by default `<data dir>/modules`): every
 *   `.js`, `.mjs` or `.ts` file in it, and every sub-folder with a
 *   `package.json` or an `index` file;
 * - CONCLAVE_MODULES: a comma-separated list of package names or paths.
 *
 * These run inside the server with its privileges, so installing one is the
 * server admin's call, like CONCLAVE_SIDECARS. Their outside calls still go
 * through the egress check, and their secrets are still per connection. A
 * module that should not be trusted that far belongs in the remote, sidecar or
 * Local Bridge dock instead.
 */
export interface LoadedModules {
  modules: { module: ConclaveModule; from: string }[];
  /** Why a module was left out. The server still starts; one bad module must not take it down. */
  problems: { from: string; reason: string }[];
}

const ENTRY_FILES = ["index.js", "index.mjs", "index.ts", "src/index.js", "src/index.mjs", "src/index.ts"];
const isModuleFile = (name: string) => /\.(mjs|js|ts)$/.test(name) && !/\.(test|spec|d)\.[a-z]+$/.test(name);

/** The file to import for a module folder: its package.json entry, or an index file. */
function entryOf(dir: string): string | null {
  const pkgFile = join(dir, "package.json");
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { exports?: unknown; main?: unknown; module?: unknown };
      const root = typeof pkg.exports === "string" ? pkg.exports : (pkg.exports as Record<string, unknown> | undefined)?.["."];
      const fromExports = typeof root === "string" ? root : ((root as Record<string, unknown> | undefined)?.import ?? (root as Record<string, unknown> | undefined)?.default);
      for (const candidate of [fromExports, pkg.module, pkg.main]) {
        if (typeof candidate === "string" && existsSync(join(dir, candidate))) return join(dir, candidate);
      }
    } catch {
      /* fall through to index files */
    }
  }
  for (const name of ENTRY_FILES) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

/** Module entry files in a folder. A folder that does not exist has none. */
export function scanModulesDir(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      const entry = entryOf(full);
      if (entry) found.push(entry);
    } else if (isModuleFile(name)) {
      found.push(full);
    }
  }
  return found;
}

const looksLikePath = (spec: string) => spec.startsWith(".") || spec.startsWith("/") || isAbsolute(spec) || /\.(mjs|js|ts)$/.test(spec);

/** Check that what a file exported is a module, and normalise its manifest. */
function asModule(exported: unknown): ConclaveModule {
  const mod = (exported as { default?: unknown })?.default ?? (exported as { module?: unknown })?.module ?? exported;
  // A CommonJS file imported from ESM puts its exports under `default` twice.
  const candidate = ((mod as { default?: unknown })?.default ?? mod) as { manifest?: unknown; create?: unknown } | undefined;
  if (!candidate || typeof candidate !== "object") throw new Error("it has no default export.");
  if (typeof candidate.create !== "function") throw new Error("its default export has no create() function. Export defineModule({ manifest, create }).");
  const parsed = manifestSchema.safeParse(candidate.manifest);
  if (!parsed.success) throw new Error(`its manifest is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ")}`);
  return { manifest: parsed.data, create: candidate.create as ConclaveModule["create"] };
}

/**
 * Load installed modules. `taken` holds the ids already in use (the built-in
 * modules), which an installed module may not replace.
 */
export async function loadInstalledModules(opts: { dir?: string | null; specs?: string[]; taken?: Iterable<string>; cwd?: string }): Promise<LoadedModules> {
  const taken = new Set(opts.taken ?? []);
  const out: LoadedModules = { modules: [], problems: [] };
  const sources: { from: string; target: string }[] = [];
  for (const file of opts.dir ? scanModulesDir(opts.dir) : []) sources.push({ from: file, target: pathToFileURL(file).href });
  for (const spec of opts.specs ?? []) {
    if (!looksLikePath(spec)) {
      sources.push({ from: spec, target: spec });
      continue;
    }
    const full = resolve(opts.cwd ?? process.cwd(), spec);
    const entry = existsSync(full) && statSync(full).isDirectory() ? entryOf(full) : full;
    if (!entry || !existsSync(entry)) out.problems.push({ from: spec, reason: "no such file, or the folder has no entry file." });
    else sources.push({ from: spec, target: pathToFileURL(entry).href });
  }

  for (const { from, target } of sources) {
    try {
      const module = asModule(await import(target));
      if (taken.has(module.manifest.id)) throw new Error(`a module with the id "${module.manifest.id}" is already installed.`);
      taken.add(module.manifest.id);
      out.modules.push({ module, from });
    } catch (err) {
      out.problems.push({ from, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

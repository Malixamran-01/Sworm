import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModuleDto } from "@conclave/contract";
import { audit, ConclaveError, toModuleDto, type Conclave, type Principal } from "@conclave/core";
import { cmpInstance, manifestSchema, performFetch, spawnClient, type ConclaveModule, type ModuleManifest } from "@conclave/module-sdk";
import { repoRoot } from "./config";

/**
 * Modules installed from the app (MOD-002). An owner uploads one file whose
 * default export is `{ manifest, create }`; it is shown with what it may
 * reach, and installed only after they confirm.
 *
 * An uploaded module never runs inside the server. Each connection to it
 * starts its own process with a bare environment, and its network calls come
 * back through the server's egress check. That is a process boundary, not a
 * sandbox: the process still runs as the server's operating-system user. So
 * the whole feature is off unless the server admin turns it on
 * (CONCLAVE_MODULE_UPLOADS), and for code that must be contained, a sidecar
 * connection to a container with no network is the stronger choice.
 */
const RUNNER = fileURLToPath(new URL("./module-runner.ts", import.meta.url));
const MAX_SOURCE = 512 * 1024;

/** What a module process may see of the server's environment: enough to start, nothing of Conclave's own. */
function bareEnv(): Record<string, string> {
  const env: Record<string, string> = { CONCLAVE_CMP: "1", NODE_ENV: "production" };
  for (const k of ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "LANG", "TZ"]) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

const node = (file: string, ...flags: string[]) => [process.execPath, "--import", "tsx", RUNNER, file, ...flags];

/** Ask the runner, in its own process, what the file declares. Nothing of the module runs in the server. */
function readManifest(file: string): Promise<ModuleManifest> {
  const [cmd, ...args] = node(file, "--manifest");
  return new Promise((resolve, reject) => {
    execFile(cmd!, args, { cwd: repoRoot, env: bareEnv(), timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const reason = stderr.trim().split("\n").filter(Boolean).at(-1) ?? (err.killed ? "It took too long to load." : err.message);
        return reject(new ConclaveError(422, "This is not a module Conclave can install", reason.slice(0, 600)));
      }
      try {
        resolve(manifestSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")));
      } catch {
        reject(new ConclaveError(422, "This is not a module Conclave can install", "The file did not describe itself."));
      }
    });
  });
}

/** The module as the server sees it: its own manifest, served by a process per connection. */
function isolated(file: string, manifest: ModuleManifest): ConclaveModule {
  return {
    manifest,
    create(ctx) {
      const client = spawnClient(node(file), {
        cwd: repoRoot,
        env: bareEnv(),
        log: ctx.log,
        // The egress check uses this module's own manifest, so it reaches only what it declared.
        onFetch: (req, signal) => performFetch(ctx.fetch, req, signal),
      });
      return cmpInstance(client, { config: ctx.config as Record<string, unknown>, secrets: ctx.secrets });
    },
  };
}

const fileFor = (id: string) => `${id.replace("/", "__")}.mjs`;

export interface UploadedModuleDto {
  module: ModuleDto;
  /** Connections that use it, across the server. It cannot be removed while this is above zero. */
  connections: number;
}

export class ModuleUploads {
  /** Ids of modules that came from an upload, as opposed to ones the server started with. */
  private readonly uploaded = new Set<string>();

  constructor(
    private readonly conclave: Conclave,
    private readonly dir: string,
    readonly enabled: boolean,
  ) {}

  private ensureOn(): void {
    if (!this.enabled) {
      throw new ConclaveError(403, "Installing modules from the app is turned off", "The server admin turns it on with CONCLAVE_MODULE_UPLOADS=on. Modules can still be added to the server's modules folder.");
    }
  }

  private check(source: string): void {
    if (typeof source !== "string" || !source.trim()) throw new ConclaveError(422, "The file is empty");
    if (Buffer.byteLength(source) > MAX_SOURCE) throw new ConclaveError(422, "The file is too large", "A module is one JavaScript file of at most 512 kB.");
    if (source.includes("\u0000")) throw new ConclaveError(422, "This is not a text file", "Upload the module's JavaScript file (.mjs or .js).");
  }

  /** Write the source to a scratch file, read its manifest in a separate process, and clean up. */
  private async describe(source: string): Promise<ModuleManifest> {
    mkdirSync(this.dir, { recursive: true });
    const scratch = join(this.dir, `.inspect-${randomBytes(8).toString("hex")}.mjs`);
    writeFileSync(scratch, source, { mode: 0o600 });
    try {
      return await readManifest(scratch);
    } finally {
      rmSync(scratch, { force: true });
    }
  }

  /** What installing would add, and whether it would replace an upload already there. Installs nothing. */
  async inspect(source: string): Promise<{ module: ModuleDto; replaces: string | null; blocked: string | null }> {
    this.ensureOn();
    this.check(source);
    const manifest = await this.describe(source);
    const existing = this.conclave.registry.has(manifest.id) ? this.conclave.registry.get(manifest.id) : null;
    return {
      module: toModuleDto(manifest, "installed"),
      replaces: existing && this.uploaded.has(manifest.id) ? existing.manifest.version : null,
      blocked: existing && !this.uploaded.has(manifest.id) ? `A module with the id "${manifest.id}" already ships with this server. Give yours another id.` : null,
    };
  }

  async install(p: Principal, source: string): Promise<ModuleDto> {
    this.ensureOn();
    this.check(source);
    const manifest = await this.describe(source);
    if (this.conclave.registry.has(manifest.id) && !this.uploaded.has(manifest.id)) {
      throw new ConclaveError(409, "That id is taken", `A module with the id "${manifest.id}" already ships with this server. Give yours another id.`);
    }
    const file = join(this.dir, fileFor(manifest.id));
    const next = `${file}.next`;
    writeFileSync(next, source, { mode: 0o600 });
    renameSync(next, file);
    this.register(file, manifest);
    // Connections to an earlier version start the new code on their next call.
    for (const c of await this.conclave.db.query<{ id: string }>(`select id from connections where module_id = $1`, [manifest.id])) this.conclave.connections.runtime.evict(c.id);
    await audit(this.conclave.db, p, "module.installed", manifest.id, { version: manifest.version, ports: manifest.ports, egress: manifest.permissions.egress });
    return toModuleDto(manifest, "installed");
  }

  async remove(p: Principal, id: string): Promise<void> {
    this.ensureOn();
    if (!this.uploaded.has(id)) throw new ConclaveError(404, "Module not found", "Only modules installed from the app can be removed here.");
    const [used] = await this.conclave.db.query<{ n: string }>(`select count(*) as n from connections where module_id = $1`, [id]);
    if (Number(used?.n) > 0) throw new ConclaveError(409, "This module is in use", `${used!.n} connection${Number(used!.n) === 1 ? " uses" : "s use"} it. Delete those first.`);
    this.conclave.registry.remove(id);
    this.uploaded.delete(id);
    rmSync(join(this.dir, fileFor(id)), { force: true });
    await audit(this.conclave.db, p, "module.removed", id, {});
  }

  async list(): Promise<UploadedModuleDto[]> {
    const counts = await this.conclave.db.query<{ module_id: string; n: string }>(`select module_id, count(*) as n from connections group by module_id`);
    const used = new Map(counts.map((c) => [c.module_id, Number(c.n)]));
    return [...this.uploaded].sort().map((id) => ({ module: toModuleDto(this.conclave.registry.get(id).manifest, "installed"), connections: used.get(id) ?? 0 }));
  }

  /** At start: bring back what was installed before. A file that no longer loads is skipped, with the reason. */
  async loadAll(): Promise<{ loaded: string[]; problems: { file: string; reason: string }[] }> {
    const out = { loaded: [] as string[], problems: [] as { file: string; reason: string }[] };
    if (!existsSync(this.dir)) return out;
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".mjs") || name.startsWith(".")) continue;
      const file = join(this.dir, name);
      try {
        if (!this.enabled) throw new Error("installing modules from the app is turned off, so it was not loaded.");
        if (Buffer.byteLength(readFileSync(file)) > MAX_SOURCE) throw new Error("the file is too large.");
        const manifest = await readManifest(file);
        if (this.conclave.registry.has(manifest.id)) throw new Error(`a module with the id "${manifest.id}" is already installed.`);
        this.register(file, manifest);
        out.loaded.push(manifest.id);
      } catch (err) {
        out.problems.push({ file: name, reason: err instanceof ConclaveError ? (err.detail ?? err.title) : err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  private register(file: string, manifest: ModuleManifest): void {
    this.conclave.registry.install(isolated(file, manifest), "installed");
    this.uploaded.add(manifest.id);
  }
}

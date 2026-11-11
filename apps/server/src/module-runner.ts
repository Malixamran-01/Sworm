/**
 * Runs one uploaded module in its own process (MOD-003, MOD-010).
 *
 *   module-runner <file> --manifest   print the module's manifest as JSON and exit
 *   module-runner <file>              serve the module over stdin/stdout (CMP)
 *
 * The process is started with a bare environment: no keys, no database URL.
 * The module's network calls go back through the server, which lets through
 * only the hosts its manifest declares.
 */
import { pathToFileURL } from "node:url";
import { manifestSchema, serveStdio, type ConclaveModule } from "@conclave/module-sdk";

const [file, flag] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (!file) fail("No module file given.");

let exported: unknown;
try {
  exported = await import(pathToFileURL(file).href);
} catch (err) {
  fail(`The file could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
}
const first = (exported as { default?: unknown })?.default ?? exported;
const candidate = ((first as { default?: unknown })?.default ?? first) as { manifest?: unknown; create?: unknown } | undefined;
if (!candidate || typeof candidate !== "object") fail("The file has no default export. Export { manifest, create }.");
if (typeof candidate.create !== "function") fail("The default export has no create() function. Export { manifest, create }.");
const parsed = manifestSchema.safeParse(candidate.manifest);
if (!parsed.success) fail(`The manifest is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ")}`);
const mod: ConclaveModule = { manifest: parsed.data, create: candidate.create as ConclaveModule["create"] };

if (flag === "--manifest") {
  process.stdout.write(`${JSON.stringify(mod.manifest)}\n`);
  process.exit(0);
} else {
  serveStdio(mod);
}

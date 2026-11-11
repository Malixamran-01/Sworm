import { serveHttp, serveStdio } from "@conclave/module-sdk";
import sample from "./index";

/**
 * Serve the sample module.
 *   tsx src/serve.ts --stdio                      for a sidecar or a Local Bridge target
 *   tsx src/serve.ts --http 8790                  for the remote dock. Either CMP_HOST_KEY, the
 *                                                 Conclave server's public key from its Remote
 *                                                 module form (with CMP_AUDIENCE, this module's
 *                                                 public address), or CMP_SECRET, a shared
 *                                                 secret of at least 32 characters
 */
const args = process.argv.slice(2);
if (args.includes("--stdio")) {
  serveStdio(sample);
} else {
  const at = args.indexOf("--http");
  const port = at >= 0 ? Number(args[at + 1]) || 8790 : 8790;
  const secret = process.env.CMP_SECRET ?? "";
  const hostKeys = (process.env.CMP_HOST_KEY ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!hostKeys.length && secret.length < 32) {
    console.error("Set CMP_HOST_KEY to the Conclave server's public key (shown on its Remote module form), or CMP_SECRET to a shared secret of at least 32 characters.");
    process.exit(1);
  }
  const served = await serveHttp(sample, {
    ...(secret ? { secret } : {}),
    ...(hostKeys.length ? { hostKeys } : {}),
    ...(process.env.CMP_AUDIENCE ? { audience: process.env.CMP_AUDIENCE } : {}),
    port,
    host: process.env.HOST ?? "127.0.0.1",
    config: { stepMs: Number(process.env.STEP_MS ?? 400) },
  });
  console.error(`Sample agent: ${served.url}`);
  if (hostKeys.length) console.error(`This module's public key, to pin on the connection: ${served.publicKey}`);
}

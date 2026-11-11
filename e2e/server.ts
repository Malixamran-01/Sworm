import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Starts a throwaway Conclave server for the browser checks: its own data
 * folder and port, started with node directly (no shell), so stopping it
 * works the same on Windows, macOS and Linux.
 */
/** The sample module (modules/sample-agent) started over stdio. */
export const SAMPLE_SIDECAR = "node --import tsx modules/sample-agent/src/serve.ts --stdio";

export default async function globalSetup() {
  const port = Number(process.env.E2E_PORT ?? 8799);
  const taken = await fetch(`http://127.0.0.1:${port}/v1/health`).then(
    () => true,
    () => false,
  );
  if (taken) throw new Error(`Port ${port} is already in use. Stop that server or set E2E_PORT.`);
  const dataDir = mkdtempSync(join(tmpdir(), "conclave-e2e-"));
  const child = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      CONCLAVE_DATA_DIR: dataDir,
      CONCLAVE_PUBLIC_URL: `http://127.0.0.1:${port}`,
      // The sample agent, as a sidecar, so agent steps and their questions have real content.
      CONCLAVE_SIDECARS: SAMPLE_SIDECAR,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The server exited early:\n${log}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`The server did not start in time:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return async () => {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}

import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providersFromEnv, type ProviderConfig } from "./auth/oidc";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  dataDir: string;
  masterKey: Buffer;
  /** Base URL people reach the app at; invite links and sign-in callbacks use it. */
  publicUrl: string;
  /** Needed to set up an instance that listens beyond localhost, printed in the log. */
  setupCode: string | null;
  providers: ProviderConfig[];
  signupDomains: string[];
  webDist: string | null;
  /** Email digests need SMTP; unset means no email. */
  smtp: { url: string; from: string } | null;
  vapidSubject: string | undefined;
  pushHosts: string[] | undefined;
  /** Origins passkeys may be used from: the public URL plus CONCLAVE_WEBAUTHN_ORIGINS (e.g. a dev server). */
  webauthnOrigins: string[];
}

const isLocal = (host: string) => ["127.0.0.1", "localhost", "::1"].includes(host);

/** Lite-profile defaults: PGlite in ./data, bound to localhost, no outside services (PROF-003). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.CONCLAVE_DATA_DIR ?? resolve(repoRoot, "data"));
  mkdirSync(dataDir, { recursive: true });
  const webDist = resolve(env.CONCLAVE_WEB_DIST ?? resolve(repoRoot, "apps/web/dist"));
  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? 8787);
  return {
    host,
    port,
    databaseUrl: env.CONCLAVE_DATABASE_URL ?? `pglite:${resolve(dataDir, "pglite")}`,
    dataDir,
    masterKey: loadMasterKey(env, dataDir),
    publicUrl: (env.CONCLAVE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    setupCode: env.CONCLAVE_SETUP_CODE ?? (isLocal(host) ? null : String(randomInt(100_000, 1_000_000))),
    providers: providersFromEnv(env),
    signupDomains: (env.CONCLAVE_SIGNUP_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean),
    webDist: existsSync(resolve(webDist, "index.html")) ? webDist : null,
    smtp: env.CONCLAVE_SMTP_URL ? { url: env.CONCLAVE_SMTP_URL, from: env.CONCLAVE_MAIL_FROM ?? "Conclave <conclave@localhost>" } : null,
    vapidSubject: env.CONCLAVE_VAPID_SUBJECT,
    webauthnOrigins: [
      new URL(env.CONCLAVE_PUBLIC_URL ?? `http://localhost:${port}`).origin,
      ...(env.CONCLAVE_WEBAUTHN_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    ],
    pushHosts: env.CONCLAVE_PUSH_HOSTS ? env.CONCLAVE_PUSH_HOSTS.split(",").map((h) => h.trim()).filter(Boolean) : undefined,
  };
}

function loadMasterKey(env: NodeJS.ProcessEnv, dataDir: string): Buffer {
  if (env.CONCLAVE_MASTER_KEY) {
    const key = Buffer.from(env.CONCLAVE_MASTER_KEY, "base64");
    if (key.length !== 32) throw new Error("CONCLAVE_MASTER_KEY must be 32 bytes, base64-encoded.");
    return key;
  }
  // Self-host default: a local master key file (SRS 8.1). Back it up; without it secrets cannot be read.
  const file = resolve(dataDir, "master.key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  return key;
}

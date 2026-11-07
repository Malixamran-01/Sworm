import { createConclave, smtpMailer } from "@conclave/core";
import { createDb } from "@conclave/db";
import anthropic from "@conclave/module-anthropic";
import mcp from "@conclave/module-mcp";
import mockModel from "@conclave/module-mock-model";
import openaiCompatible from "@conclave/module-openai-compatible";
import { buildApp } from "./app";
import { IdentityProviders } from "./auth/oidc";
import { loadConfig } from "./config";

const config = loadConfig();
const db = await createDb(config.databaseUrl);
const conclave = await createConclave({
  db,
  modules: [anthropic, openaiCompatible, mcp, mockModel],
  masterKey: config.masterKey,
  signupDomains: config.signupDomains,
  webauthn: { rpId: new URL(config.publicUrl).hostname, rpName: "Conclave", origins: config.webauthnOrigins },
  notifications: {
    publicUrl: config.publicUrl,
    ...(config.smtp ? { mailer: smtpMailer(config.smtp.url, config.smtp.from) } : {}),
    ...(config.vapidSubject ? { vapidSubject: config.vapidSubject } : {}),
    ...(config.pushHosts ? { pushHosts: config.pushHosts } : {}),
  },
});
await conclave.bootstrapOwner();
conclave.startBackground();

const app = await buildApp({
  conclave,
  providers: new IdentityProviders(config.providers, config.publicUrl),
  publicUrl: config.publicUrl,
  setupCode: config.setupCode,
  webDist: config.webDist,
  logger: true,
});
await app.listen({ host: config.host, port: config.port });

console.log(`Conclave is running on ${config.publicUrl} (listening on ${config.host}:${config.port}, database: ${db.kind})`);
if (await conclave.accounts.setupRequired()) {
  console.log(`First run: open ${config.publicUrl} to create the owner account.`);
  if (config.setupCode) console.log(`Setup code: ${config.setupCode}  (needed because this server listens beyond localhost)`);
}
if (config.providers.length) console.log(`Sign-in providers: ${config.providers.map((p) => p.name).join(", ")}`);
if (!config.webDist) console.log("Web app not built: run `npm run dev:web` for the dev UI, or `npm run build:web`.");

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  // Open sockets must not keep the process alive forever.
  setTimeout(() => process.exit(0), 5_000).unref();
  await app.close();
  await conclave.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

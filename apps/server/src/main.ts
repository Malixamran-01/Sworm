import { createConclave, remoteSigningKey, smtpMailer } from "@conclave/core";
import { createDb } from "@conclave/db";
import a2a from "@conclave/module-a2a";
import anthropic from "@conclave/module-anthropic";
import mcp from "@conclave/module-mcp";
import mockModel from "@conclave/module-mock-model";
import n8n from "@conclave/module-n8n";
import { notesModule } from "@conclave/module-notes";
import searchEndpoint from "@conclave/module-search-endpoint";
import openaiCompatible from "@conclave/module-openai-compatible";
import { remoteDock } from "@conclave/module-remote-dock";
import { ed25519Signer } from "@conclave/module-sdk";
import { sidecarDock } from "@conclave/module-sidecar-dock";
import webhookWorkflow from "@conclave/module-webhook-workflow";
import { buildApp } from "./app";
import { BridgeHub, bridgeDock } from "./bridge";
import { IdentityProviders } from "./auth/oidc";
import { SamlSignIn, samlFromEnv } from "./auth/saml";
import { loadConfig } from "./config";
import { loadInstalledModules } from "./modules";
import { ModuleUploads } from "./uploads";
import { resolve } from "node:path";

const config = loadConfig();
const db = await createDb(config.databaseUrl);
const bridge = new BridgeHub();
// Remote modules can trust this server by its public key, so no secret has to be shared with them.
const remoteSigner = ed25519Signer(remoteSigningKey(config.masterKey));
const conclave = await createConclave({
  db,
  modules: [anthropic, openaiCompatible, mcp, mockModel, a2a, n8n, notesModule({ baseDir: config.knowledgeDir }), searchEndpoint, webhookWorkflow, remoteDock({ signer: remoteSigner }), sidecarDock({ allowed: config.sidecars }), bridgeDock(bridge)],
  orchestrator: { publicUrl: config.publicUrl },
  masterKey: config.masterKey,
  signupDomains: config.signupDomains,
  ...(config.otlp ? { otel: config.otlp } : {}),
  webauthn: { rpId: new URL(config.publicUrl).hostname, rpName: "Conclave", origins: config.webauthnOrigins },
  notifications: {
    publicUrl: config.publicUrl,
    ...(config.smtp ? { mailer: smtpMailer(config.smtp.url, config.smtp.from) } : {}),
    ...(config.vapidSubject ? { vapidSubject: config.vapidSubject } : {}),
    ...(config.pushHosts ? { pushHosts: config.pushHosts } : {}),
  },
});
// Modules the server admin added (MOD-002): no change to Conclave, and a broken one is skipped, not fatal.
const installed = await loadInstalledModules({ dir: config.modulesDir, specs: config.moduleSpecs, taken: conclave.registry.list().map((m) => m.id) });
for (const { module } of installed.modules) conclave.registry.install(module, "installed");
// Modules owners installed from the app run in their own processes, never inside the server.
const uploads = new ModuleUploads(conclave, resolve(config.modulesDir, "uploaded"), config.moduleUploads);
const restored = await uploads.loadAll();
await conclave.bootstrapOwner();
conclave.startBackground();

// SAML (ACC-001): a broken setup stops the server with the reason, rather than a sign-in button that fails.
const samlSettings = await samlFromEnv(process.env, config.publicUrl);
const saml = samlSettings ? new SamlSignIn(samlSettings) : null;

const app = await buildApp({
  conclave,
  providers: new IdentityProviders(config.providers, config.publicUrl),
  saml,
  publicUrl: config.publicUrl,
  setupCode: config.setupCode,
  webDist: config.webDist,
  logger: true,
  bridge,
  uploads,
});
await app.listen({ host: config.host, port: config.port });

console.log(`Conclave is running on ${config.publicUrl} (listening on ${config.host}:${config.port}, database: ${db.kind})`);
if (await conclave.accounts.setupRequired()) {
  console.log(`First run: open ${config.publicUrl} to create the owner account.`);
  if (config.setupCode) console.log(`Setup code: ${config.setupCode}  (needed because this server listens beyond localhost)`);
}
if (config.providers.length) console.log(`Sign-in providers: ${config.providers.map((p) => p.name).join(", ")}`);
if (saml) {
  console.log(`SAML sign-in: ${saml.settings.name}. Give your identity provider ${saml.settings.metadataUrl}`);
  for (const c of saml.summary().certificates) if (c.daysLeft < 30) console.warn(`SAML: the identity provider's certificate expires in ${c.daysLeft} days (${c.expiresAt}).`);
}
for (const { module, from } of installed.modules) console.log(`Installed module ${module.manifest.id}@${module.manifest.version} (${module.manifest.ports.join(", ")}) from ${from}`);
if (config.moduleUploads) console.log(`Owners may install modules from the app (CONCLAVE_MODULE_UPLOADS). ${restored.loaded.length} restored.`);
for (const p of restored.problems) console.warn(`Uploaded module not loaded: ${p.file}: ${p.reason}`);
for (const p of installed.problems) console.warn(`Module not installed: ${p.from}: ${p.reason}`);
if (config.otlp) console.log(`Finished traces are sent to ${config.otlp.endpoint} (OpenTelemetry).`);
if (config.sidecars.length) console.log(`Sidecar modules allowed: ${config.sidecars.includes("*") ? "any command" : `${config.sidecars.length} command(s)`}.`);
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

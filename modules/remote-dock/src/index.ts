import { NodeCallError } from "@conclave/contract";
import { cmpInstance, defineModule, httpClient, requireString, type CmpSigner, type ConclaveModule } from "@conclave/module-sdk";

export interface RemoteDockOptions {
  /**
   * This server's own key for signing requests to remote modules. With it, a
   * connection needs no shared secret: the module is given the public key.
   */
  signer?: CmpSigner;
}

/**
 * Remote dock (SRS 4.11, MOD-003): a module that runs on its author's own
 * server and speaks the Conclave Module Protocol over HTTPS. Every request
 * and answer is signed. Whatever ports the module provides (agents,
 * workflows, tools, models) appear on this connection.
 *
 * Two ways to sign:
 * - This server's key (when the server has one for this): each request is
 *   good for five minutes, once, for this module's address only, and nothing
 *   secret is kept on the module's side.
 * - A shared secret, for modules that were set up with one.
 */
export function remoteDock(opts: RemoteDockOptions = {}): ConclaveModule {
  const { signer } = opts;
  return defineModule({
    manifest: {
      id: "conclave/remote",
      version: "0.2.0",
      name: "Remote module",
      description: "A module on its own server, reached over HTTPS with signed requests. It can provide agents, workflows, tools or models.",
      ports: ["agent@1", "workflow@1", "tool@1", "model@1", "knowledge@1"],
      docks: ["remote"],
      config: [
        { key: "url", label: "Module URL", type: "url", required: true, placeholder: "https://agents.example.com/cmp", help: "Plain http works only on this machine." },
        {
          key: "secret",
          label: "Signing secret",
          type: "secret",
          // Without a server key there is no other way to sign, so the secret is needed.
          required: !signer,
          help: signer
            ? `Leave empty to sign with this server's key instead: start the module with this public key and no secret has to be shared. ${signer.publicKey}`
            : "The same secret the module was started with, at least 32 characters.",
        },
        ...(signer
          ? [
              {
                key: "moduleKey",
                label: "Module's public key",
                type: "string" as const,
                help: "Printed by the module when it starts. With it, answers signed by any other key are refused. Only used when no secret is set.",
              },
            ]
          : []),
        { key: "pricePerCallUsd", label: "Price per call (USD)", type: "number", default: 0, help: "Used when the module reports no cost (COST-004)." },
        { key: "pricePerMinuteUsd", label: "Price per minute (USD)", type: "number", default: 0, help: "For agents and workflows billed by time." },
      ],
      permissions: { egress: ["{config.url}"], secrets: ["secret"] },
      reference: true,
    },
    create(ctx) {
      const url = requireString(ctx.config.url, "Module URL");
      const secret = ctx.secrets.secret ?? "";
      if (secret) return cmpInstance(httpClient(url, secret, ctx.fetch));
      if (!signer) throw new NodeCallError("invalid_request", "Signing secret is not set on this connection.", false);
      const moduleKey = typeof ctx.config.moduleKey === "string" ? ctx.config.moduleKey.trim() : "";
      return cmpInstance(httpClient(url, { signer, ...(moduleKey ? { moduleKey } : {}) }, ctx.fetch));
    },
  });
}

/** The remote dock with shared secrets only, for servers that have no signing key of their own. */
export default remoteDock();

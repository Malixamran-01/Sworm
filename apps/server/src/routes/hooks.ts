import { ConclaveError, type Conclave } from "@conclave/core";
import type { FastifyInstance } from "fastify";
import { param, RateLimiter } from "../auth/guard";

/** Headers an outside engine's callback may carry that a module could need (a signature, the content type). */
function pickHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key === "cookie" || key === "authorization") continue;
    if (key === "content-type" || key === "user-agent" || key.startsWith("x-")) out[key] = (Array.isArray(v) ? v.join(", ") : (v ?? "")).slice(0, 1_000);
  }
  return out;
}

/**
 * One-time callback URLs for outside workflows (Workflow port). The token in
 * the path is the credential: unguessable, kept only as a hash, and dead once
 * the step ends. The body may be JSON or plain text.
 */
export function hookRoutes(app: FastifyInstance, conclave: Conclave): void {
  const limiter = new RateLimiter(600, 5 * 60_000);
  void app.register(async (scope) => {
    scope.addContentTypeParser("text/plain", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post("/v1/hooks/runs/:token", { config: { guard: { auth: "public" } }, bodyLimit: 1024 * 1024 }, async (req, reply) => {
      limiter.check(`hook:${req.ip}`);
      const accepted = await conclave.orchestrator.deliverCallback(param("token")(req) ?? "", req.body ?? null, pickHeaders(req.headers));
      if (!accepted) throw new ConclaveError(404, "Unknown callback", "This callback URL is not valid, or its step has already finished.");
      return reply.code(202).send({ accepted: true });
    });
  });
}

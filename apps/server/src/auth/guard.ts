import { ConclaveError, type Conclave, type Permission, type Principal } from "@conclave/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Every /v1 route declares a guard (ACC-005). A route without one is refused,
 * and a test fails if any route is added without it.
 */
export type Guard =
  | { auth: "public" }
  | {
      auth: "user";
      /** Permission the caller needs. Omit for routes about the caller's own account. */
      perm?: Permission;
      /** For workspace-scoped permissions: which workspace the request is about. */
      workspace?: (req: FastifyRequest, conclave: Conclave, p: Principal) => Promise<string | undefined> | string | undefined;
    };

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
    sessionToken: string | null;
  }
  interface FastifyContextConfig {
    guard?: Guard;
  }
}

export const SESSION_COOKIE = "conclave_session";
/** State-changing browser requests must carry this header; cross-site forms cannot set it (SEC-001). */
export const CSRF_HEADER = "x-requested-with";

export const param = (name: string) => (req: FastifyRequest) => (req.params as Record<string, string>)[name];

export function registerGuard(app: FastifyInstance, conclave: Conclave) {
  app.decorateRequest("principal", null);
  app.decorateRequest("sessionToken", null);

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      req.principal = await conclave.accounts.fromToken(header.slice(7).trim());
      return;
    }
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) {
      req.sessionToken = cookie;
      req.principal = await conclave.accounts.fromSession(cookie);
    }
  });

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/v1/") || req.is404) return;
    const guard = req.routeOptions.config.guard;
    if (!guard) throw new ConclaveError(500, "This route has no access rule", "Every API route must declare who may call it.");
    if (guard.auth === "public") return;

    const p = req.principal;
    if (!p) throw new ConclaveError(401, "Sign in required", "Sign in, or send an access token.");
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (unsafe && p.via === "session" && req.headers[CSRF_HEADER] !== "conclave") {
      throw new ConclaveError(403, "Missing request header", `Browser requests that change data must send ${CSRF_HEADER}: conclave.`);
    }
    if (guard.perm) {
      const workspaceId = guard.workspace ? await guard.workspace(req, conclave, p) : undefined;
      await conclave.access.ensure(conclave.db, p, guard.perm, workspaceId);
    }
    void reply;
  });
}

/** The caller, for handlers behind a user guard. */
export function principal(req: FastifyRequest): Principal {
  if (!req.principal) throw new ConclaveError(401, "Sign in required");
  return req.principal;
}

/** Workspace of a task or approval in the URL, for workspace-scoped guards. */
export const workspaceOfTask = (name = "id") => (req: FastifyRequest, c: Conclave, p: Principal) => c.access.workspaceOfRun(c.db, p, param(name)(req)!);
export const workspaceOfApproval = (name = "id") => (req: FastifyRequest, c: Conclave, p: Principal) => c.access.workspaceOfApproval(c.db, p, param(name)(req)!);

/** Small in-memory limiter for sign-in style endpoints. One instance per Lite install. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): void {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      throw new ConclaveError(429, "Too many attempts", `Wait ${Math.ceil((this.windowMs - (now - recent[0]!)) / 1000)} seconds and try again.`);
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value!);
  }
}

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { NodeCallError, type ApiErrorDto } from "@conclave/contract";
import { ConclaveError, type Conclave } from "@conclave/core";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { ZodError } from "zod";
import { registerGuard } from "./auth/guard";
import { IdentityProviders } from "./auth/oidc";
import { registerRealtime } from "./realtime";
import { authRoutes } from "./routes/auth";
import { orgRoutes } from "./routes/org";
import { notificationRoutes } from "./routes/notifications";
import { workRoutes } from "./routes/work";

export interface AppOptions {
  conclave: Conclave;
  /** Outside sign-in providers; none by default. */
  providers?: IdentityProviders;
  /** Base URL people reach the app at, for invite links and sign-in callbacks. */
  publicUrl?: string;
  /** Mark cookies Secure. On when the public URL is https. */
  secureCookies?: boolean;
  /** Required to set up an instance listening beyond localhost. */
  setupCode?: string | null;
  webDist?: string | null;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    routeTable: { method: string; url: string; guard: unknown }[];
  }
}

function problem(reply: FastifyReply, body: ApiErrorDto) {
  return reply.code(body.status).type("application/problem+json").send(body);
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { conclave } = opts;
  const publicUrl = (opts.publicUrl ?? "http://localhost:8787").replace(/\/+$/, "");
  const providers = opts.providers ?? new IdentityProviders([], publicUrl);
  const app = Fastify({
    logger: opts.logger
      ? {
          // Structured JSON logs; secrets never reach them (OBS-002, SEC-002).
          redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        }
      : false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(cors, { origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/], credentials: true });
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ConclaveError) {
      return problem(reply, {
        type: "about:blank",
        title: err.title,
        status: err.status,
        ...(err.detail ? { detail: err.detail } : {}),
        ...(err.errors ? { errors: err.errors } : {}),
      });
    }
    if (err instanceof ZodError) {
      const errors = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
      return problem(reply, { type: "about:blank", title: "The request is not valid", status: 422, detail: errors.join(" "), errors });
    }
    if (err instanceof NodeCallError) {
      return problem(reply, { type: "about:blank", title: "The outside system failed", status: 502, detail: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return problem(reply, { type: "about:blank", title: (err as Error).message, status });
    app.log.error(err);
    return problem(reply, { type: "about:blank", title: "Something went wrong", status: 500 });
  });

  // Route table for the guard inventory test (ACC-005).
  const routeTable: { method: string; url: string; guard: unknown }[] = [];
  app.addHook("onRoute", (r) => {
    for (const method of [r.method].flat()) routeTable.push({ method, url: r.url, guard: (r.config as { guard?: unknown } | undefined)?.guard });
  });
  app.decorate("routeTable", routeTable);

  registerGuard(app, conclave);

  app.get("/v1/health", { config: { guard: { auth: "public" } } }, async () => ({ ok: true, db: conclave.db.kind, seq: conclave.bus.lastSeq }));
  authRoutes(app, { conclave, providers, secureCookies: opts.secureCookies ?? publicUrl.startsWith("https://"), setupCode: opts.setupCode ?? null });
  orgRoutes(app, conclave, publicUrl);
  workRoutes(app, conclave);
  notificationRoutes(app, conclave);
  registerRealtime(app, conclave);

  if (opts.webDist) {
    // Wildcard mode looks files up per request, so a rebuilt web app is served without a restart.
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: true });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/v1/") || !opts.webDist) return problem(reply, { type: "about:blank", title: "Not found", status: 404 });
    return reply.sendFile("index.html");
  });

  return app;
}

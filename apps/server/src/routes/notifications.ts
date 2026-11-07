import type { Conclave } from "@conclave/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { param, principal } from "../auth/guard";

const minute = z.number().int().min(0).max(1439).nullable();
const prefs = z
  .object({
    desktop: z.boolean(),
    push: z.boolean(),
    emailDigest: z.enum(["off", "daily", "weekly"]),
    digestHour: z.number().int().min(0).max(23),
    quietStart: minute,
    quietEnd: minute,
    timeZone: z.string().min(1).max(64),
  })
  .partial();
const subscription = z.object({
  endpoint: z.string().url().max(2_000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

/** Each person's own notification settings (NOTE-003, NOTE-004). */
export function notificationRoutes(app: FastifyInstance, conclave: Conclave) {
  const USER = { config: { guard: { auth: "user" as const } } };
  const n = conclave.notifier;

  app.get("/v1/me/notifications", USER, async (req) => n.settings(principal(req)));
  app.patch("/v1/me/notifications", USER, async (req) => n.updatePrefs(principal(req), prefs.parse(req.body) as Parameters<typeof n.updatePrefs>[1]));
  // Alert rule for one workspace; the person must be able to see it.
  app.put(
    "/v1/me/notifications/workspaces/:id",
    { config: { guard: { auth: "user" as const, perm: "workspace:read" as const, workspace: param("id") } } },
    async (req) => n.setRule(principal(req), param("id")(req)!, z.object({ level: z.enum(["all", "important", "none"]) }).parse(req.body).level),
  );
  app.post("/v1/me/push-subscriptions", USER, async (req, reply) =>
    reply.code(201).send(await n.subscribe(principal(req), subscription.parse(req.body), String(req.headers["user-agent"] ?? ""))),
  );
  app.delete("/v1/me/push-subscriptions/:id", USER, async (req) => n.unsubscribe(principal(req), { id: param("id")(req)! }));
  app.post("/v1/me/push-subscriptions/remove", USER, async (req) =>
    n.unsubscribe(principal(req), { endpoint: z.object({ endpoint: z.string().max(2_000) }).parse(req.body).endpoint }),
  );
  app.post("/v1/me/notifications/test", USER, async (req) => n.test(principal(req)));
}

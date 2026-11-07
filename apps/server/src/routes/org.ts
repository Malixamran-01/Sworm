import { isRole, type Conclave } from "@conclave/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { param, principal } from "../auth/guard";

const role = z.string().refine(isRole, "Unknown role.");
const uuid = z.string().uuid();

/** Members, invites and per-workspace role overrides (ACC-003, ACC-004). */
export function orgRoutes(app: FastifyInstance, conclave: Conclave, publicUrl: string) {
  const a = conclave.accounts;

  app.get("/v1/org/members", { config: { guard: { auth: "user" } } }, async (req) => a.members(principal(req)));

  app.patch("/v1/org/members/:userId", { config: { guard: { auth: "user", perm: "member:manage" } } }, async (req) => {
    await a.setMemberRole(principal(req), uuid.parse(param("userId")(req)), z.object({ role }).parse(req.body).role);
    return a.members(principal(req));
  });

  app.delete("/v1/org/members/:userId", { config: { guard: { auth: "user", perm: "member:manage" } } }, async (req, reply) => {
    await a.removeMember(principal(req), uuid.parse(param("userId")(req)));
    return reply.code(204).send();
  });

  app.get("/v1/org/invites", { config: { guard: { auth: "user", perm: "member:manage" } } }, async (req) => a.invites(principal(req)));

  app.post("/v1/org/invites", { config: { guard: { auth: "user", perm: "member:manage" } } }, async (req, reply) => {
    const body = z.object({ email: z.string().nullable().optional(), role }).parse(req.body);
    const { token, invite } = await a.createInvite(principal(req), body);
    // The link is shown once; only its hash is stored.
    return reply.code(201).send({ invite, link: `${publicUrl}/invite/${token}` });
  });

  app.delete("/v1/org/invites/:id", { config: { guard: { auth: "user", perm: "member:manage" } } }, async (req, reply) => {
    await a.revokeInvite(principal(req), uuid.parse(param("id")(req)));
    return reply.code(204).send();
  });

  const ws = (req: Parameters<ReturnType<typeof param>>[0]) => uuid.parse(param("id")(req));

  app.get("/v1/workspaces/:id/members", { config: { guard: { auth: "user", perm: "workspace:read", workspace: ws } } }, async (req) =>
    a.workspaceMembers(principal(req), ws(req)),
  );

  app.put("/v1/workspaces/:id/members/:userId", { config: { guard: { auth: "user", perm: "member:manage" } } }, async (req) => {
    const body = z.object({ role: role.nullable() }).parse(req.body);
    // Overrides change who may do what in a workspace, so only member managers set them.
    await conclave.access.ensure(conclave.db, principal(req), "workspace:read", ws(req));
    await a.setWorkspaceRole(principal(req), ws(req), uuid.parse(param("userId")(req)), body.role as never);
    return a.workspaceMembers(principal(req), ws(req));
  });
}

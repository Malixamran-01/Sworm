import type { WorkspaceDetailDto } from "@conclave/contract";
import type { Conclave } from "@conclave/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { param, principal, workspaceOfApproval, workspaceOfTask } from "../auth/guard";

const uuid = z.string().uuid();
const brief = z.record(z.string(), z.string());

const schemas = {
  connectionCreate: z.object({
    moduleId: z.string(),
    name: z.string().min(1).max(120),
    values: z.record(z.string(), z.unknown()).default({}),
    spendLimitUsd: z.number().positive().nullable().optional(),
  }),
  connectionUpdate: z.object({
    name: z.string().min(1).max(120).optional(),
    values: z.record(z.string(), z.unknown()).optional(),
    spendLimitUsd: z.number().positive().nullable().optional(),
  }),
  workspaceCreate: z.object({
    // Exactly one of these; the service checks.
    templateKey: z.string().optional(),
    answers: z.record(z.string(), z.unknown()).optional(),
    blank: z.boolean().optional(),
    package: z.unknown().optional(),
    name: z.string().max(120).optional(),
    private: z.boolean().optional(),
    defaultNode: z.object({ connectionId: uuid.nullable(), model: z.string().nullable() }).optional(),
  }),
  roleAssign: z.object({
    connectionId: uuid.nullable(),
    model: z.string().min(1).nullable(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  }),
  budget: z.object({ taskUsd: z.number().positive().optional(), monthUsd: z.number().positive().optional() }),
  // The service validates the workflow itself, with messages that name the step.
  taskType: z.object({
    key: z.string().max(60),
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    inputFields: z.array(z.unknown()).max(50),
    workflow: z.unknown(),
  }),
  roleCreate: z.object({
    key: z.string().max(40).optional(),
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    instructions: z.string().max(50_000).optional(),
    port: z.enum(["model@1", "tool@1"]),
  }),
  roleUpdate: z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2_000).optional(),
    instructions: z.string().max(50_000).optional(),
  }),
  taskStart: z.object({ taskTypeId: uuid, brief }),
  estimate: z.object({ taskTypeId: uuid, brief: brief.default({}) }),
  decision: z.object({ decision: z.enum(["approve", "reject", "changes"]), note: z.string().max(10_000).optional() }),
};

/** Idempotency-Key support for POSTs that start work (SRS 8.5). In memory: one instance per Lite install. */
class IdempotencyCache {
  private readonly entries = new Map<string, { at: number; body: unknown }>();
  get(key: string) {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
    this.entries.delete(key);
    return undefined;
  }
  set(key: string, body: unknown) {
    this.entries.set(key, { at: Date.now(), body });
    if (this.entries.size > 5_000) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** Catalog, connections, workspaces, tasks, approvals and the inbox. */
export function workRoutes(app: FastifyInstance, conclave: Conclave) {
  const idempotency = new IdempotencyCache();
  const idParam = (req: FastifyRequest) => uuid.parse(param("id")(req));
  const wsParam = idParam;
  const taskWs = workspaceOfTask();
  const approvalWs = workspaceOfApproval();

  const startWork = async <T>(req: FastifyRequest, reply: FastifyReply, run: () => Promise<T>) => {
    const key = req.headers["idempotency-key"];
    const cacheKey = typeof key === "string" && key ? `${principal(req).userId}:${req.url}:${key}` : null;
    const hit = cacheKey ? idempotency.get(cacheKey) : undefined;
    if (hit) return reply.code(201).send(hit.body);
    const body = await run();
    if (cacheKey) idempotency.set(cacheKey, body);
    return reply.code(201).send(body);
  };

  // ----------------------------------------------------------------- catalog
  app.get("/v1/modules", { config: { guard: { auth: "user" } } }, async () => conclave.registry.list());
  app.get("/v1/templates", { config: { guard: { auth: "user" } } }, async () => conclave.workspaces.templates());

  // ------------------------------------------------------------- connections
  const connRead = { config: { guard: { auth: "user" as const, perm: "connection:read" as const } } };
  const connManage = { config: { guard: { auth: "user" as const, perm: "connection:manage" as const } } };
  app.get("/v1/connections", connRead, async (req) => conclave.connections.list(principal(req)));
  app.post("/v1/connections", connManage, async (req, reply) => reply.code(201).send(await conclave.connections.create(principal(req), schemas.connectionCreate.parse(req.body))));
  app.get("/v1/connections/:id", connRead, async (req) => conclave.connections.get(principal(req), idParam(req)));
  app.patch("/v1/connections/:id", connManage, async (req) => conclave.connections.update(principal(req), idParam(req), schemas.connectionUpdate.parse(req.body)));
  app.delete("/v1/connections/:id", connManage, async (req, reply) => {
    await conclave.connections.remove(principal(req), idParam(req));
    return reply.code(204).send();
  });
  app.post("/v1/connections/:id/test", connManage, async (req) => conclave.connections.test(principal(req), idParam(req)));
  app.post("/v1/connections/:id/disable", connManage, async (req) => conclave.connections.setDisabled(principal(req), idParam(req), true));
  app.post("/v1/connections/:id/enable", connManage, async (req) => conclave.connections.setDisabled(principal(req), idParam(req), false));
  app.get("/v1/connections/:id/models", connRead, async (req) => conclave.connections.models(principal(req), idParam(req)));
  app.get("/v1/connections/:id/tools", connRead, async (req) => conclave.connections.tools(principal(req), idParam(req)));

  // -------------------------------------------------------------- workspaces
  const inWs = (perm: "workspace:read" | "workspace:edit" | "task:run") => ({ config: { guard: { auth: "user" as const, perm, workspace: wsParam } } });
  app.get("/v1/workspaces", { config: { guard: { auth: "user", perm: "workspace:read" } } }, async (req) => conclave.workspaces.list(principal(req)));
  app.post("/v1/workspaces", { config: { guard: { auth: "user", perm: "workspace:edit" } } }, async (req, reply) =>
    reply.code(201).send(await conclave.workspaces.create(principal(req), schemas.workspaceCreate.parse(req.body) as Parameters<Conclave["workspaces"]["create"]>[1])),
  );
  // Preview what the guided builder would make (WS-001); creates nothing.
  app.post("/v1/workspaces/compose", { config: { guard: { auth: "user", perm: "workspace:edit" } } }, async (req) =>
    conclave.workspaces.compose(req.body as Parameters<Conclave["workspaces"]["compose"]>[0]),
  );
  // Workspace details carry the caller's effective role, so the UI can show what they may do there.
  const withRole = async (req: FastifyRequest, ws: WorkspaceDetailDto): Promise<WorkspaceDetailDto> => {
    const role = await conclave.access.workspaceRole(conclave.db, principal(req), ws.id);
    return role ? { ...ws, yourRole: role } : ws;
  };
  app.get("/v1/workspaces/:id", inWs("workspace:read"), async (req) => withRole(req, await conclave.workspaces.get(principal(req), wsParam(req))));
  app.patch("/v1/workspaces/:id/budget", inWs("workspace:edit"), async (req) =>
    withRole(req, await conclave.workspaces.updateBudget(principal(req), wsParam(req), schemas.budget.parse(req.body))),
  );
  app.put("/v1/workspaces/:id/roles/:roleKey", inWs("workspace:edit"), async (req) =>
    withRole(req, await conclave.workspaces.assignRole(principal(req), wsParam(req), param("roleKey")(req)!, schemas.roleAssign.parse(req.body))),
  );
  app.get("/v1/workspaces/:id/export", inWs("workspace:edit"), async (req) => conclave.workspaces.exportPackage(principal(req), wsParam(req)));

  // Editing workflows and roles from the node editor (WF-007), and what a workspace step may call (WF-008).
  type TaskTypeBody = Parameters<Conclave["workspaces"]["saveTaskType"]>[3];
  const keyParam = (name: string) => (req: FastifyRequest) => z.string().min(1).max(80).parse(param(name)(req));
  app.get("/v1/call-targets", { config: { guard: { auth: "user", perm: "workspace:read" } } }, async (req) => conclave.workspaces.callTargets(principal(req)));
  app.post("/v1/workspaces/:id/task-types", inWs("workspace:edit"), async (req, reply) =>
    reply.code(201).send(await withRole(req, await conclave.workspaces.saveTaskType(principal(req), wsParam(req), null, schemas.taskType.parse(req.body) as TaskTypeBody))),
  );
  app.put("/v1/workspaces/:id/task-types/:key", inWs("workspace:edit"), async (req) =>
    withRole(req, await conclave.workspaces.saveTaskType(principal(req), wsParam(req), keyParam("key")(req), schemas.taskType.parse(req.body) as TaskTypeBody)),
  );
  app.delete("/v1/workspaces/:id/task-types/:key", inWs("workspace:edit"), async (req) =>
    withRole(req, await conclave.workspaces.deleteTaskType(principal(req), wsParam(req), keyParam("key")(req))),
  );
  app.post("/v1/workspaces/:id/roles", inWs("workspace:edit"), async (req, reply) =>
    reply.code(201).send(await withRole(req, await conclave.workspaces.createRole(principal(req), wsParam(req), schemas.roleCreate.parse(req.body)))),
  );
  app.patch("/v1/workspaces/:id/roles/:roleKey", inWs("workspace:edit"), async (req) =>
    withRole(req, await conclave.workspaces.updateRole(principal(req), wsParam(req), keyParam("roleKey")(req), schemas.roleUpdate.parse(req.body))),
  );
  app.delete("/v1/workspaces/:id/roles/:roleKey", inWs("workspace:edit"), async (req) =>
    withRole(req, await conclave.workspaces.deleteRole(principal(req), wsParam(req), keyParam("roleKey")(req))),
  );

  // ------------------------------------------------------------------- tasks
  app.get("/v1/workspaces/:id/tasks", inWs("workspace:read"), async (req) => conclave.orchestrator.list(principal(req), wsParam(req)));
  app.post("/v1/workspaces/:id/tasks", inWs("task:run"), async (req, reply) => {
    const body = schemas.taskStart.parse(req.body);
    return startWork(req, reply, () => conclave.orchestrator.start(principal(req), { workspaceId: wsParam(req), ...body }));
  });
  app.post("/v1/workspaces/:id/estimate", inWs("workspace:read"), async (req) => {
    const body = schemas.estimate.parse(req.body ?? {});
    return conclave.orchestrator.estimate(principal(req), wsParam(req), body.taskTypeId, body.brief);
  });
  app.get("/v1/tasks", { config: { guard: { auth: "user", perm: "workspace:read" } } }, async (req) => conclave.orchestrator.listActive(principal(req)));
  app.get("/v1/tasks/:id", { config: { guard: { auth: "user", perm: "workspace:read", workspace: taskWs } } }, async (req) =>
    conclave.orchestrator.get(principal(req), uuid.parse(param("id")(req))),
  );
  app.post("/v1/tasks/:id/cancel", { config: { guard: { auth: "user", perm: "task:run", workspace: taskWs } } }, async (req) =>
    conclave.orchestrator.cancel(principal(req), uuid.parse(param("id")(req))),
  );
  app.post("/v1/approvals/:id", { config: { guard: { auth: "user", perm: "approval:decide", workspace: approvalWs } } }, async (req) =>
    conclave.orchestrator.decide(principal(req), uuid.parse(param("id")(req)), schemas.decision.parse(req.body)),
  );

  // ------------------------------------------------------------------- inbox (the caller's own items)
  app.get("/v1/inbox", { config: { guard: { auth: "user" } } }, async (req) => {
    const q = req.query as { kind?: string; workspaceId?: string };
    return conclave.orchestrator.inbox(principal(req), {
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.workspaceId ? { workspaceId: uuid.parse(q.workspaceId) } : {}),
    });
  });
  app.post("/v1/inbox/:id/read", { config: { guard: { auth: "user" } } }, async (req) => conclave.orchestrator.markRead(principal(req), uuid.parse(param("id")(req))));
}

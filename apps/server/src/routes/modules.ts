import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { principal } from "../auth/guard";
import type { ModuleUploads } from "../uploads";

const upload = z.object({ source: z.string().max(600_000) });
const idParams = z.object({ publisher: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });

/**
 * Installing modules from the app (MOD-002). Code that runs on the server is
 * the organisation's managers' call, and only when the server admin has
 * turned the feature on.
 */
export function moduleRoutes(app: FastifyInstance, uploads: ModuleUploads) {
  const manage = { config: { guard: { auth: "user" as const, perm: "org:manage" as const } } };

  app.get("/v1/modules/uploads", { config: { guard: { auth: "user", perm: "connection:read" } } }, async () => ({
    enabled: uploads.enabled,
    modules: await uploads.list(),
  }));

  // Shows what the file declares. Installs nothing.
  app.post("/v1/modules/inspect", manage, async (req) => uploads.inspect(upload.parse(req.body).source));

  app.post("/v1/modules/install", manage, async (req, reply) => reply.code(201).send(await uploads.install(principal(req), upload.parse(req.body).source)));

  app.delete("/v1/modules/uploads/:publisher/:name", manage, async (req, reply) => {
    const { publisher, name } = idParams.parse(req.params);
    await uploads.remove(principal(req), `${publisher}/${name}`);
    return reply.code(204).send();
  });
}

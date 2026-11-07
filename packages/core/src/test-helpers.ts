import { createTestDb } from "@conclave/db";
import type { EngineWorker } from "@conclave/engine";
import type { ConclaveModule } from "@conclave/module-sdk";
import mockModel from "@conclave/module-mock-model";
import { createConclave, type Conclave } from "./conclave";
import type { Actor } from "./errors";
import { SecretVault } from "./secrets";
import type { NotifierOptions } from "./notifications";
import type { OrchestratorOptions } from "./orchestrator";

export interface Harness {
  conclave: Conclave;
  actor: Actor;
  worker: EngineWorker;
  connectionId: string;
  workspaceId: string;
  taskTypeId: string;
  /** Advance every due run and publish their events. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function harness(
  opts: { modules?: ConclaveModule[]; orchestrator?: OrchestratorOptions; fetch?: typeof fetch; model?: string; notifications?: NotifierOptions } = {},
): Promise<Harness> {
  const db = await createTestDb();
  const conclave = await createConclave({
    db,
    modules: [mockModel, ...(opts.modules ?? [])],
    masterKey: SecretVault.generateMasterKey(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.notifications ? { notifications: opts.notifications } : {}),
    orchestrator: { defaultRetry: { maxAttempts: 3, backoffMs: 0, factor: 1 }, ...opts.orchestrator },
  });
  const actor = await conclave.bootstrapOwner();
  const connection = await conclave.connections.create(actor, { moduleId: "conclave/mock-model", name: "Mock", values: {} });
  const ws = await conclave.workspaces.createFromTemplate(actor, {
    templateKey: "research-brief",
    defaultNode: { connectionId: connection.id, model: opts.model ?? "mock-small" },
  });
  const worker = conclave.engine.startWorker(conclave.orchestrator.advance, { autoStart: false });
  return {
    conclave,
    actor,
    worker,
    connectionId: connection.id,
    workspaceId: ws.id,
    taskTypeId: ws.taskTypes[0]!.id,
    async settle() {
      await worker.drain();
      await conclave.relay.drain();
    },
    async close() {
      await worker.stop();
      await conclave.stop();
      await db.close();
    },
  };
}

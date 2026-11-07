import { newId } from "@conclave/contract";
import { migrate, type Db } from "@conclave/db";
import { PostgresEngine, type EngineWorker, type ExecutionEngine, type WorkerOptions } from "@conclave/engine";
import type { ConclaveModule } from "@conclave/module-sdk";
import { Access } from "./access";
import { Accounts } from "./accounts";
import { Connections } from "./connections";
import type { Actor } from "./errors";
import { EventBus, OutboxRelay } from "./events";
import { ModuleRegistry } from "./modules";
import { SecondFactors, type WebAuthnConfig } from "./mfa";
import { Notifier, type NotifierOptions } from "./notifications";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator";
import { SecretVault } from "./secrets";
import { Workspaces } from "./workspaces";

export interface ConclaveOptions {
  db: Db;
  modules: ConclaveModule[];
  /** 32-byte master key that wraps every data key. */
  masterKey: Buffer;
  /** Base fetch for modules (tests pass a fake outside system). */
  fetch?: typeof fetch;
  orchestrator?: OrchestratorOptions;
  /** Verified emails on these domains may join the first org as viewers without an invite. */
  signupDomains?: string[];
  /** Email, push and link settings for notifications (NOTE-003). */
  notifications?: NotifierOptions;
  /** Relying party for passkeys (ACC-002). Defaults to localhost. */
  webauthn?: WebAuthnConfig;
}

export interface Conclave {
  db: Db;
  bus: EventBus;
  relay: OutboxRelay;
  registry: ModuleRegistry;
  engine: ExecutionEngine;
  connections: Connections;
  workspaces: Workspaces;
  orchestrator: Orchestrator;
  accounts: Accounts;
  access: Access;
  notifier: Notifier;
  mfa: SecondFactors;
  /** Make sure an owner org and user exist; returns them. Single-user until accounts land (ACC-001). */
  bootstrapOwner(input?: { email?: string; name?: string; orgName?: string }): Promise<Actor>;
  /** Start the engine worker, the outbox relay and periodic health checks. */
  startBackground(opts?: WorkerOptions & { healthCheckMs?: number }): EngineWorker;
  stop(): Promise<void>;
}

export async function createConclave(opts: ConclaveOptions): Promise<Conclave> {
  await migrate(opts.db);
  const bus = new EventBus();
  const relay = new OutboxRelay(opts.db, bus);
  const registry = new ModuleRegistry(opts.modules);
  const vault = new SecretVault(opts.masterKey);
  const engine = new PostgresEngine(opts.db);
  const connections = new Connections(opts.db, registry, vault, opts.fetch);
  const workspaces = new Workspaces(opts.db);
  const orchestrator = new Orchestrator(opts.db, engine, connections, bus, opts.orchestrator);
  const mfa = new SecondFactors(opts.db, vault, opts.webauthn ?? { rpId: "localhost", rpName: "Conclave", origins: ["http://localhost:8787"] });
  const accounts = new Accounts(opts.db, { signupDomains: opts.signupDomains ?? [], mfa });
  const access = new Access();
  const notifier = new Notifier(opts.db, bus, vault, { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...opts.notifications });

  let worker: EngineWorker | undefined;
  let healthTimer: NodeJS.Timeout | undefined;
  let owner: Actor | undefined;

  return {
    db: opts.db,
    bus,
    relay,
    registry,
    engine,
    connections,
    workspaces,
    orchestrator,
    accounts,
    access,
    notifier,
    mfa,

    async bootstrapOwner(input = {}) {
      const [existing] = await opts.db.query<{ org_id: string; user_id: string }>(
        `select org_id, user_id from memberships where role = 'owner' order by org_id limit 1`,
      );
      if (existing) {
        owner = { orgId: existing.org_id, userId: existing.user_id };
        return owner;
      }
      const orgId = newId();
      const userId = newId();
      await opts.db.tx(async (q) => {
        await q.query(`insert into orgs (id, name) values ($1, $2)`, [orgId, input.orgName ?? "My organisation"]);
        await q.query(`insert into users (id, email, name) values ($1, $2, $3)`, [userId, input.email ?? "owner@localhost", input.name ?? "Owner"]);
        await q.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [orgId, userId]);
      });
      owner = { orgId, userId };
      return owner;
    },

    startBackground(workerOpts = {}) {
      relay.start();
      notifier.start();
      worker = engine.startWorker(orchestrator.advance, workerOpts);
      const every = workerOpts.healthCheckMs ?? 10 * 60_000;
      if (every > 0) {
        healthTimer = setInterval(() => {
          if (owner) void connections.checkAll(owner).catch(() => {});
        }, every);
      }
      return worker;
    },

    async stop() {
      clearInterval(healthTimer);
      await worker?.stop();
      await notifier.stop();
      await relay.stop();
    },
  };
}

import { randomBytes } from "node:crypto";
import { NodeCallError } from "@conclave/contract";
import type { Conclave, Devices } from "@conclave/core";
import {
  bridgeCallMessage,
  cmpInstance,
  decodeError,
  defineModule,
  requireString,
  type BridgeDeviceMessage,
  type BridgeServerMessage,
  type BridgeTargetInfo,
  type CmpClient,
  type ConclaveModule,
} from "@conclave/module-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { param, principal, RateLimiter } from "./auth/guard";

interface Socket {
  readyState: number;
  OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  on(event: "message", fn: (raw: Buffer | string) => void): void;
  on(event: "close", fn: () => void): void;
}

interface Link {
  socket: Socket;
  orgId: string;
  name: string;
  targets: BridgeTargetInfo[];
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
}

const targetsSchema = z
  .array(z.object({ name: z.string().max(80), kind: z.enum(["stdio", "http"]) }))
  .max(100)
  .catch([]);

/**
 * Local Bridge hub (SRS 8.8): paired devices connect out to here over one
 * WebSocket each; calls to their targets go down that socket, signed.
 */
export class BridgeHub {
  private devices: Devices | null = null;
  private readonly links = new Map<string, Link>();
  private nextId = 1;

  attach(devices: Devices): void {
    this.devices = devices;
  }

  private need(): Devices {
    if (!this.devices) throw new NodeCallError("unavailable", "The Local Bridge is not ready.", true);
    return this.devices;
  }

  status(deviceId: string): { online: boolean; targets: BridgeTargetInfo[] } {
    const link = this.links.get(deviceId);
    return { online: !!link, targets: link?.targets ?? [] };
  }

  disconnect(deviceId: string): void {
    this.links.get(deviceId)?.socket.close(4403, "This device was removed.");
    this.links.delete(deviceId);
  }

  /** Send one CMP call to a target on a device of the organisation. */
  async request(orgId: string, deviceRef: string, target: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const devices = this.need();
    const device = await devices.resolve(orgId, deviceRef);
    if (!device) throw new NodeCallError("not_found", `No paired device called "${deviceRef}" in this organisation. Pair it in Settings > Devices.`, false);
    const link = this.links.get(device.id);
    if (!link) throw new NodeCallError("unavailable", `${device.name} is offline. Start the Local Bridge on it.`, true);
    const id = this.nextId++;
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(params ?? null);
    const sig = devices.sign(bridgeCallMessage(id, device.id, target, method, ts, body));
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        link.pending.delete(id);
      };
      const onAbort = () => {
        cleanup();
        send(link.socket, { type: "cancel", id });
        reject(signal!.reason instanceof Error ? signal!.reason : new NodeCallError("cancelled", "The call was cancelled.", false));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        send(link.socket, { type: "cancel", id });
        reject(new NodeCallError("timeout", `${device.name} did not answer ${method} in time.`, true));
      }, method === "agent.events" ? 60_000 : 300_000);
      link.pending.set(id, {
        resolve: (v) => (cleanup(), resolve(v)),
        reject: (e) => (cleanup(), reject(e)),
      });
      send(link.socket, { type: "call", id, target, method, params: body, ts, sig });
    });
  }

  /** Pairing, device management and the device socket. */
  routes(app: FastifyInstance, conclave: Conclave): void {
    const devices = conclave.devices;
    this.attach(devices);
    const PUBLIC = { guard: { auth: "public" as const } };
    const limiter = new RateLimiter(20, 10 * 60_000);
    const claimLimiter = new RateLimiter(10, 10 * 60_000);

    app.post("/v1/bridge/pairings", { config: PUBLIC }, async (req, reply) => {
      limiter.check(`pair:${req.ip}`);
      const body = z.object({ name: z.string().max(80), publicKey: z.string().max(200) }).parse(req.body);
      return reply.code(201).send(await devices.startPairing(body));
    });
    app.get("/v1/bridge/pairings/:id", { config: PUBLIC }, async (req) => {
      const q = z.object({ ts: z.string().max(20), sig: z.string().max(200) }).parse(req.query);
      return devices.pairingStatus(param("id")(req)!, q.ts, q.sig);
    });
    app.post("/v1/bridge/pairings/:id/confirm", { config: PUBLIC }, async (req) => {
      const body = z.object({ ts: z.string().max(20), sig: z.string().max(200) }).parse(req.body);
      return devices.confirm(param("id")(req)!, body.ts, body.sig);
    });
    // Entering a device's code: any signed-in member may pair their own computer.
    app.post("/v1/bridge/claim", { config: { guard: { auth: "user" } } }, async (req) => {
      const p = principal(req);
      claimLimiter.check(`claim:${p.userId}`);
      const { code } = z.object({ code: z.string().max(20) }).parse(req.body);
      return devices.claim(p, code);
    });
    app.get("/v1/devices", { config: { guard: { auth: "user" } } }, async (req) => {
      const p = principal(req);
      const all = await conclave.access.can(conclave.db, p, "org:manage");
      return (await devices.list(p, all)).map((d) => ({ ...d, ...this.status(d.id) }));
    });
    app.delete("/v1/devices/:id", { config: { guard: { auth: "user" } } }, async (req, reply) => {
      const p = principal(req);
      const all = await conclave.access.can(conclave.db, p, "org:manage");
      const id = param("id")(req)!;
      await devices.revoke(p, id, all);
      this.disconnect(id);
      return reply.code(204).send();
    });

    app.get("/v1/bridge/connect", { websocket: true, config: PUBLIC }, (socket: Socket) => {
      const nonce = randomBytes(24).toString("base64url");
      let link: Link | null = null;
      let deviceId: string | null = null;
      send(socket, { type: "challenge", nonce });
      const hello = setTimeout(() => {
        if (!link) socket.close(4401, "No hello.");
      }, 10_000);
      const keepalive = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, 30_000);

      socket.on("message", (raw) => {
        let msg: BridgeDeviceMessage;
        try {
          msg = JSON.parse(String(raw)) as BridgeDeviceMessage;
        } catch {
          return;
        }
        if (!link) {
          if (msg.type !== "hello") return socket.close(4400, "Say hello first.");
          void devices.authenticate(String(msg.deviceId), nonce, String(msg.sig)).then((device) => {
            if (!device) return socket.close(4401, "Unknown or removed device.");
            clearTimeout(hello);
            const existing = this.links.get(device.id);
            if (existing) existing.socket.close(4409, "Replaced by a newer connection.");
            link = { socket, orgId: device.orgId, name: device.name, targets: targetsSchema.parse(msg.targets), pending: new Map() };
            deviceId = device.id;
            this.links.set(device.id, link);
            send(socket, { type: "ready", device: { id: device.id, name: device.name } });
          });
          return;
        }
        if (msg.type === "targets") link.targets = targetsSchema.parse(msg.targets);
        else if (msg.type === "result" || msg.type === "error") {
          const waiting = link.pending.get(Number(msg.id));
          if (!waiting) return;
          if (msg.type === "result") waiting.resolve(msg.result);
          else waiting.reject(decodeError(msg.error ?? { code: -32000, message: "The device reported an error." }));
        }
      });
      socket.on("close", () => {
        clearTimeout(hello);
        clearInterval(keepalive);
        if (!link || !deviceId) return;
        if (this.links.get(deviceId) === link) this.links.delete(deviceId);
        for (const p of link.pending.values()) p.reject(new NodeCallError("unavailable", `${link.name} disconnected.`, true));
      });
    });
  }
}

function send(socket: Socket, msg: BridgeServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

/**
 * Bridge dock (SRS 4.11, 8.8): a module or local app on a paired computer.
 * The connection names the device and one of the targets its person added
 * there; only devices of the connection's own organisation are reachable.
 */
export function bridgeDock(hub: BridgeHub): ConclaveModule {
  return defineModule({
    manifest: {
      id: "conclave/bridge",
      version: "0.1.0",
      name: "Local Bridge target",
      description: "A module or local app on a paired computer, reached through its Local Bridge. It can provide agents, workflows, tools or models.",
      ports: ["agent@1", "workflow@1", "tool@1", "model@1", "knowledge@1"],
      docks: ["bridge"],
      config: [
        { key: "device", label: "Device", type: "string", required: true, help: "The device's name, from Settings > Devices." },
        { key: "target", label: "Target", type: "string", required: true, help: "The target's name, as added on that computer (conclave-bridge target add)." },
        { key: "pricePerCallUsd", label: "Price per call (USD)", type: "number", default: 0 },
        { key: "pricePerMinuteUsd", label: "Price per minute (USD)", type: "number", default: 0 },
      ],
      permissions: { egress: [], secrets: [] },
      reference: true,
    },
    create(ctx) {
      const device = requireString(ctx.config.device, "Device");
      const target = requireString(ctx.config.target, "Target");
      const orgId = ctx.connection?.orgId;
      if (!orgId) throw new NodeCallError("internal", "A bridge connection needs its organisation.", false);
      const client: CmpClient = {
        request: (method, params, signal) => hub.request(orgId, device, target, method, params, signal),
        close: async () => {},
      };
      return cmpInstance(client);
    },
  });
}

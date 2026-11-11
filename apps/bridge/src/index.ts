import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { NodeCallError } from "@conclave/contract";
import {
  BRIDGE_METHODS,
  bridgeCallMessage,
  encodeError,
  httpClient,
  isLoopback,
  parseCommand,
  performFetch,
  spawnClient,
  type BridgeDeviceMessage,
  type BridgeServerMessage,
  type BridgeTargetInfo,
  type CmpClient,
} from "@conclave/module-sdk";

/**
 * The Local Bridge (SRS 8.8). It is default-deny: the server can reach only
 * targets added on this machine, by the person at it, and cannot add or widen
 * them. It opens one outbound WebSocket and never listens on a port. Every call
 * must carry a signature from the server key pinned at pairing.
 */

export interface DeviceFile {
  server: string;
  name: string;
  deviceId: string;
  /** The server's Ed25519 public key, pinned at pairing (base64 SPKI). */
  serverKey: string;
  /** This device's key pair; the private key never leaves this file. */
  privateKey: string;
  publicKey: string;
}

export type Target =
  | { name: string; kind: "stdio"; command: string; egress: string[] }
  | { name: string; kind: "http"; url: string; secretEnv?: string };

export interface BridgeOptions {
  /** Where the device key, targets and activity log live. Default ~/.conclave-bridge (or CONCLAVE_BRIDGE_HOME). */
  home?: string;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export const bridgeHome = (home?: string) => home ?? process.env.CONCLAVE_BRIDGE_HOME ?? join(homedir(), ".conclave-bridge");

function writePrivate(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows keeps the file to this user through its profile folder */
  }
}

export function loadDevice(home?: string): DeviceFile | null {
  const file = join(bridgeHome(home), "device.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DeviceFile) : null;
}

export function loadTargets(home?: string): Target[] {
  const file = join(bridgeHome(home), "targets.json");
  return existsSync(file) ? ((JSON.parse(readFileSync(file, "utf8")) as { targets: Target[] }).targets ?? []) : [];
}

function saveTargets(targets: Target[], home?: string) {
  mkdirSync(bridgeHome(home), { recursive: true });
  writePrivate(join(bridgeHome(home), "targets.json"), JSON.stringify({ targets }, null, 2));
}

const TARGET_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** Add a target. Only loopback addresses for http; a command is started without a shell. */
export function addTarget(target: Target, home?: string): Target {
  if (!TARGET_NAME.test(target.name)) throw new Error("Target names are letters, digits, - and _, up to 40 characters.");
  if (target.kind === "http") {
    const url = new URL(target.url);
    if (!isLoopback(url)) throw new Error("An http target must be on this computer (localhost or 127.0.0.1).");
  } else if (!parseCommand(target.command).length) {
    throw new Error("Give the command that starts the module.");
  }
  const targets = loadTargets(home).filter((t) => t.name !== target.name);
  saveTargets([...targets, target], home);
  return target;
}

export function removeTarget(name: string, home?: string): boolean {
  const targets = loadTargets(home);
  const next = targets.filter((t) => t.name !== name);
  saveTargets(next, home);
  return next.length !== targets.length;
}

function checkServer(server: string): string {
  const url = new URL(server);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) throw new Error("The server must be https (plain http only for a server on this computer).");
  return url.origin;
}

async function api<T>(fetcher: typeof fetch, url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetcher(url, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", "x-requested-with": "conclave-bridge" },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T & { detail?: string; title?: string }) : ({} as T & { detail?: string; title?: string });
  if (!res.ok) throw new Error(body.detail ?? body.title ?? `HTTP ${res.status}`);
  return body;
}

const nowTs = () => String(Math.floor(Date.now() / 1000));
const signWith = (key: KeyObject, message: string) => sign(null, Buffer.from(message), key).toString("base64");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Pair this computer: show a code to enter in Conclave, then confirm here who
 * claimed it. The device key is made here and its private half stays here.
 */
export async function pair(
  serverUrl: string,
  name: string,
  opts: BridgeOptions & { confirm(claimedBy: { name: string; email: string; org: string }): Promise<boolean>; showCode(code: string): void; pollMs?: number },
): Promise<DeviceFile> {
  const server = checkServer(serverUrl);
  const fetcher = opts.fetch ?? fetch;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const started = await api<{ pairingId: string; code: string; expiresAt: string; serverKey: string }>(fetcher, `${server}/v1/bridge/pairings`, {
    method: "POST",
    body: { name, publicKey: pub },
  });
  opts.showCode(started.code);
  const until = new Date(started.expiresAt).getTime();
  for (;;) {
    if (Date.now() > until) throw new Error("The code expired. Start pairing again.");
    const ts = nowTs();
    const status = await api<{ state: string; claimedBy?: { name: string; email: string; org: string } }>(
      fetcher,
      `${server}/v1/bridge/pairings/${started.pairingId}?ts=${ts}&sig=${encodeURIComponent(signWith(privateKey, `status:${started.pairingId}:${ts}`))}`,
    );
    if (status.state === "expired") throw new Error("The code expired. Start pairing again.");
    if (status.state === "claimed" && status.claimedBy) {
      if (!(await opts.confirm(status.claimedBy))) throw new Error("Pairing was not confirmed on this computer.");
      break;
    }
    await sleep(opts.pollMs ?? 2_000);
  }
  const ts = nowTs();
  const { deviceId } = await api<{ deviceId: string }>(fetcher, `${server}/v1/bridge/pairings/${started.pairingId}/confirm`, {
    method: "POST",
    body: { ts, sig: signWith(privateKey, `confirm:${started.pairingId}:${ts}`) },
  });
  const device: DeviceFile = {
    server,
    name,
    deviceId,
    serverKey: started.serverKey,
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pub,
  };
  mkdirSync(bridgeHome(opts.home), { recursive: true });
  writePrivate(join(bridgeHome(opts.home), "device.json"), JSON.stringify(device, null, 2));
  return device;
}

/** A local fetch that lets a stdio target reach only the hosts listed for it. */
function targetFetch(target: Extract<Target, { kind: "stdio" }>, base: typeof fetch): typeof fetch {
  const hosts = new Set(target.egress.map((h) => h.toLowerCase()));
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!hosts.has(url.host.toLowerCase())) throw new NodeCallError("refused", `Target ${target.name} may not reach ${url.host} (not in its list on this computer).`, false);
    return base(input, init);
  }) as typeof fetch;
}

function localEnv(): Record<string, string> {
  const env: Record<string, string> = { CONCLAVE_CMP: "1" };
  for (const k of ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "TZ"]) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/**
 * Run the bridge until the signal stops it: connect, prove who this device is,
 * and carry signed calls to local targets. Reconnects with backoff.
 */
export async function runBridge(opts: BridgeOptions & { signal?: AbortSignal; onReady?: () => void } = {}): Promise<void> {
  const device = loadDevice(opts.home);
  if (!device) throw new Error("This computer is not paired yet. Run: conclave-bridge pair <server-url>");
  const log = opts.log ?? ((line: string) => console.log(line));
  const fetcher = opts.fetch ?? fetch;
  const privateKey = createPrivateKey(device.privateKey);
  const serverKey = createPublicKey({ key: Buffer.from(device.serverKey, "base64"), format: "der", type: "spki" });
  const clients = new Map<string, { def: string; client: CmpClient }>();
  const auditFile = join(bridgeHome(opts.home), "activity.log");

  const clientFor = (target: Target): CmpClient => {
    const def = JSON.stringify(target);
    const existing = clients.get(target.name);
    if (existing && existing.def === def) return existing.client;
    void existing?.client.close();
    const client =
      target.kind === "stdio"
        ? spawnClient(parseCommand(target.command), {
            env: localEnv(),
            onFetch: (req, signal) => performFetch(targetFetch(target, fetcher), req, signal),
            log: { info: (m) => log(`[${target.name}] ${m}`), warn: (m) => log(`[${target.name}] ${m}`) },
          })
        : httpClient(target.url, target.secretEnv ? (process.env[target.secretEnv] ?? "") : "", fetcher);
    clients.set(target.name, { def, client });
    return client;
  };
  const infos = (): BridgeTargetInfo[] => loadTargets(opts.home).map((t) => ({ name: t.name, kind: t.kind }));

  const connectOnce = () =>
    new Promise<{ fatal?: string }>((resolve) => {
      const url = `${device.server.replace(/^http/, "ws")}/v1/bridge/connect`;
      const ws = new WebSocket(url);
      const inflight = new Map<number, AbortController>();
      const seen = new Set<number>();
      const send = (msg: BridgeDeviceMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
      const stop = () => ws.close(1000, "Bridge stopped.");
      opts.signal?.addEventListener("abort", stop, { once: true });

      const handleCall = async (msg: Extract<BridgeServerMessage, { type: "call" }>) => {
        const refuse = (code: "refused" | "not_found", message: string) => send({ type: "error", id: msg.id, error: encodeError(new NodeCallError(code, message, false)) });
        let signed = false;
        try {
          signed = verify(null, Buffer.from(bridgeCallMessage(msg.id, device.deviceId, msg.target, msg.method, msg.ts, msg.params)), serverKey, Buffer.from(msg.sig, "base64"));
        } catch {
          signed = false;
        }
        if (!signed) return refuse("refused", "The call is not signed by the server this computer paired with.");
        if (!/^\d+$/.test(msg.ts) || Math.abs(Date.now() / 1000 - Number(msg.ts)) > 300 || seen.has(msg.id)) return refuse("refused", "The call is stale or was already made.");
        seen.add(msg.id);
        if (!BRIDGE_METHODS.has(msg.method)) return refuse("refused", `The bridge does not pass on ${msg.method}.`);
        // Read from disk on every call: targets added or removed here apply at once.
        const target = loadTargets(opts.home).find((t) => t.name === msg.target);
        if (!target) return refuse("not_found", `This computer has no target called "${msg.target}". Add it there with: conclave-bridge target add`);
        const controller = new AbortController();
        inflight.set(msg.id, controller);
        try {
          appendFileSync(auditFile, `${new Date().toISOString()} ${target.name} ${msg.method}\n`);
          const result = await clientFor(target).request(msg.method, JSON.parse(msg.params), controller.signal);
          send({ type: "result", id: msg.id, result: result ?? null });
        } catch (err) {
          send({ type: "error", id: msg.id, error: encodeError(err) });
        } finally {
          inflight.delete(msg.id);
        }
      };

      ws.addEventListener("message", (ev) => {
        let msg: BridgeServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as BridgeServerMessage;
        } catch {
          return;
        }
        if (msg.type === "challenge") {
          send({ type: "hello", deviceId: device.deviceId, sig: signWith(privateKey, `hello:${device.deviceId}:${msg.nonce}`), targets: infos() });
        } else if (msg.type === "ready") {
          log(`Connected to ${device.server} as ${msg.device.name}. Targets: ${infos().map((t) => t.name).join(", ") || "none yet"}.`);
          opts.onReady?.();
        } else if (msg.type === "cancel") {
          inflight.get(msg.id)?.abort();
        } else if (msg.type === "call") {
          void handleCall(msg);
        }
      });
      ws.addEventListener("close", (ev) => {
        opts.signal?.removeEventListener("abort", stop);
        for (const c of inflight.values()) c.abort();
        if (ev.code === 4401 || ev.code === 4403) resolve({ fatal: ev.reason || "The server does not accept this device. Pair it again." });
        else resolve({});
      });
      ws.addEventListener("error", () => {
        /* a close event follows */
      });
    });

  let backoff = 1_000;
  try {
    while (!opts.signal?.aborted) {
      const started = Date.now();
      const { fatal } = await connectOnce();
      if (fatal) throw new Error(fatal);
      if (opts.signal?.aborted) break;
      if (Date.now() - started > 60_000) backoff = 1_000;
      log(`Disconnected; trying again in ${Math.round(backoff / 1000)} s.`);
      await sleep(backoff, opts.signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  } finally {
    for (const { client } of clients.values()) await client.close();
  }
}

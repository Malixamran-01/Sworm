import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign as signWithKey, timingSafeEqual, verify as verifyWithKey, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createInterface } from "node:readline";
import {
  errorCodes,
  NodeCallError,
  toNodeError,
  type AgentEvent,
  type AgentRunHandle,
  type CallContext,
  type KnowledgeSearchRequest,
  type ErrorCode,
  type NodeCall,
  type PortName,
} from "@conclave/contract";
import type { ConclaveModule, ModuleInstance, ModuleLogger } from "./index";
import type { ModuleManifest } from "./manifest";

/**
 * The Conclave Module Protocol (CMP, SRS 4.11): how a module runs outside a
 * Conclave process. Messages are JSON-RPC 2.0, carried over HTTPS with signed
 * requests (remote dock) or over stdin/stdout (sidecar dock and Local Bridge
 * targets). Any module made with defineModule can be served with serveHttp or
 * serveStdio, unchanged.
 *
 * Methods the host calls: initialize, health, outsideVersion, discover,
 * model.listModels, model.generate, tool.listTools, tool.call,
 * agent.listSkills, agent.startRun, agent.events, agent.provideInput,
 * agent.cancel, workflow.list, workflow.trigger, workflow.poll,
 * workflow.callback, workflow.cancel, knowledge.listSources,
 * knowledge.search, and the $/cancel notification.
 * Over stdio the module may call host.fetch (egress through the host's
 * allow-list) and send host.log notifications.
 */
export const CMP_VERSION = "1.0";

export interface CmpRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}
export interface CmpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
export interface CmpErrorBody {
  code: number;
  message: string;
  data?: { code: ErrorCode; retryable: boolean };
}
export interface CmpResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: CmpErrorBody;
}
type CmpMessage = CmpRequest | CmpNotification | CmpResponse;

/** What a module says about itself in reply to initialize: its manifest, without anything secret. */
export interface CmpModuleInfo {
  cmp: string;
  manifest: Pick<ModuleManifest, "id" | "version" | "name" | "description" | "ports" | "docks" | "permissions" | "outsideVersions" | "sensitiveActions">;
}

/** One page of an agent run's events (agent.events). */
export interface CmpEventsPage {
  events: AgentEvent[];
  cursor: number;
  /** The module's event stream ended without a final event; ask again to start a new one. */
  ended?: boolean;
}

/** A host-side connection to a module. */
export interface CmpClient {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

const MAX_BODY = 10 * 1024 * 1024;
const LONG_POLL_MS = 20_000;

// ------------------------------------------------------------------ errors

export function encodeError(err: unknown): CmpErrorBody {
  const e = toNodeError(err);
  return { code: -32000, message: e.message, data: { code: e.code, retryable: e.retryable } };
}

export function decodeError(body: CmpErrorBody): NodeCallError {
  const code = body.data?.code && (errorCodes as readonly string[]).includes(body.data.code) ? body.data.code : "internal";
  return new NodeCallError(code, body.message || "The module reported an error.", body.data?.retryable ?? false);
}

// ---------------------------------------------------------- the module side

export interface DispatcherOptions {
  /** Settings when the host does not send them (remote modules keep their own). */
  config?: Record<string, string | number | undefined>;
  secrets?: Record<string, string>;
  /** Take config and secrets from the host's initialize call (sidecar and bridge). */
  configFromHost?: boolean;
  fetch?: typeof fetch;
  log?: ModuleLogger;
}

export interface CmpDispatcher {
  handle(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

interface EventBuffer {
  events: AgentEvent[];
  done: boolean;
  ended: boolean;
  waiters: Set<() => void>;
  controller: AbortController;
  finishedAt: number;
}

const stderrLog: ModuleLogger = {
  info: (msg, data) => console.error(`[module] ${msg}`, data ?? ""),
  warn: (msg, data) => console.error(`[module] ${msg}`, data ?? ""),
};

/** Turns CMP calls into calls on a module instance. Used by serveHttp, serveStdio and tests. */
export function createDispatcher(mod: ConclaveModule, opts: DispatcherOptions = {}): CmpDispatcher {
  let instance: ModuleInstance | null = null;
  const buffers = new Map<string, EventBuffer>();
  const sweeper = setInterval(() => {
    for (const [id, b] of buffers) if (b.done && Date.now() - b.finishedAt > 3_600_000) buffers.delete(id);
  }, 60_000);
  sweeper.unref?.();

  const make = (config: Record<string, string | number | undefined>, secrets: Record<string, string>) => {
    void instance?.close?.();
    instance = mod.create({ config, secrets, fetch: opts.fetch ?? fetch, log: opts.log ?? stderrLog });
    return instance;
  };
  const inst = () => instance ?? make(opts.config ?? {}, opts.secrets ?? {});
  const port = <P extends "model" | "tool" | "agent" | "workflow" | "knowledge">(name: P) => {
    const p = inst().ports[name];
    if (!p) throw new NodeCallError("invalid_request", `${mod.manifest.name} does not provide the ${name} port.`, false);
    return p as NonNullable<ModuleInstance["ports"][P]>;
  };
  const ctx = (call: NodeCall | undefined, signal: AbortSignal): CallContext => ({ call: call ?? blankCall(), signal, emit: () => {} });

  /** Follow an agent run's events into a buffer that agent.events pages through. */
  const buffer = (handle: AgentRunHandle): EventBuffer => {
    const existing = buffers.get(handle.externalRunId);
    if (existing && !existing.ended) return existing;
    const b: EventBuffer = { events: [], done: false, ended: false, waiters: new Set(), controller: new AbortController(), finishedAt: 0 };
    buffers.set(handle.externalRunId, b);
    const wake = () => {
      for (const w of b.waiters) w();
      b.waiters.clear();
    };
    void (async () => {
      try {
        for await (const event of port("agent").streamEvents(handle, ctx(undefined, b.controller.signal))) {
          b.events.push(event);
          if (event.type === "completed" || event.type === "failed") {
            b.done = true;
            b.finishedAt = Date.now();
            break;
          }
          wake();
        }
      } catch (err) {
        (opts.log ?? stderrLog).warn("An agent event stream failed", { error: err instanceof Error ? err.message : String(err) });
      } finally {
        if (!b.done) b.ended = true;
        wake();
      }
    })();
    return b;
  };

  const handlers: Record<string, (p: Record<string, any>, signal: AbortSignal) => Promise<unknown>> = {
    async initialize(p) {
      if (opts.configFromHost) make((p.config ?? {}) as Record<string, string | number>, (p.secrets ?? {}) as Record<string, string>);
      else inst();
      const m = mod.manifest;
      const info: CmpModuleInfo = {
        cmp: CMP_VERSION,
        manifest: {
          id: m.id,
          version: m.version,
          name: m.name,
          description: m.description,
          ports: m.ports,
          docks: m.docks,
          permissions: m.permissions,
          outsideVersions: m.outsideVersions,
          sensitiveActions: m.sensitiveActions,
        },
      };
      return info;
    },
    health: (_p, signal) => inst().health(signal),
    outsideVersion: async (_p, signal) => (await inst().outsideVersion?.(signal)) ?? null,
    discover: async (_p, signal) => (await inst().discover?.(signal)) ?? {},
    "model.listModels": () => port("model").listModels(),
    "model.generate": (p, signal) => port("model").generate(p.req, ctx(p.call, signal)),
    "knowledge.listSources": () => port("knowledge").listSources(),
    "knowledge.search": (p, signal) => port("knowledge").search(p.req as KnowledgeSearchRequest, ctx(p.call, signal)),
    "tool.listTools": () => port("tool").listTools(),
    "tool.call": (p, signal) => port("tool").call(String(p.name), (p.args ?? {}) as Record<string, unknown>, ctx(p.call, signal)),
    "agent.listSkills": () => port("agent").listSkills(),
    async "agent.startRun"(p, signal) {
      const handle = await port("agent").startRun(p.input, ctx(p.call, signal));
      buffer(handle);
      return handle;
    },
    async "agent.events"(p, signal) {
      const b = buffer(p.handle as AgentRunHandle);
      const cursor = Math.max(0, Number(p.cursor) || 0);
      if (cursor >= b.events.length && !b.done && !b.ended) {
        const wait = Math.min(Math.max(0, Number(p.waitMs) || 0), 25_000);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, wait);
          function done() {
            clearTimeout(timer);
            b.waiters.delete(done);
            resolve();
          }
          b.waiters.add(done);
          signal.addEventListener("abort", done, { once: true });
        });
      }
      const page: CmpEventsPage = { events: b.events.slice(cursor), cursor: b.events.length, ...(b.ended ? { ended: true } : {}) };
      return page;
    },
    async "agent.provideInput"(p, signal) {
      await port("agent").provideInput(p.handle, String(p.answer ?? ""), ctx(p.call, signal));
      return null;
    },
    async "agent.cancel"(p) {
      const handle = p.handle as AgentRunHandle;
      await port("agent").cancel(handle);
      buffers.get(handle.externalRunId)?.controller.abort();
      return null;
    },
    "workflow.list": () => port("workflow").listWorkflows(),
    "workflow.trigger": (p, signal) =>
      port("workflow").trigger(String(p.workflowId), p.input ?? {}, { ...ctx(p.call, signal), ...(typeof p.callbackUrl === "string" ? { callbackUrl: p.callbackUrl } : {}) }),
    // A module that cannot be polled says "still running"; its result comes by callback.
    "workflow.poll": async (p, signal) => {
      const wf = port("workflow");
      return wf.poll ? wf.poll(p.execution, ctx(p.call, signal)) : { state: "running" };
    },
    async "workflow.callback"(p) {
      const wf = port("workflow");
      if (!wf.callback) throw new NodeCallError("invalid_request", `${mod.manifest.name} does not take callbacks.`, false);
      return wf.callback(p.execution, p.body, (p.headers ?? {}) as Record<string, string>);
    },
    async "workflow.cancel"(p) {
      await port("workflow").cancel?.(p.execution);
      return null;
    },
  };

  return {
    async handle(method, params, signal) {
      const fn = handlers[method];
      if (!fn) throw new NodeCallError("not_found", `Unknown CMP method "${method}".`, false);
      return fn((params ?? {}) as Record<string, any>, signal);
    },
    async close() {
      clearInterval(sweeper);
      for (const b of buffers.values()) b.controller.abort();
      await instance?.close?.();
    },
  };
}

function blankCall(): NodeCall {
  return {
    callId: "",
    runId: "",
    parentCallId: null,
    depth: 0,
    nodeId: "",
    input: {},
    budget: { usd: 0 },
    permissions: [],
    trace: { traceparent: "" },
    idempotencyKey: "",
  };
}

// ------------------------------------------------- a two-way line channel

/**
 * JSON-RPC over a line channel (stdio, or a bridge socket): either side may
 * call the other. Requests can be cancelled with $/cancel.
 */
export class CmpPeer {
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private readonly incoming = new Map<number | string, AbortController>();
  private closed = false;

  constructor(
    private readonly write: (line: string) => void,
    private readonly onRequest?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>,
    private readonly onNotify?: (method: string, params: unknown) => void,
  ) {}

  receive(line: string): void {
    let msg: CmpMessage;
    try {
      msg = JSON.parse(line) as CmpMessage;
    } catch {
      return;
    }
    if (!msg || msg.jsonrpc !== "2.0") return;
    if ("method" in msg) {
      if (msg.method === "$/cancel") {
        this.incoming.get((msg.params as { id: number | string })?.id)?.abort();
        return;
      }
      if (!("id" in msg)) return this.onNotify?.(msg.method, msg.params);
      const req = msg as CmpRequest;
      const controller = new AbortController();
      this.incoming.set(req.id, controller);
      const run = this.onRequest ? this.onRequest(req.method, req.params, controller.signal) : Promise.reject(new NodeCallError("not_found", `No handler for ${req.method}.`, false));
      run.then(
        (result) => this.send({ jsonrpc: "2.0", id: req.id, result: result ?? null }),
        (err) => this.send({ jsonrpc: "2.0", id: req.id, error: encodeError(err) }),
      ).finally(() => this.incoming.delete(req.id));
      return;
    }
    const waiting = this.pending.get(msg.id);
    if (!waiting) return;
    this.pending.delete(msg.id);
    if (msg.error) waiting.reject(decodeError(msg.error));
    else waiting.resolve(msg.result);
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new NodeCallError("unavailable", "The module connection is closed.", true));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        this.send({ jsonrpc: "2.0", method: "$/cancel", params: { id } });
        reject(signal!.reason instanceof Error ? signal!.reason : new NodeCallError("cancelled", "The call was cancelled.", false));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(reason = "The module connection closed."): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new NodeCallError("unavailable", reason, true));
    this.pending.clear();
    for (const c of this.incoming.values()) c.abort();
    this.incoming.clear();
  }

  private send(msg: CmpMessage): void {
    if (!this.closed) this.write(JSON.stringify(msg));
  }
}

// ------------------------------------------------------------- host.fetch

export interface FetchRequestBody {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export interface FetchResponseBody {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch for a module that runs over stdio: requests go through the host, which applies its egress allow-list. */
export function fetchThroughHost(peer: CmpPeer): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.body ? Buffer.from(await req.arrayBuffer()).toString("base64") : undefined;
    const res = (await peer.request(
      "host.fetch",
      { url: req.url, method: req.method, headers: Object.fromEntries(req.headers), ...(body ? { body } : {}) } satisfies FetchRequestBody,
      init?.signal ?? undefined,
    )) as FetchResponseBody;
    const nullBody = [101, 204, 205, 304].includes(res.status);
    return new Response(nullBody ? null : Buffer.from(res.body ?? "", "base64"), { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

/** Carry out a module's host.fetch with the host's own (egress-checked) fetch. Bodies are buffered, up to 10 MB. */
export async function performFetch(fetcher: typeof fetch, req: FetchRequestBody, signal?: AbortSignal): Promise<FetchResponseBody> {
  const res = await fetcher(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body && req.method !== "GET" && req.method !== "HEAD" ? { body: Buffer.from(req.body, "base64") } : {}),
    ...(signal ? { signal } : {}),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BODY) throw new NodeCallError("invalid_request", "The response is larger than 10 MB.", false);
  return { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), body: buf.toString("base64") };
}

// ------------------------------------------------------------------ stdio

/**
 * Serve a module over stdin/stdout (sidecar dock, Local Bridge targets).
 * Settings arrive in initialize. stdout carries protocol messages only, so
 * console.log is sent to stderr; ctx.fetch goes through the host.
 */
export function serveStdio(mod: ConclaveModule): { close(): Promise<void> } {
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  let dispatcher: CmpDispatcher | null = null;
  const peer = new CmpPeer(
    (line) => process.stdout.write(`${line}\n`),
    (method, params, signal) => dispatcher!.handle(method, params, signal),
  );
  const log: ModuleLogger = {
    info: (msg, data) => peer.notify("host.log", { level: "info", msg, data }),
    warn: (msg, data) => peer.notify("host.log", { level: "warn", msg, data }),
  };
  dispatcher = createDispatcher(mod, { configFromHost: true, fetch: fetchThroughHost(peer), log });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => peer.receive(line));
  rl.on("close", () => {
    peer.close();
    void dispatcher!.close().finally(() => process.exit(0));
  });
  return {
    async close() {
      rl.close();
    },
  };
}

export interface SpawnOptions {
  /** Environment for the process. Nothing from Conclave's own environment is passed unless listed here. */
  env?: Record<string, string>;
  cwd?: string;
  /** The module's host.fetch calls; refuse what its allow-list does not cover. */
  onFetch?: (req: FetchRequestBody, signal: AbortSignal) => Promise<FetchResponseBody>;
  log?: ModuleLogger;
  /** Most time one call may take. */
  timeoutMs?: number;
}

/** Split a command line into the program and its arguments; quotes group, nothing else is interpreted (no shell). */
export function parseCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  // Inside double quotes only \" and \\ are escapes, so Windows paths keep their backslashes.
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : (m[2] ?? m[3]!));
  return out;
}

/**
 * Start a module process and talk CMP to it over stdio. It is started on the
 * first call, started again after a crash (backing off when it keeps
 * crashing), and stopped by close().
 */
export function spawnClient(argv: string[], opts: SpawnOptions = {}): CmpClient {
  if (!argv.length) throw new NodeCallError("invalid_request", "No command to start the module with.", false);
  let child: ChildProcess | null = null;
  let peer: CmpPeer | null = null;
  let crashes: number[] = [];
  let closing = false;
  const log = opts.log ?? stderrLog;

  const start = (): CmpPeer => {
    if (peer && child && child.exitCode === null) return peer;
    crashes = crashes.filter((t) => Date.now() - t < 60_000);
    if (crashes.length >= 5) throw new NodeCallError("unavailable", "The module process keeps stopping; it was crashing on start.", true);
    const proc = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env ?? {}, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    const p = new CmpPeer(
      (line) => proc.stdin?.write(`${line}\n`),
      async (method, params, signal) => {
        if (method !== "host.fetch") throw new NodeCallError("not_found", `The host does not offer ${method}.`, false);
        if (!opts.onFetch) throw new NodeCallError("refused", "This module may not reach the network.", false);
        return opts.onFetch(params as FetchRequestBody, signal);
      },
      (method, params) => {
        if (method !== "host.log") return;
        const { level, msg, data } = (params ?? {}) as { level?: string; msg?: string; data?: Record<string, unknown> };
        (level === "warn" ? log.warn : log.info)(String(msg ?? ""), data);
      },
    );
    createInterface({ input: proc.stdout!, crlfDelay: Infinity }).on("line", (line) => p.receive(line));
    createInterface({ input: proc.stderr!, crlfDelay: Infinity }).on("line", (line) => log.info(line.slice(0, 2_000)));
    proc.on("error", (err) => {
      log.warn(`Could not start ${argv[0]}: ${err.message}`);
      p.close(`Could not start the module: ${err.message}`);
    });
    proc.on("exit", (code, sig) => {
      p.close(`The module process stopped (${sig ?? `exit code ${code}`}).`);
      if (!closing) crashes.push(Date.now());
      if (peer === p) {
        peer = null;
        child = null;
      }
    });
    child = proc;
    peer = p;
    return p;
  };

  return {
    request(method, params, signal) {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 300_000);
      const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
      return start()
        .request(method, params, both)
        .catch((err) => {
          if (timeout.aborted && !signal?.aborted) throw new NodeCallError("timeout", `The module did not answer ${method} in time.`, true);
          throw err;
        });
    },
    async close() {
      closing = true;
      const proc = child;
      peer?.close();
      if (!proc || proc.exitCode !== null) return;
      proc.stdin?.end();
      const killed = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      const force = setTimeout(() => proc.kill("SIGKILL"), 3_000);
      proc.kill("SIGTERM");
      await killed;
      clearTimeout(force);
    },
  };
}

// ------------------------------------------------------------------- HTTP

const sign = (secret: string, ts: string, nonce: string, body: string) => createHmac("sha256", secret).update(`${ts}.${nonce}.${body}`).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Secrets shorter than this are refused: the signature is only as strong as the secret. */
export const MIN_SECRET_LENGTH = 32;

function checkSecret(secret: string): void {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new NodeCallError("invalid_request", `The signing secret must be at least ${MIN_SECRET_LENGTH} characters.`, false);
}

// Key-signed requests (CMP auth v2). Each request is its own credential: signed
// by the host's Ed25519 key, good for five minutes, usable once, and bound to
// the one module address it was made for. Neither side stores a shared secret.

/** Signs as this Conclave server. The public key is what a module is given to trust it. */
export interface CmpSigner {
  /** Base64 of the SPKI DER public key (Ed25519). */
  publicKey: string;
  /** Base64 signature over the message. */
  sign(message: string): string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const publicKeyOf = (key: KeyObject): string => createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");

/** A signer from an Ed25519 private key. */
export function ed25519Signer(key: KeyObject): CmpSigner {
  return { publicKey: publicKeyOf(key), sign: (message) => signWithKey(null, Buffer.from(message), key).toString("base64") };
}

function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verifyWithKey(null, Buffer.from(message), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** The address a request is for, as both sides write it: no query, no fragment, no trailing slash. */
export const cmpAudience = (url: string): string => {
  const u = new URL(url);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
};
const requestMessage = (ts: string, nonce: string, audience: string, body: string) => `cmp2\n${ts}\n${nonce}\n${audience}\n${sha256(body)}`;
const answerMessage = (ts: string, nonce: string, body: string) => `cmp2-answer\n${ts}\n${nonce}\n${sha256(body)}`;

export interface ServeHttpOptions {
  /**
   * Shared with the Conclave connection; signs every request and answer.
   * Give two while changing it: both are accepted, and answers use the one
   * the request was signed with, so neither side has to switch at the same moment.
   */
  secret?: string | string[];
  /**
   * Public keys of the Conclave servers this module answers to (base64 SPKI,
   * Ed25519), as shown on the server's Remote module form. With these, no
   * secret is needed.
   */
  hostKeys?: string[];
  /** This module's public address. When set, a request signed for any other address is refused. */
  audience?: string;
  /** This module's own key for signing answers to key-signed requests. Made at start when not given. */
  privateKey?: KeyObject;
  port?: number;
  host?: string;
  path?: string;
  config?: Record<string, string | number | undefined>;
  secrets?: Record<string, string>;
  log?: ModuleLogger;
}

/**
 * Serve a module over HTTP for the remote dock. Every request must be signed,
 * be less than 5 minutes old and not seen before; every answer is signed too.
 * Requests are signed either with a shared secret (HMAC-SHA256 over timestamp,
 * nonce and body) or with a Conclave server's key (Ed25519 over timestamp,
 * nonce, this module's address and the body's hash). Put it behind HTTPS.
 */
export async function serveHttp(mod: ConclaveModule, opts: ServeHttpOptions): Promise<{ server: Server; url: string; publicKey: string; close(): Promise<void> }> {
  const secrets = (Array.isArray(opts.secret) ? opts.secret : opts.secret ? [opts.secret] : []).filter(Boolean);
  const hostKeys = (opts.hostKeys ?? []).filter(Boolean);
  if (!secrets.length && !hostKeys.length) throw new NodeCallError("invalid_request", "Give the module a signing secret, or the public key of the Conclave server it answers to.", false);
  for (const secret of secrets) checkSecret(secret);
  const ownKey = opts.privateKey ?? generateKeyPairSync("ed25519").privateKey;
  const own = ed25519Signer(ownKey);
  const audience = opts.audience ? cmpAudience(opts.audience) : null;
  const path = opts.path ?? "/cmp";
  const dispatcher = createDispatcher(mod, {
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  const seen = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const signature = String(req.headers["x-cmp-signature"] ?? "");
    const keyed = signature.startsWith("ed25519=") || !secrets.length;
    // The secret a request was signed with, once known; answers use the same one.
    let secret = secrets[0] ?? "";
    const reply = (status: number, body: string, nonce = "") => {
      const ts = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = keyed
        ? { "x-cmp-signature": `ed25519=${own.sign(answerMessage(ts, nonce, body))}`, "x-cmp-key": own.publicKey }
        : { "x-cmp-signature": `v1=${sign(secret, ts, nonce, body)}` };
      res.writeHead(status, { "content-type": "application/json", "x-cmp-timestamp": ts, ...headers });
      res.end(body);
    };
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== path) return reply(404, JSON.stringify({ error: "Not found" }));
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      return reply(413, JSON.stringify({ error: "Too large" }));
    }
    const ts = String(req.headers["x-cmp-timestamp"] ?? "");
    const nonce = String(req.headers["x-cmp-nonce"] ?? "");
    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (!/^\d+$/.test(ts) || !(age < 300) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return reply(401, JSON.stringify({ error: "Bad signature" }));
    if (signature.startsWith("ed25519=")) {
      const claimed = String(req.headers["x-cmp-audience"] ?? "");
      // A request made for another module must not work here, even from a server this module trusts.
      if (audience && claimed !== audience) return reply(401, JSON.stringify({ error: "Signed for another address" }));
      const message = requestMessage(ts, nonce, claimed, body);
      if (!claimed || !hostKeys.some((key) => verifyEd25519(key, message, signature.slice("ed25519=".length)))) return reply(401, JSON.stringify({ error: "Bad signature" }));
    } else {
      const used = secrets.find((candidate) => safeEqual(signature, `v1=${sign(candidate, ts, nonce, body)}`));
      if (!used) return reply(401, JSON.stringify({ error: "Bad signature" }));
      secret = used;
    }
    for (const [n, at] of seen) if (Date.now() - at > 600_000) seen.delete(n);
    if (seen.has(nonce)) return reply(401, JSON.stringify({ error: "Replayed request" }), nonce);
    seen.set(nonce, Date.now());

    let msg: CmpRequest;
    try {
      msg = JSON.parse(body) as CmpRequest;
    } catch {
      return reply(400, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), nonce);
    }
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const result = await dispatcher.handle(msg.method, msg.params, controller.signal);
      reply(200, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: result ?? null }), nonce);
    } catch (err) {
      reply(200, JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: encodeError(err) }), nonce);
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    server,
    url: `http://${opts.host ?? "127.0.0.1"}:${port}${path}`,
    publicKey: own.publicKey,
    async close() {
      await dispatcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** Plain http is only for a module on the same machine. */
export const isLoopback = (url: URL): boolean => LOOPBACK.has(url.hostname) || url.hostname.endsWith(".localhost");

/** How the host proves itself to a remote module: a shared secret, or this server's own key. */
export type CmpAuth = string | { signer: CmpSigner; /** The module's public key, when pinned: answers signed by any other key are refused. */ moduleKey?: string };

/** Talk CMP to a remote module over signed HTTP. Answers must carry a valid signature for the request they answer. */
export function httpClient(url: string, auth: CmpAuth, fetcher: typeof fetch = fetch): CmpClient {
  let nextId = 1;
  const keyed = typeof auth === "string" ? null : auth;
  return {
    async request(method, params, signal) {
      if (!keyed) checkSecret(auth as string);
      const target = new URL(url);
      if (target.protocol !== "https:" && !(target.protocol === "http:" && isLoopback(target))) {
        throw new NodeCallError("invalid_request", "A remote module must be reached over https (plain http only on this machine).", false);
      }
      const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(18).toString("base64url");
      const audience = cmpAudience(url);
      const proof: Record<string, string> = keyed
        ? { "x-cmp-signature": `ed25519=${keyed.signer.sign(requestMessage(ts, nonce, audience, body))}`, "x-cmp-audience": audience }
        : { "x-cmp-signature": `v1=${sign(auth as string, ts, nonce, body)}` };
      let res: Response;
      try {
        res = await fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-cmp-timestamp": ts, "x-cmp-nonce": nonce, ...proof },
          body,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(method === "agent.events" ? LONG_POLL_MS + 15_000 : 300_000)]) : AbortSignal.timeout(300_000),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new NodeCallError("unavailable", `Could not reach the module: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      const text = await res.text();
      const rts = res.headers.get("x-cmp-timestamp") ?? "";
      const answered = res.headers.get("x-cmp-signature") ?? "";
      const fresh = Math.abs(Date.now() / 1000 - Number(rts)) < 300;
      const answerNonce = res.status === 404 ? "" : nonce;
      let signed: boolean;
      if (keyed) {
        const theirs = res.headers.get("x-cmp-key") ?? "";
        if (keyed.moduleKey && theirs !== keyed.moduleKey && answered.startsWith("ed25519=")) {
          throw new NodeCallError("auth", "The module answered with a different key than the one pinned on this connection. If the module was reinstalled, update its key here.", false);
        }
        signed = answered.startsWith("ed25519=") && verifyEd25519(keyed.moduleKey || theirs, answerMessage(rts, answerNonce, text), answered.slice("ed25519=".length));
      } else {
        signed = safeEqual(answered, `v1=${sign(auth as string, rts, answerNonce, text)}`);
      }
      if (!signed || !fresh) {
        if (res.status === 401) {
          throw new NodeCallError(
            "auth",
            keyed
              ? "The module refused this server's key. Give the module this server's public key and check its address and that the clocks agree."
              : "The module refused the signature. Check that both sides use the same secret and that the clocks agree.",
            false,
          );
        }
        throw new NodeCallError("auth", `The module's answer was not signed ${keyed ? "with its key" : "with the shared secret"} (HTTP ${res.status}).`, false);
      }
      if (res.status === 401) {
        throw new NodeCallError("auth", keyed ? "The module refused this server's key, or the request was signed for another address." : "The module refused the signature.", false);
      }
      if (!res.ok) throw new NodeCallError(res.status >= 500 ? "unavailable" : "invalid_request", `The module answered HTTP ${res.status}.`, res.status >= 500);
      const msg = JSON.parse(text) as CmpResponse;
      if (msg.error) throw decodeError(msg.error);
      return msg.result;
    },
    async close() {},
  };
}

// ------------------------------------------------- the host-side instance

const PORT_NOUN: Record<string, string> = { model: "models", tool: "tools", agent: "agents", workflow: "workflows", knowledge: "knowledge" };

/**
 * A ModuleInstance whose ports are served by a module over CMP. The ports the
 * module really provides are known after initialize; calling one it lacks
 * fails with a clear message.
 */
export function cmpInstance(
  client: CmpClient,
  init: { config?: Record<string, unknown>; secrets?: Record<string, string> } = {},
): ModuleInstance & { info(signal?: AbortSignal): Promise<CmpModuleInfo> } {
  let ready: Promise<CmpModuleInfo> | null = null;
  const ports: ModuleInstance["ports"] = {};
  const info = (signal?: AbortSignal) =>
    (ready ??= (client.request("initialize", { cmp: CMP_VERSION, config: init.config ?? {}, secrets: init.secrets ?? {} }, signal) as Promise<CmpModuleInfo>)
      .then((i) => {
        if (!i || typeof i.cmp !== "string" || !i.cmp.startsWith("1.") || !i.manifest?.ports) {
          throw new NodeCallError("invalid_request", `The module does not speak CMP 1.x${i?.cmp ? ` (it said ${i.cmp})` : ""}.`, false);
        }
        // From now on the instance shows only the ports the module provides.
        for (const name of ["model", "tool", "agent", "workflow", "knowledge"] as const) if (!i.manifest.ports.some((p) => p.startsWith(`${name}@`))) delete ports[name];
        return i;
      })
      .catch((err) => {
        ready = null;
        throw err;
      }));
  const call = async (port: PortName, method: string, params: unknown, signal?: AbortSignal) => {
    const i = await info(signal);
    if (!i.manifest.ports.some((p) => p.startsWith(`${port}@`))) throw new NodeCallError("invalid_request", `${i.manifest.name} does not provide ${PORT_NOUN[port]}.`, false);
    return client.request(method, params, signal);
  };

  Object.assign(ports, {
      model: {
        listModels: () => call("model", "model.listModels", {}) as never,
        generate: (req, ctx) => call("model", "model.generate", { req, call: ctx.call }, ctx.signal) as never,
      },
      knowledge: {
        listSources: () => call("knowledge", "knowledge.listSources", {}) as never,
        search: (req, ctx) => call("knowledge", "knowledge.search", { req, call: ctx.call }, ctx.signal) as never,
      },
      tool: {
        listTools: () => call("tool", "tool.listTools", {}) as never,
        call: (name, args, ctx) => call("tool", "tool.call", { name, args, call: ctx.call }, ctx.signal) as never,
      },
      agent: {
        listSkills: () => call("agent", "agent.listSkills", {}) as never,
        startRun: (input, ctx) => call("agent", "agent.startRun", { input, call: ctx.call }, ctx.signal) as never,
        async *streamEvents(handle, ctx) {
          let cursor = 0;
          while (!ctx.signal.aborted) {
            const page = (await call("agent", "agent.events", { handle, cursor, waitMs: LONG_POLL_MS }, ctx.signal)) as CmpEventsPage;
            for (const event of page.events) {
              yield event;
              if (event.type === "completed" || event.type === "failed") return;
            }
            cursor = page.cursor;
            if (page.ended) return;
          }
        },
        provideInput: async (handle, answer, ctx) => void (await call("agent", "agent.provideInput", { handle, answer, call: ctx.call }, ctx.signal)),
        cancel: async (handle) => void (await call("agent", "agent.cancel", { handle })),
      },
      workflow: {
        listWorkflows: () => call("workflow", "workflow.list", {}) as never,
        trigger: (workflowId, input, ctx) =>
          call("workflow", "workflow.trigger", { workflowId, input, call: ctx.call, ...(ctx.callbackUrl ? { callbackUrl: ctx.callbackUrl } : {}) }, ctx.signal) as never,
        poll: (execution, ctx) => call("workflow", "workflow.poll", { execution, call: ctx.call }, ctx.signal) as never,
        callback: (execution, body, headers) => call("workflow", "workflow.callback", { execution, body, headers }) as never,
        cancel: async (execution) => void (await call("workflow", "workflow.cancel", { execution })),
      },
  } satisfies ModuleInstance["ports"]);

  return {
    info,
    ports,
    async health(signal) {
      try {
        const i = await info(signal);
        const h = (await client.request("health", {}, signal)) as { status: string; detail: string };
        return { status: h.status as never, detail: `${i.manifest.name} ${i.manifest.version}: ${h.detail}` };
      } catch (err) {
        const e = toNodeError(err);
        return { status: e.code === "auth" ? "signed_out" : "unreachable", detail: e.message };
      }
    },
    outsideVersion: async (signal) => (await client.request("outsideVersion", {}, signal)) as string | null,
    async dockedModule(signal) {
      const m = (await info(signal)).manifest;
      return { id: m.id, version: m.version, name: m.name, description: m.description, ports: m.ports, permissions: { egress: m.permissions?.egress ?? [], secrets: m.permissions?.secrets ?? [] } };
    },
    discover: async (signal) => (await client.request("discover", {}, signal)) as never,
    close: () => client.close(),
  };
}

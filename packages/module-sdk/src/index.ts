import { NodeCallError, type ConnectionStatus, type PortImplementations, type PortName } from "@conclave/contract";
import { manifestSchema, type ModuleManifest, type ModuleManifestInput } from "./manifest";

export * from "./manifest";
export * from "./cmp";
export * from "./bridge-protocol";

export interface ModuleLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

/** What a module receives when Conclave creates an instance for one connection. */
export interface ModuleContext {
  /** Non-secret config values, defaults applied. */
  config: Record<string, string | number | undefined>;
  /** Decrypted secrets for this connection only, for the length of the instance (MOD-009). */
  secrets: Record<string, string>;
  /** Egress-checked fetch. Modules must use it instead of the global fetch. */
  fetch: typeof fetch;
  log: ModuleLogger;
  /** The connection this instance serves. Docks use it to keep to the connection's organisation. */
  connection?: { id: string; orgId: string };
}

export interface HealthResult {
  status: ConnectionStatus;
  detail: string;
}

export interface Capabilities {
  models?: { id: string; displayName?: string }[];
  tools?: { name: string }[];
  skills?: { id: string; name?: string }[];
  workflows?: { id: string; name?: string }[];
  sources?: { id: string; name?: string }[];
}

/** What a dock found out about the module it runs (remote, sidecar and bridge docks). */
export interface DockedModuleInfo {
  id: string;
  version: string;
  name: string;
  description: string;
  ports: string[];
  permissions: { egress: string[]; secrets: string[] };
}

/** A live module instance, bound to one connection. */
export interface ModuleInstance {
  ports: PortImplementations;
  health(signal?: AbortSignal): Promise<HealthResult>;
  /** The outside system's version, when it reports one (CON-007). */
  outsideVersion?(signal?: AbortSignal): Promise<string | null>;
  discover?(signal?: AbortSignal): Promise<Capabilities>;
  /** Docks only: the manifest of the module behind the dock. */
  dockedModule?(signal?: AbortSignal): Promise<DockedModuleInfo>;
  close?(): Promise<void>;
}

export interface ConclaveModule {
  manifest: ModuleManifest;
  create(ctx: ModuleContext): ModuleInstance;
}

/** Declare a module. Validates the manifest so mistakes surface at load time. */
export function defineModule(def: { manifest: ModuleManifestInput; create(ctx: ModuleContext): ModuleInstance }): ConclaveModule {
  const manifest = manifestSchema.parse(def.manifest);
  return { manifest, create: def.create };
}

/** Ports the manifest declares, without versions. */
export function declaredPorts(manifest: ModuleManifest): PortName[] {
  return manifest.ports.map((ref) => ref.split("@")[0] as PortName);
}

/** Map an outside system's HTTP failure to a contract error, so retries behave the same everywhere. */
export function httpError(status: number, message: string): NodeCallError {
  if (status === 401 || status === 403) return new NodeCallError("auth", message, false);
  if (status === 404) return new NodeCallError("not_found", message, false);
  if (status === 408 || status === 504) return new NodeCallError("timeout", message, true);
  if (status === 429) return new NodeCallError("rate_limited", message, true);
  if (status >= 500) return new NodeCallError("unavailable", message, true);
  return new NodeCallError("invalid_request", message, false);
}

/** Health status matching a contract error code. */
export function statusForError(err: unknown): HealthResult {
  if (err instanceof NodeCallError) {
    const map: Record<string, ConnectionStatus> = {
      auth: "signed_out",
      rate_limited: "rate_limited",
      unavailable: "unreachable",
      timeout: "unreachable",
    };
    return { status: map[err.code] ?? "unreachable", detail: err.message };
  }
  return { status: "unreachable", detail: err instanceof Error ? err.message : String(err) };
}

/** Read a required config string or fail with a clear message. */
export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new NodeCallError("invalid_request", `${label} is not set on this connection.`, false);
  }
  return value.trim();
}

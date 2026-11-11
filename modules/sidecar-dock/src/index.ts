import { NodeCallError } from "@conclave/contract";
import { cmpInstance, defineModule, parseCommand, performFetch, requireString, spawnClient, type ConclaveModule } from "@conclave/module-sdk";

export interface SidecarOptions {
  /**
   * Commands this server may start, exactly as typed on a connection, or "*"
   * for any. Empty turns sidecars off: starting a process on the server is the
   * server admin's decision, not an org admin's.
   */
  allowed: string[];
}

const normalise = (command: string) => parseCommand(command).join(" ");

/** Environment a sidecar gets: enough to start, nothing of Conclave's own (no keys, no database URL). */
function sidecarEnv(): Record<string, string> {
  const keep = ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "LANG", "TZ"];
  const env: Record<string, string> = { CONCLAVE_CMP: "1", NODE_ENV: "production" };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

function parseJson(value: string | undefined, label: string): Record<string, never> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, never>;
  } catch {
    /* fall through */
  }
  throw new NodeCallError("invalid_request", `${label} must be a JSON object, like {"region": "eu"}.`, false);
}

/**
 * Sidecar dock (SRS 4.11, MOD-003, MOD-010): Conclave starts the module's
 * process and talks to it over stdin/stdout, in any language. The process gets
 * a bare environment, and its network calls go through Conclave, which lets
 * through only the hosts listed on the connection. For full isolation, make
 * the command a container with no network, such as
 * `docker run -i --rm --network none --memory 512m --cpus 1 acme/agent:1.2`:
 * stdio still works, and the module reaches only what the list allows.
 */
export function sidecarDock(opts: SidecarOptions): ConclaveModule {
  const allowed = new Set(opts.allowed.map((c) => (c.trim() === "*" ? "*" : normalise(c))).filter(Boolean));
  return defineModule({
    manifest: {
      id: "conclave/sidecar",
      version: "0.1.0",
      name: "Sidecar module",
      description: "A module process this server starts and looks after, in any language. It can provide agents, workflows, tools or models.",
      ports: ["agent@1", "workflow@1", "tool@1", "model@1", "knowledge@1"],
      docks: ["sidecar"],
      config: [
        {
          key: "command",
          label: "Command",
          type: "string",
          required: true,
          placeholder: "docker run -i --rm --network none acme/agent:1.2",
          help: "Started without a shell. The server admin lists the commands allowed in CONCLAVE_SIDECARS.",
        },
        { key: "settings", label: "Module settings (JSON)", type: "string", help: 'Handed to the module when it starts, like {"region": "eu"}.' },
        { key: "secrets", label: "Module secrets (JSON)", type: "secret", help: "Kept encrypted; handed only to this module." },
        { key: "egress", label: "Hosts it may reach", type: "string", help: "Comma-separated, like api.example.com. Nothing else is reachable." },
        { key: "timeoutSeconds", label: "Most seconds per call", type: "number", default: 300 },
        { key: "pricePerCallUsd", label: "Price per call (USD)", type: "number", default: 0 },
        { key: "pricePerMinuteUsd", label: "Price per minute (USD)", type: "number", default: 0 },
      ],
      permissions: { egress: ["{config.egress[]}"], secrets: ["secrets"] },
      reference: true,
    },
    create(ctx) {
      const command = requireString(ctx.config.command, "Command");
      if (!allowed.has("*") && !allowed.has(normalise(command))) {
        throw new NodeCallError(
          "refused",
          allowed.size === 0
            ? "Sidecars are turned off on this server. The server admin turns them on with CONCLAVE_SIDECARS."
            : "This command is not on the server's list of allowed sidecars (CONCLAVE_SIDECARS).",
          false,
        );
      }
      const client = spawnClient(parseCommand(command), {
        env: sidecarEnv(),
        timeoutMs: (Number(ctx.config.timeoutSeconds) || 300) * 1000,
        log: ctx.log,
        onFetch: (req, signal) => performFetch(ctx.fetch, req, signal),
      });
      return cmpInstance(client, { config: parseJson(String(ctx.config.settings ?? ""), "Module settings"), secrets: parseJson(ctx.secrets.secrets, "Module secrets") });
    },
  });
}

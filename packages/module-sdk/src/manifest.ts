import { z } from "zod";
import { parsePortRef, type PortRef } from "@conclave/contract";

export const dockKinds = ["built-in", "sidecar", "remote", "bridge", "protocol"] as const;
export type DockKind = (typeof dockKinds)[number];

const portRefSchema = z.string().refine(
  (value) => {
    try {
      parsePortRef(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Expected <port>@<major>, for example model@1." },
) as unknown as z.ZodType<PortRef>;

export const configFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string(),
  type: z.enum(["string", "url", "secret", "number"]),
  required: z.boolean().default(false),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  default: z.union([z.string(), z.number()]).optional(),
});
export type ConfigField = z.infer<typeof configFieldSchema>;

/** The module manifest (SRS 4.11). The install screen is built from it. */
export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/, "Module ids look like publisher/name."),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "Versions are semver, e.g. 1.4.0."),
  name: z.string().min(1),
  description: z.string().default(""),
  ports: z.array(portRefSchema).min(1),
  docks: z.array(z.enum(dockKinds)).min(1),
  config: z.array(configFieldSchema).default([]),
  permissions: z
    .object({
      /** Hostnames the module may reach. "{config.<key>}" means the host of that config URL. */
      egress: z.array(z.string()).default([]),
      secrets: z.array(z.string()).default([]),
    })
    .default({ egress: [], secrets: [] }),
  sensitiveActions: z.array(z.string()).default([]),
  /** Supported outside-system versions, e.g. { "anthropic-api": "2023-06-01" } (CON-007). */
  outsideVersions: z.record(z.string(), z.string()).default({}),
  nodeUi: z.object({ icon: z.string().optional(), colour: z.string().optional() }).default({}),
  /** First-party reference module. Gets no special treatment in core (MOD-014). */
  reference: z.boolean().default(false),
});
export type ModuleManifest = z.infer<typeof manifestSchema>;
export type ModuleManifestInput = z.input<typeof manifestSchema>;

/** Config fields typed "secret" are stored encrypted and never returned to clients. */
export function secretKeys(manifest: ModuleManifest): string[] {
  return manifest.config.filter((f) => f.type === "secret").map((f) => f.key);
}

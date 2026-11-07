import { newId, type ConnectionDto, type ConnectionStatus, type ConnectionTestDto, type ModelInfo, type ToolInfo } from "@conclave/contract";
import { iso, json, num, type Db, type Queryable } from "@conclave/db";
import type { ModuleInstance } from "@conclave/module-sdk";
import { invalid, notFound, type Actor } from "./errors";
import { egressFetch, ModuleRuntime, type ModuleRegistry } from "./modules";
import type { SecretVault } from "./secrets";

interface ConnectionRow {
  id: string;
  org_id: string;
  name: string;
  module_id: string;
  module_version: string;
  dock: string;
  config: Record<string, string | number>;
  secret_id: string | null;
  secret_keys: string[];
  status: ConnectionStatus;
  status_detail: string | null;
  spend_limit_usd: string | number | null;
  last_checked_at: Date | null;
  disabled_at: Date | null;
  created_at: Date;
  month_spend?: string | number;
  used_by?: { workspaceId: string; workspaceName: string }[] | null;
}

/** Monthly spend and the workspaces whose roles use each connection. */
const CONNECTION_SELECT = `select c.*,
  coalesce((select sum(u.cost_usd) from usage_ledger u where u.connection_id = c.id and u.at >= date_trunc('month', now())), 0) as month_spend,
  (select coalesce(jsonb_agg(distinct jsonb_build_object('workspaceId', w.id, 'workspaceName', w.name)), '[]'::jsonb)
     from roles r join workspaces w on w.id = r.workspace_id where r.connection_id = c.id and w.archived_at is null) as used_by
  from connections c`;

export interface ConnectionInput {
  moduleId: string;
  name: string;
  /** Config values; fields typed "secret" are split off and encrypted. */
  values: Record<string, unknown>;
  spendLimitUsd?: number | null;
}

function toDto(row: ConnectionRow): ConnectionDto {
  return {
    monthSpendUsd: num(row.month_spend),
    usedBy: row.used_by ?? [],
    id: row.id,
    name: row.name,
    moduleId: row.module_id,
    moduleVersion: row.module_version,
    dock: row.dock,
    config: row.config,
    secretKeys: row.secret_keys,
    status: row.disabled_at ? "unreachable" : row.status,
    statusDetail: row.disabled_at ? "Disabled by the kill switch." : row.status_detail,
    spendLimitUsd: row.spend_limit_usd === null ? null : num(row.spend_limit_usd),
    lastCheckedAt: iso(row.last_checked_at),
    createdAt: iso(row.created_at)!,
  };
}

export class Connections {
  readonly runtime = new ModuleRuntime();
  private readonly db: Db;
  private readonly registry: ModuleRegistry;
  private readonly vault: SecretVault;
  private readonly baseFetch: typeof fetch;

  constructor(db: Db, registry: ModuleRegistry, vault: SecretVault, baseFetch: typeof fetch = fetch) {
    this.db = db;
    this.registry = registry;
    this.vault = vault;
    this.baseFetch = baseFetch;
  }

  async list(actor: Actor): Promise<ConnectionDto[]> {
    const rows = await this.db.query<ConnectionRow>(`${CONNECTION_SELECT} where c.org_id = $1 order by c.created_at`, [actor.orgId]);
    return rows.map(toDto);
  }

  private async row(q: Queryable, actor: Actor, id: string): Promise<ConnectionRow> {
    const rows = await q.query<ConnectionRow>(`${CONNECTION_SELECT} where c.id = $1 and c.org_id = $2`, [id, actor.orgId]);
    const row = rows[0];
    if (!row) throw notFound("Connection");
    return row;
  }

  async get(actor: Actor, id: string): Promise<ConnectionDto> {
    return toDto(await this.row(this.db, actor, id));
  }

  /** Split and validate values against the module's config schema. */
  private parseValues(moduleId: string, values: Record<string, unknown>, partial: boolean) {
    const manifest = this.registry.get(moduleId).manifest;
    const config: Record<string, string | number> = {};
    const secrets: Record<string, string> = {};
    const errors: string[] = [];
    const known = new Set(manifest.config.map((f) => f.key));
    for (const key of Object.keys(values)) if (!known.has(key)) errors.push(`Unknown setting "${key}".`);

    for (const field of manifest.config) {
      const raw = values[field.key];
      const empty = raw === undefined || raw === null || raw === "";
      if (empty) {
        if (field.required && !partial) errors.push(`${field.label} is required.`);
        else if (!partial && field.default !== undefined && field.type !== "secret") config[field.key] = field.default;
        continue;
      }
      if (field.type === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) errors.push(`${field.label} must be a number.`);
        else config[field.key] = n;
      } else if (field.type === "url") {
        try {
          const url = new URL(String(raw));
          if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
          config[field.key] = String(raw).trim();
        } catch {
          errors.push(`${field.label} must be an http or https URL.`);
        }
      } else if (field.type === "secret") {
        secrets[field.key] = String(raw);
      } else {
        config[field.key] = String(raw).trim();
      }
    }
    if (errors.length > 0) throw invalid(errors);
    return { manifest, config, secrets };
  }

  async create(actor: Actor, input: ConnectionInput): Promise<ConnectionDto> {
    if (!input.name?.trim()) throw invalid(["Name is required."]);
    if (!this.registry.has(input.moduleId)) throw invalid([`Module "${input.moduleId}" is not installed.`]);
    const { manifest, config, secrets } = this.parseValues(input.moduleId, input.values ?? {}, false);
    const id = newId();
    await this.db.tx(async (q) => {
      const secretId = Object.keys(secrets).length > 0 ? await this.vault.store(q, actor.orgId, secrets) : null;
      await q.query(
        `insert into connections (id, org_id, name, module_id, module_version, dock, config, secret_id, secret_keys, spend_limit_usd)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)`,
        [
          id,
          actor.orgId,
          input.name.trim(),
          manifest.id,
          manifest.version,
          manifest.docks[0],
          json(config),
          secretId,
          json(Object.keys(secrets)),
          input.spendLimitUsd ?? null,
        ],
      );
      await audit(q, actor, "connection.created", id, { module: manifest.id });
    });
    return this.get(actor, id);
  }

  async update(actor: Actor, id: string, patch: Partial<ConnectionInput>): Promise<ConnectionDto> {
    await this.db.tx(async (q) => {
      const row = await this.row(q, actor, id);
      if (patch.values) {
        const { config, secrets } = this.parseValues(row.module_id, patch.values, true);
        const merged = { ...row.config, ...config };
        let secretId = row.secret_id;
        let secretKeys = row.secret_keys;
        if (Object.keys(secrets).length > 0) {
          const current = secretId ? await this.vault.reveal(q, secretId) : {};
          const next = { ...current, ...secrets };
          if (secretId) await this.vault.replace(q, secretId, next);
          else secretId = await this.vault.store(q, actor.orgId, next);
          secretKeys = Object.keys(next);
        }
        await q.query(`update connections set config = $2::jsonb, secret_id = $3, secret_keys = $4::jsonb, status = 'unknown' where id = $1`, [
          id,
          json(merged),
          secretId,
          json(secretKeys),
        ]);
      }
      if (patch.name !== undefined) await q.query(`update connections set name = $2 where id = $1`, [id, patch.name.trim()]);
      if (patch.spendLimitUsd !== undefined) await q.query(`update connections set spend_limit_usd = $2 where id = $1`, [id, patch.spendLimitUsd]);
      await audit(q, actor, "connection.updated", id, {});
    });
    this.runtime.evict(id);
    return this.get(actor, id);
  }

  /** Kill switch (CON-009): new calls stop at once; steps fail over or pause. */
  async setDisabled(actor: Actor, id: string, disabled: boolean): Promise<ConnectionDto> {
    await this.db.tx(async (q) => {
      await this.row(q, actor, id);
      await q.query(`update connections set disabled_at = ${disabled ? "now()" : "null"} where id = $1`, [id]);
      await audit(q, actor, disabled ? "connection.disabled" : "connection.enabled", id, {});
    });
    this.runtime.evict(id);
    return this.get(actor, id);
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await this.db.tx(async (q) => {
      await this.row(q, actor, id);
      await q.query(`update roles set connection_id = null where connection_id = $1`, [id]);
      await q.query(`delete from connections where id = $1`, [id]);
      await audit(q, actor, "connection.deleted", id, {});
    });
    this.runtime.evict(id);
  }

  /** A live instance for one call. Secrets are decrypted here and stay inside the instance (MOD-009). */
  async instance(actor: Actor, id: string): Promise<{ instance: ModuleInstance; row: ConnectionDto }> {
    const row = await this.row(this.db, actor, id);
    const stamp = `${row.module_version}:${JSON.stringify(row.config)}:${row.secret_id ?? ""}:${row.secret_keys.join(",")}`;
    const mod = this.registry.get(row.module_id);
    const secrets = row.secret_id ? await this.vault.reveal(this.db, row.secret_id) : {};
    const instance = this.runtime.get(id, stamp, () =>
      mod.create({
        config: row.config,
        secrets,
        fetch: egressFetch(mod.manifest, row.config, this.baseFetch),
        log: {
          info: (msg, data) => console.info(`[module ${mod.manifest.id}] ${msg}`, data ?? ""),
          warn: (msg, data) => console.warn(`[module ${mod.manifest.id}] ${msg}`, data ?? ""),
        },
      }),
    );
    return { instance, row: toDto(row) };
  }

  async models(actor: Actor, id: string): Promise<ModelInfo[]> {
    const { instance } = await this.instance(actor, id);
    return this.runtime.models(id, instance);
  }

  async tools(actor: Actor, id: string): Promise<ToolInfo[]> {
    const { instance } = await this.instance(actor, id);
    return this.runtime.tools(id, instance);
  }

  /** "Test" action (CON-003): checks auth and lists discovered capabilities. */
  async test(actor: Actor, id: string): Promise<ConnectionTestDto> {
    let result: ConnectionTestDto;
    try {
      const { instance } = await this.instance(actor, id);
      const health = await instance.health(AbortSignal.timeout(20_000));
      const capabilities = health.status === "working" && instance.discover ? await instance.discover(AbortSignal.timeout(20_000)) : {};
      result = {
        ok: health.status === "working",
        status: health.status,
        detail: health.detail,
        capabilities: { ...(capabilities.models ? { models: capabilities.models } : {}), ...(capabilities.tools ? { tools: capabilities.tools } : {}) },
      };
    } catch (err) {
      result = { ok: false, status: "unreachable", detail: err instanceof Error ? err.message : String(err), capabilities: {} };
    }
    await this.db.query(`update connections set status = $2, status_detail = $3, last_checked_at = now() where id = $1`, [
      id,
      result.status,
      result.detail.slice(0, 500),
    ]);
    return result;
  }

  /** Periodic health check across an org (CON-005). */
  async checkAll(actor: Actor): Promise<void> {
    for (const c of await this.list(actor)) {
      if (c.statusDetail === "Disabled by the kill switch.") continue;
      await this.test(actor, c.id).catch(() => {});
    }
  }
}

export async function audit(q: Queryable, actor: Actor, action: string, target: string, detail: Record<string, unknown>): Promise<void> {
  await q.query(`insert into audit_log (id, org_id, actor, action, target, detail) values ($1, $2, $3, $4, $5, $6::jsonb)`, [
    newId(),
    actor.orgId,
    actor.userId,
    action,
    target,
    json(detail),
  ]);
}

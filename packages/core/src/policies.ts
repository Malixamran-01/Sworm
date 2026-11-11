import type { PolicyDecisionDto, PolicyEffect, PolicyRuleDto, WorkspacePoliciesDto } from "@conclave/contract";
import { newId } from "@conclave/contract";
import type { Db, Queryable } from "@conclave/db";
import { audit } from "./connections";
import { invalid, notFound, type Actor } from "./errors";

/**
 * What tasks may use (SRS 4.12). A rule says a connection, or one tool on it,
 * is allowed, needs a person first ("ask"), or is never used ("deny"). Rules
 * come from three places: the organisation, the workspaces above a task in
 * its nest, and the task's own workspace. Work that is handed down only ever
 * loses permissions: the strictest rule wins.
 */
export interface PolicyRule {
  effect: PolicyEffect;
  connectionId: string;
  /** Null means the whole connection. */
  tool: string | null;
  /** Where the rule comes from, for the sentence shown to people. */
  source: string;
}

export interface PolicyQuestion {
  connectionId: string;
  connectionName: string;
  /** Set for tool calls. */
  tool: string | null;
  /** The tool changes things outside Conclave (SRS 5.1). */
  sensitive: boolean;
  /** A person approved an earlier step of this task that leads here. */
  approvedBefore: boolean;
}

const STRICTNESS: Record<PolicyEffect, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * Decide one call. Pure, so it can be tested on its own.
 *
 * - Within one source, a rule for the tool beats a rule for its connection.
 * - Across sources, the strictest wins.
 * - A sensitive tool that no rule names needs a person first: allowing a
 *   connection does not review the tools that write through it.
 */
export function decide(sources: PolicyRule[][], ask: PolicyQuestion): PolicyDecisionDto {
  let effect: PolicyEffect = "allow";
  let source: string | null = null;
  let toolReviewed = false;
  for (const rules of sources) {
    const forTool = ask.tool ? rules.find((r) => r.connectionId === ask.connectionId && r.tool === ask.tool) : undefined;
    const forConnection = rules.find((r) => r.connectionId === ask.connectionId && r.tool === null);
    if (forTool) toolReviewed = true;
    const rule = forTool ?? forConnection;
    if (rule && STRICTNESS[rule.effect] > STRICTNESS[effect]) {
      effect = rule.effect;
      source = rule.source;
    }
  }
  const what = ask.tool ? `the tool "${ask.tool}" on ${ask.connectionName}` : ask.connectionName;
  if (ask.tool && ask.sensitive && !toolReviewed && effect === "allow") {
    effect = "ask";
    source = null;
  }

  if (effect === "deny") return { effect, allowed: false, source, reason: `${source ?? "A rule"} never lets tasks use ${what}.` };
  if (effect === "ask") {
    const why = source ? `${source} asks for a person's approval before ${what} is used` : `${what} can change things outside Conclave, so a person approves first`;
    if (ask.approvedBefore) return { effect, allowed: true, source, reason: `${why}. A person approved an earlier step of this task.` };
    return {
      effect,
      allowed: false,
      source,
      reason: `${why}. Put an approval step before this one, or allow it in the workspace's Settings.`,
    };
  }
  return { effect, allowed: true, source, reason: source ? `Allowed by ${source}.` : "No rule limits this." };
}

interface PolicyRow {
  id: string;
  workspace_id: string | null;
  connection_id: string;
  tool: string | null;
  effect: PolicyEffect;
  workspace_name?: string | null;
}

const EFFECTS: PolicyEffect[] = ["allow", "ask", "deny"];
export const ORG_SOURCE = "Your organisation";

export class Policies {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** The organisation's rules and a workspace's own, as the two sources `decide` reads. */
  async sourcesFor(q: Queryable, orgId: string, workspaceId: string): Promise<{ org: PolicyRule[]; workspace: PolicyRule[] }> {
    const rows = await q.query<PolicyRow>(
      `select p.id, p.workspace_id, p.connection_id, p.tool, p.effect, w.name as workspace_name
         from policies p left join workspaces w on w.id = p.workspace_id
        where p.org_id = $1 and (p.workspace_id is null or p.workspace_id = $2)`,
      [orgId, workspaceId],
    );
    const rule = (r: PolicyRow): PolicyRule => ({
      effect: r.effect,
      connectionId: r.connection_id,
      tool: r.tool,
      source: r.workspace_id ? `The workspace ${r.workspace_name ?? ""}`.trim() : ORG_SOURCE,
    });
    return { org: rows.filter((r) => !r.workspace_id).map(rule), workspace: rows.filter((r) => r.workspace_id).map(rule) };
  }

  /**
   * What a sub-task inherits: everything its parent inherited, plus the
   * parent workspace's own limits. "Allow" rules are not handed down; only
   * limits travel, so a nest can only get stricter.
   */
  async inheritedFor(q: Queryable, parent: { org_id: string; workspace_id: string; inherited?: { rules?: PolicyRule[] } | null }): Promise<PolicyRule[]> {
    const own = (await this.sourcesFor(q, parent.org_id, parent.workspace_id)).workspace.filter((r) => r.effect !== "allow");
    const seen = new Set<string>();
    return [...(parent.inherited?.rules ?? []), ...own].filter((r) => {
      const key = `${r.connectionId}|${r.tool ?? ""}|${r.effect}|${r.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** A workspace's rules, the organisation's rules that apply to it, and the connections its roles use. */
  async forWorkspace(actor: Actor, workspaceId: string): Promise<WorkspacePoliciesDto> {
    const rows = await this.db.query<PolicyRow>(
      `select id, workspace_id, connection_id, tool, effect from policies where org_id = $1 and (workspace_id is null or workspace_id = $2) order by created_at`,
      [actor.orgId, workspaceId],
    );
    const used = await this.db.query<{ id: string; name: string; module_id: string; port: string; role_name: string; node: string | null }>(
      `select c.id, c.name, c.module_id, r.port, r.name as role_name, r.model as node
         from roles r join connections c on c.id = r.connection_id
        where r.workspace_id = $1 and c.org_id = $2 order by c.name, r.name`,
      [workspaceId, actor.orgId],
    );
    const connections = new Map<string, WorkspacePoliciesDto["connections"][number]>();
    for (const u of used) {
      const entry = connections.get(u.id) ?? { id: u.id, name: u.name, moduleId: u.module_id, roles: [], tools: [] };
      entry.roles.push(u.role_name);
      if (u.port.startsWith("tool@") && u.node && !entry.tools.includes(u.node)) entry.tools.push(u.node);
      connections.set(u.id, entry);
    }
    const dto = (r: PolicyRow): PolicyRuleDto => ({ id: r.id, scope: r.workspace_id ? "workspace" : "org", connectionId: r.connection_id, tool: r.tool, effect: r.effect });
    return { rules: rows.map(dto), connections: [...connections.values()] };
  }

  /** The organisation's own rules. */
  async forOrg(actor: Actor): Promise<PolicyRuleDto[]> {
    const rows = await this.db.query<PolicyRow>(`select id, workspace_id, connection_id, tool, effect from policies where org_id = $1 and workspace_id is null order by created_at`, [
      actor.orgId,
    ]);
    return rows.map((r) => ({ id: r.id, scope: "org" as const, connectionId: r.connection_id, tool: r.tool, effect: r.effect }));
  }

  /**
   * Set or clear one rule. `workspaceId` null sets it for the whole
   * organisation; effect "default" removes the rule.
   */
  async set(actor: Actor, input: { workspaceId: string | null; connectionId: string; tool?: string | null; effect: PolicyEffect | "default" }): Promise<void> {
    const tool = input.tool?.trim() || null;
    if (input.effect !== "default" && !EFFECTS.includes(input.effect)) throw invalid([`Unknown choice "${String(input.effect)}".`]);
    if (tool && tool.length > 200) throw invalid(["That tool name is too long."]);
    await this.db.tx(async (q) => {
      const [conn] = await q.query<{ id: string }>(`select id from connections where id = $1 and org_id = $2`, [input.connectionId, actor.orgId]);
      if (!conn) throw notFound("Connection");
      if (input.workspaceId) {
        const [ws] = await q.query<{ id: string }>(`select id from workspaces where id = $1 and org_id = $2`, [input.workspaceId, actor.orgId]);
        if (!ws) throw notFound("Workspace");
      }
      await q.query(
        `delete from policies where org_id = $1 and connection_id = $2 and coalesce(tool, '') = $3
           and ${input.workspaceId ? "workspace_id = $4" : "workspace_id is null and $4::text is null"}`,
        [actor.orgId, input.connectionId, tool ?? "", input.workspaceId],
      );
      if (input.effect !== "default") {
        await q.query(`insert into policies (id, org_id, workspace_id, connection_id, tool, effect, created_by) values ($1, $2, $3, $4, $5, $6, $7)`, [
          newId(),
          actor.orgId,
          input.workspaceId,
          input.connectionId,
          tool,
          input.effect,
          actor.userId,
        ]);
      }
      await audit(q, actor, "policy.set", input.workspaceId ?? input.connectionId, { connection: input.connectionId, tool, effect: input.effect, scope: input.workspaceId ? "workspace" : "org" });
    });
  }
}

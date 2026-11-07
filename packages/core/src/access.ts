import type { Queryable } from "@conclave/db";
import { ConclaveError, notFound, type Actor } from "./errors";

/**
 * Roles and permissions (ACC-004, ACC-005). Every API call is checked against
 * the caller's role in the org, a per-workspace override if there is one, and,
 * for access tokens, the token's scopes.
 */
export const roles = ["owner", "editor", "runner", "viewer"] as const;
export type Role = (typeof roles)[number];

export const permissions = [
  "workspace:read",
  "task:run",
  "approval:decide",
  "workspace:edit",
  "connection:read",
  "connection:manage",
  "member:manage",
  "org:manage",
] as const;
export type Permission = (typeof permissions)[number];

const VIEWER: Permission[] = ["workspace:read", "connection:read"];
const RUNNER: Permission[] = [...VIEWER, "task:run", "approval:decide"];
const EDITOR: Permission[] = [...RUNNER, "workspace:edit", "connection:manage"];
const OWNER: Permission[] = [...EDITOR, "member:manage", "org:manage"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = { viewer: VIEWER, runner: RUNNER, editor: EDITOR, owner: OWNER };

/** Permissions that are judged per workspace rather than per org. */
const WORKSPACE_SCOPED = new Set<Permission>(["workspace:read", "task:run", "approval:decide", "workspace:edit"]);

export const isRole = (v: unknown): v is Role => typeof v === "string" && (roles as readonly string[]).includes(v);
export const isPermission = (v: unknown): v is Permission => typeof v === "string" && (permissions as readonly string[]).includes(v);

/** The authenticated caller: who, in which org, with which role, and (for tokens) which scopes. */
export interface Principal extends Actor {
  role: Role;
  /** Set for access tokens; null for browser sessions. */
  scopes: Permission[] | null;
  via: "session" | "token";
  tokenId?: string;
}

export function roleAllows(role: Role | null, perm: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].includes(perm);
}

export class Access {
  /** The caller's effective role in a workspace, or null when they cannot see it. */
  async workspaceRole(q: Queryable, p: Principal, workspaceId: string): Promise<Role | null> {
    const [row] = await q.query<{ private: boolean; created_by: string | null; override: string | null }>(
      `select w.private, w.created_by,
              (select m.role from workspace_members m where m.workspace_id = w.id and m.user_id = $3) as override
         from workspaces w where w.id = $1 and w.org_id = $2 and w.archived_at is null`,
      [workspaceId, p.orgId, p.userId],
    );
    if (!row) return null;
    if (row.private) return row.created_by === p.userId ? "owner" : null;
    return isRole(row.override) ? row.override : p.role;
  }

  /** True when the caller may do `perm`, in the given workspace when the permission is workspace-scoped. */
  async can(q: Queryable, p: Principal, perm: Permission, workspaceId?: string): Promise<boolean> {
    if (p.scopes && !p.scopes.includes(perm)) return false;
    if (WORKSPACE_SCOPED.has(perm) && workspaceId) return roleAllows(await this.workspaceRole(q, p, workspaceId), perm);
    return roleAllows(p.role, perm);
  }

  /** Throws 404 when the workspace is invisible to the caller and 403 when they lack the permission. */
  async ensure(q: Queryable, p: Principal, perm: Permission, workspaceId?: string): Promise<void> {
    if (workspaceId && WORKSPACE_SCOPED.has(perm)) {
      const role = await this.workspaceRole(q, p, workspaceId);
      if (!role) throw notFound("Workspace");
      if (!roleAllows(role, perm) || (p.scopes && !p.scopes.includes(perm))) throw forbidden(perm);
      return;
    }
    if (!(await this.can(q, p, perm, workspaceId))) throw forbidden(perm);
  }

  async workspaceOfRun(q: Queryable, p: Principal, runId: string): Promise<string> {
    const [row] = await q.query<{ workspace_id: string }>(`select workspace_id from runs where id = $1 and org_id = $2`, [runId, p.orgId]);
    if (!row) throw notFound("Task");
    return row.workspace_id;
  }

  async workspaceOfApproval(q: Queryable, p: Principal, approvalId: string): Promise<string> {
    const [row] = await q.query<{ workspace_id: string }>(
      `select r.workspace_id from approvals a join runs r on r.id = a.run_id where a.id = $1 and a.org_id = $2`,
      [approvalId, p.orgId],
    );
    if (!row) throw notFound("Approval");
    return row.workspace_id;
  }

  /** SQL fragment that hides other people's personal workspaces; $userParam is the caller's user id. */
  static visibleWorkspace(alias: string, userParam: string): string {
    return `(not ${alias}.private or ${alias}.created_by = ${userParam})`;
  }
}

export function forbidden(perm: Permission): ConclaveError {
  const what: Record<Permission, string> = {
    "workspace:read": "see this workspace",
    "task:run": "run or cancel tasks here",
    "approval:decide": "answer approvals here",
    "workspace:edit": "change this workspace",
    "connection:read": "see connections",
    "connection:manage": "change connections",
    "member:manage": "manage members",
    "org:manage": "change this organisation",
  };
  return new ConclaveError(403, "Not allowed", `Your role cannot ${what[perm]}.`);
}

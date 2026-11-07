import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { newId, type InviteDto, type MeDto, type MemberDto, type MfaChallengeDto, type MfaMethod, type TokenDto } from "@conclave/contract";

export type { InviteDto, MeDto, MemberDto, TokenDto };
import { iso, json, type Db, type Queryable } from "@conclave/db";
import { isPermission, isRole, ROLE_PERMISSIONS, type Permission, type Principal, type Role } from "./access";
import { audit } from "./connections";
import { ConclaveError, conflict, invalid, notFound } from "./errors";
import type { SecondFactors } from "./mfa";

/**
 * Accounts and access (ACC-001 to ACC-006): passwords, sessions, outside
 * identities, organisations, members, invites and personal access tokens.
 * Secrets (passwords, session cookies, tokens, invite links) are stored as hashes only.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
export const MIN_PASSWORD = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const newSecret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
const normEmail = (email: string) => email.trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkPassword(password: string): string[] {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return [`The password must be at least ${MIN_PASSWORD} characters.`];
  if (password.length > 512) return ["The password is too long."];
  return [];
}

export interface SessionMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface OutsideIdentity {
  provider: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export type Session = { token: string; principal: Principal };
/** A password sign-in either starts a session or, with a second factor on, asks for it (ACC-002). */
export type SignInResult = Session | { mfaRequired: MfaChallengeDto };

export class Accounts {
  private readonly db: Db;
  private readonly mfa: SecondFactors | undefined;
  /** Lets people whose verified email is on these domains join the first org as viewers without an invite. */
  private readonly signupDomains: string[];

  constructor(db: Db, opts: { signupDomains?: string[]; mfa?: SecondFactors } = {}) {
    this.db = db;
    this.mfa = opts.mfa;
    this.signupDomains = (opts.signupDomains ?? []).map((d) => d.toLowerCase());
  }

  // --------------------------------------------------------------- setup

  /** Setup is needed until some user can sign in. */
  async setupRequired(): Promise<boolean> {
    const [row] = await this.db.query<{ n: string | number }>(
      `select (select count(*) from users where password_hash is not null) + (select count(*) from identities) as n`,
    );
    return Number(row?.n ?? 0) === 0;
  }

  /** First run: claim the owner account the instance was created with (or create one). */
  async setup(input: { name: string; email: string; password: string; orgName?: string }, meta: SessionMeta = {}): Promise<{ token: string; principal: Principal }> {
    const errors = [...this.checkProfile(input.name, input.email), ...checkPassword(input.password)];
    if (errors.length) throw invalid(errors);
    if (!(await this.setupRequired())) throw conflict("This instance is already set up. Sign in instead.");
    const passwordHash = await hashPassword(input.password);
    const { userId, orgId } = await this.db.tx(async (q) => {
      const [owner] = await q.query<{ org_id: string; user_id: string }>(`select org_id, user_id from memberships where role = 'owner' order by org_id limit 1`);
      let ids: { userId: string; orgId: string };
      if (owner) {
        ids = { userId: owner.user_id, orgId: owner.org_id };
        await q.query(`update users set email = $2, name = $3, password_hash = $4 where id = $1`, [owner.user_id, normEmail(input.email), input.name.trim(), passwordHash]);
      } else {
        ids = { userId: newId(), orgId: newId() };
        await q.query(`insert into orgs (id, name) values ($1, $2)`, [ids.orgId, input.orgName?.trim() || "My organisation"]);
        await q.query(`insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)`, [ids.userId, normEmail(input.email), input.name.trim(), passwordHash]);
        await q.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [ids.orgId, ids.userId]);
      }
      if (input.orgName?.trim()) await q.query(`update orgs set name = $2 where id = $1`, [ids.orgId, input.orgName.trim()]);
      await audit(q, { orgId: ids.orgId, userId: ids.userId }, "instance.setup", ids.userId, {});
      return ids;
    });
    return this.startSession(userId, orgId, meta);
  }

  // ------------------------------------------------------------- sign-in

  async signIn(input: { email: string; password: string }, meta: SessionMeta = {}): Promise<SignInResult> {
    const [user] = await this.db.query<{ id: string; password_hash: string | null; disabled_at: Date | null }>(
      `select id, password_hash, disabled_at from users where email = $1`,
      [normEmail(input.email ?? "")],
    );
    // Same answer and similar time whether or not the email exists.
    const ok = await verifyPassword(String(input.password ?? ""), user?.password_hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    if (!user || !ok || user.disabled_at) throw new ConclaveError(401, "Sign-in failed", "The email or password is wrong.");
    if (this.mfa && (await this.mfa.methodsFor(user.id)).length > 0) return { mfaRequired: await this.mfa.issueTicket(user.id) };
    return this.sessionFor(user.id, meta, "password");
  }

  /** Finish a password sign-in with a TOTP code, a recovery code or a passkey. */
  async completeSignIn(input: { ticket: string; code?: string; recoveryCode?: string; passkey?: unknown }, meta: SessionMeta = {}): Promise<Session> {
    if (!this.mfa) throw invalid(["Two-factor sign-in is not available."]);
    const proof = {
      ...(input.code ? { code: input.code } : {}),
      ...(input.recoveryCode ? { recoveryCode: input.recoveryCode } : {}),
      ...(input.passkey ? { passkey: input.passkey as Parameters<SecondFactors["redeemTicket"]>[1]["passkey"] } : {}),
    };
    const { userId, method } = await this.mfa.redeemTicket(input.ticket, proof);
    return this.sessionFor(userId, meta, `password+${method}`);
  }

  /** Passwordless sign-in with a passkey that verified the person (ACC-002). */
  async signInWithPasskey(input: { challengeId: string; response: unknown }, meta: SessionMeta = {}): Promise<Session> {
    if (!this.mfa) throw invalid(["Passkeys are not available."]);
    const userId = await this.mfa.passkeySignIn(input as Parameters<SecondFactors["passkeySignIn"]>[0]);
    return this.sessionFor(userId, meta, "passkey");
  }

  /** Start a session for someone who has proven who they are. */
  async sessionFor(userId: string, meta: SessionMeta, method: string | MfaMethod): Promise<Session> {
    const [user] = await this.db.query<{ disabled_at: Date | null }>(`select disabled_at from users where id = $1`, [userId]);
    if (!user || user.disabled_at) throw new ConclaveError(403, "Sign-in failed", "This account is turned off.");
    const orgId = await this.defaultOrg(userId);
    const session = await this.startSession(userId, orgId, meta);
    await audit(this.db, { orgId, userId }, "user.sign_in", userId, { method, ip: meta.ip ?? null });
    return session;
  }

  /** Sign in with a verified identity from OIDC or GitHub; links to an existing account by verified email. */
  async signInWithIdentity(identity: OutsideIdentity, meta: SessionMeta = {}): Promise<{ token: string; principal: Principal }> {
    const userId = await this.db.tx(async (q) => {
      const [linked] = await q.query<{ user_id: string }>(`select user_id from identities where provider = $1 and subject = $2`, [identity.provider, identity.subject]);
      if (linked) return linked.user_id;
      const email = identity.email && identity.emailVerified ? normEmail(identity.email) : null;
      if (!email) throw new ConclaveError(403, "Sign-in failed", "Your account there has no verified email address.");

      const [existing] = await q.query<{ id: string }>(`select id from users where email = $1`, [email]);
      let id = existing?.id;
      if (!id) {
        const [invite] = await q.query<{ id: string; org_id: string; role: string }>(
          `select id, org_id, role from invites where lower(email) = $1 and accepted_at is null and expires_at > now() order by created_at desc limit 1`,
          [email],
        );
        const domain = email.split("@")[1] ?? "";
        const [firstOrg] = await q.query<{ id: string }>(`select id from orgs order by created_at limit 1`);
        if (!invite && !(this.signupDomains.includes(domain) && firstOrg)) {
          throw new ConclaveError(403, "No invite", `There is no invite for ${email}. Ask an owner to invite you.`);
        }
        id = newId();
        await q.query(`insert into users (id, email, name) values ($1, $2, $3)`, [id, email, identity.name?.trim() || email.split("@")[0]]);
        if (invite) {
          await q.query(`insert into memberships (org_id, user_id, role) values ($1, $2, $3) on conflict do nothing`, [invite.org_id, id, invite.role]);
          await q.query(`update invites set accepted_at = now(), accepted_by = $2 where id = $1`, [invite.id, id]);
        } else {
          await q.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer') on conflict do nothing`, [firstOrg!.id, id]);
        }
      }
      await q.query(`insert into identities (id, user_id, provider, subject, email) values ($1, $2, $3, $4, $5)`, [newId(), id, identity.provider, identity.subject, email]);
      return id;
    });
    const [user] = await this.db.query<{ disabled_at: Date | null }>(`select disabled_at from users where id = $1`, [userId]);
    if (user?.disabled_at) throw new ConclaveError(403, "Sign-in failed", "This account is turned off.");
    const orgId = await this.defaultOrg(userId);
    const session = await this.startSession(userId, orgId, meta);
    await audit(this.db, { orgId, userId }, "user.sign_in", userId, { method: identity.provider, ip: meta.ip ?? null });
    return session;
  }

  private async defaultOrg(userId: string): Promise<string> {
    const [m] = await this.db.query<{ org_id: string }>(
      `select org_id from memberships where user_id = $1 order by case role when 'owner' then 0 when 'editor' then 1 when 'runner' then 2 else 3 end, org_id limit 1`,
      [userId],
    );
    if (!m) throw new ConclaveError(403, "Sign-in failed", "This account does not belong to any organisation.");
    return m.org_id;
  }

  private async startSession(userId: string, orgId: string, meta: SessionMeta): Promise<{ token: string; principal: Principal }> {
    const token = newSecret("");
    await this.db.query(
      `insert into sessions (id, user_id, org_id, token_hash, expires_at, user_agent, ip) values ($1, $2, $3, $4, now() + ($5::int * interval '1 day'), $6, $7)`,
      [newId(), userId, orgId, sha256(token), SESSION_DAYS, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
    );
    await this.db.query(`update users set last_sign_in_at = now() where id = $1`, [userId]);
    const principal = await this.principalFor(userId, orgId, null, "session");
    if (!principal) throw new ConclaveError(403, "Sign-in failed", "You are not a member of this organisation.");
    return { token, principal };
  }

  async signOut(token: string): Promise<void> {
    await this.db.query(`delete from sessions where token_hash = $1`, [sha256(token)]);
  }

  /** Who a session cookie belongs to, or null when it is unknown or expired. */
  async fromSession(token: string): Promise<Principal | null> {
    const [s] = await this.db.query<{ id: string; user_id: string; org_id: string; last_seen_at: Date }>(
      `select s.id, s.user_id, s.org_id, s.last_seen_at from sessions s join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now() and u.disabled_at is null`,
      [sha256(token)],
    );
    if (!s) return null;
    if (Date.now() - new Date(s.last_seen_at).getTime() > 5 * 60_000) {
      await this.db.query(`update sessions set last_seen_at = now() where id = $1`, [s.id]);
    }
    return this.principalFor(s.user_id, s.org_id, null, "session");
  }

  /** Who an access token belongs to, limited to its scopes (ACC-006). */
  async fromToken(token: string): Promise<Principal | null> {
    if (!token.startsWith("cnc_")) return null;
    const [t] = await this.db.query<{ id: string; user_id: string; org_id: string; scopes: string[] }>(
      `select t.id, t.user_id, t.org_id, t.scopes from api_tokens t join users u on u.id = t.user_id
        where t.token_hash = $1 and t.revoked_at is null and (t.expires_at is null or t.expires_at > now()) and u.disabled_at is null`,
      [sha256(token)],
    );
    if (!t) return null;
    await this.db.query(`update api_tokens set last_used_at = now() where id = $1`, [t.id]);
    const p = await this.principalFor(t.user_id, t.org_id, t.scopes.filter(isPermission), "token");
    return p ? { ...p, tokenId: t.id } : null;
  }

  private async principalFor(userId: string, orgId: string, scopes: Permission[] | null, via: "session" | "token"): Promise<Principal | null> {
    const [m] = await this.db.query<{ role: string }>(`select role from memberships where user_id = $1 and org_id = $2`, [userId, orgId]);
    if (!m || !isRole(m.role)) return null;
    return { userId, orgId, role: m.role, scopes, via };
  }

  async me(p: Principal): Promise<MeDto> {
    const [user] = await this.db.query<{ id: string; email: string; name: string; password_hash: string | null }>(`select id, email, name, password_hash from users where id = $1`, [p.userId]);
    const orgs = await this.db.query<{ id: string; name: string; role: Role }>(
      `select o.id, o.name, m.role from memberships m join orgs o on o.id = m.org_id where m.user_id = $1 order by o.name`,
      [p.userId],
    );
    const org = orgs.find((o) => o.id === p.orgId)!;
    const perms = ROLE_PERMISSIONS[p.role].filter((x) => !p.scopes || p.scopes.includes(x));
    return {
      user: { id: user!.id, email: user!.email, name: user!.name, hasPassword: !!user!.password_hash },
      org: { id: org.id, name: org.name },
      role: p.role,
      permissions: perms,
      orgs,
      via: p.via,
    };
  }

  async updateProfile(p: Principal, input: { name?: string }): Promise<void> {
    if (input.name !== undefined) {
      if (!input.name.trim()) throw invalid(["Name is required."]);
      await this.db.query(`update users set name = $2 where id = $1`, [p.userId, input.name.trim().slice(0, 120)]);
    }
  }

  async changePassword(p: Principal, input: { current?: string; next: string }): Promise<void> {
    const errors = checkPassword(input.next);
    if (errors.length) throw invalid(errors);
    const [user] = await this.db.query<{ password_hash: string | null }>(`select password_hash from users where id = $1`, [p.userId]);
    if (user?.password_hash && !(await verifyPassword(input.current ?? "", user.password_hash))) {
      throw new ConclaveError(403, "Not allowed", "The current password is wrong.");
    }
    await this.db.tx(async (q) => {
      await q.query(`update users set password_hash = $2 where id = $1`, [p.userId, await hashPassword(input.next)]);
      await audit(q, p, "user.password_changed", p.userId, {});
    });
  }

  // ------------------------------------------------------------------ orgs

  async createOrg(p: Principal, name: string): Promise<{ id: string; name: string }> {
    if (!name?.trim()) throw invalid(["Name is required."]);
    const id = newId();
    await this.db.tx(async (q) => {
      await q.query(`insert into orgs (id, name) values ($1, $2)`, [id, name.trim().slice(0, 120)]);
      await q.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [id, p.userId]);
      await audit(q, { orgId: id, userId: p.userId }, "org.created", id, {});
    });
    return { id, name: name.trim() };
  }

  /** Point a browser session at another org the user belongs to. */
  async switchOrg(sessionToken: string, p: Principal, orgId: string): Promise<Principal> {
    const next = await this.principalFor(p.userId, orgId, null, "session");
    if (!next) throw notFound("Organisation");
    await this.db.query(`update sessions set org_id = $2 where token_hash = $1`, [sha256(sessionToken), orgId]);
    return next;
  }

  // --------------------------------------------------------------- members

  async members(p: Principal): Promise<MemberDto[]> {
    const rows = await this.db.query<{ user_id: string; email: string; name: string; role: Role; last_sign_in_at: Date | null }>(
      `select m.user_id, u.email, u.name, m.role, u.last_sign_in_at from memberships m join users u on u.id = m.user_id
        where m.org_id = $1 and u.disabled_at is null order by u.name`,
      [p.orgId],
    );
    return rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name, role: r.role, lastSignInAt: iso(r.last_sign_in_at), you: r.user_id === p.userId }));
  }

  async setMemberRole(p: Principal, userId: string, role: Role): Promise<void> {
    if (!isRole(role)) throw invalid([`Unknown role "${role}".`]);
    await this.db.tx(async (q) => {
      const [m] = await q.query<{ role: string }>(`select role from memberships where org_id = $1 and user_id = $2 for update`, [p.orgId, userId]);
      if (!m) throw notFound("Member");
      if (m.role === "owner" && role !== "owner") await this.assertAnotherOwner(q, p.orgId, userId);
      await q.query(`update memberships set role = $3 where org_id = $1 and user_id = $2`, [p.orgId, userId, role]);
      await audit(q, p, "member.role_changed", userId, { from: m.role, to: role });
    });
  }

  async removeMember(p: Principal, userId: string): Promise<void> {
    await this.db.tx(async (q) => {
      const [m] = await q.query<{ role: string }>(`select role from memberships where org_id = $1 and user_id = $2 for update`, [p.orgId, userId]);
      if (!m) throw notFound("Member");
      if (m.role === "owner") await this.assertAnotherOwner(q, p.orgId, userId);
      await q.query(`delete from memberships where org_id = $1 and user_id = $2`, [p.orgId, userId]);
      await q.query(`delete from sessions where org_id = $1 and user_id = $2`, [p.orgId, userId]);
      await q.query(`update api_tokens set revoked_at = now() where org_id = $1 and user_id = $2 and revoked_at is null`, [p.orgId, userId]);
      await q.query(`delete from workspace_members where user_id = $2 and workspace_id in (select id from workspaces where org_id = $1)`, [p.orgId, userId]);
      await audit(q, p, "member.removed", userId, {});
    });
  }

  private async assertAnotherOwner(q: Queryable, orgId: string, userId: string) {
    const [row] = await q.query<{ n: string | number }>(`select count(*) as n from memberships where org_id = $1 and role = 'owner' and user_id <> $2`, [orgId, userId]);
    if (Number(row?.n ?? 0) === 0) throw conflict("An organisation needs at least one owner. Make someone else an owner first.");
  }

  /** Override a member's role in one workspace, or clear the override with null (ACC-004). */
  async setWorkspaceRole(p: Principal, workspaceId: string, userId: string, role: Role | null): Promise<void> {
    if (role !== null && !isRole(role)) throw invalid([`Unknown role "${role}".`]);
    await this.db.tx(async (q) => {
      const [m] = await q.query(`select 1 from memberships where org_id = $1 and user_id = $2`, [p.orgId, userId]);
      if (!m) throw notFound("Member");
      if (role === null) await q.query(`delete from workspace_members where workspace_id = $1 and user_id = $2`, [workspaceId, userId]);
      else
        await q.query(
          `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3) on conflict (workspace_id, user_id) do update set role = excluded.role`,
          [workspaceId, userId, role],
        );
      await audit(q, p, "workspace.role_override", workspaceId, { userId, role });
    });
  }

  async workspaceMembers(p: Principal, workspaceId: string): Promise<(MemberDto & { override: Role | null })[]> {
    const members = await this.members(p);
    const overrides = await this.db.query<{ user_id: string; role: Role }>(`select user_id, role from workspace_members where workspace_id = $1`, [workspaceId]);
    const map = new Map(overrides.map((o) => [o.user_id, o.role]));
    return members.map((m) => ({ ...m, override: map.get(m.userId) ?? null }));
  }

  // --------------------------------------------------------------- invites

  async createInvite(p: Principal, input: { email?: string | null; role: Role }): Promise<{ token: string; invite: InviteDto }> {
    if (!isRole(input.role)) throw invalid([`Unknown role "${input.role}".`]);
    if (input.role === "owner" && p.role !== "owner") throw new ConclaveError(403, "Not allowed", "Only owners can invite owners.");
    const email = input.email?.trim() ? normEmail(input.email) : null;
    if (email && !EMAIL.test(email)) throw invalid(["That email address does not look right."]);
    if (email) {
      const [member] = await this.db.query(`select 1 from memberships m join users u on u.id = m.user_id where m.org_id = $1 and u.email = $2`, [p.orgId, email]);
      if (member) throw conflict(`${email} is already a member.`);
    }
    const token = newSecret("inv_");
    const id = newId();
    const [row] = await this.db.query<{ created_at: Date; expires_at: Date }>(
      `insert into invites (id, org_id, email, role, token_hash, created_by, expires_at) values ($1, $2, $3, $4, $5, $6, now() + ($7::int * interval '1 day'))
       returning created_at, expires_at`,
      [id, p.orgId, email, input.role, sha256(token), p.userId, INVITE_DAYS],
    );
    await audit(this.db, p, "invite.created", id, { email, role: input.role });
    return { token, invite: { id, email, role: input.role, createdAt: iso(row!.created_at)!, expiresAt: iso(row!.expires_at)! } };
  }

  async invites(p: Principal): Promise<InviteDto[]> {
    const rows = await this.db.query<{ id: string; email: string | null; role: Role; created_at: Date; expires_at: Date }>(
      `select id, email, role, created_at, expires_at from invites where org_id = $1 and accepted_at is null and expires_at > now() order by created_at desc`,
      [p.orgId],
    );
    return rows.map((r) => ({ id: r.id, email: r.email, role: r.role, createdAt: iso(r.created_at)!, expiresAt: iso(r.expires_at)! }));
  }

  async revokeInvite(p: Principal, id: string): Promise<void> {
    const rows = await this.db.query(`update invites set expires_at = now() where id = $1 and org_id = $2 and accepted_at is null returning id`, [id, p.orgId]);
    if (rows.length === 0) throw notFound("Invite");
    await audit(this.db, p, "invite.revoked", id, {});
  }

  async inviteInfo(token: string): Promise<{ orgName: string; role: Role; email: string | null }> {
    const [row] = await this.db.query<{ name: string; role: Role; email: string | null }>(
      `select o.name, i.role, i.email from invites i join orgs o on o.id = i.org_id where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now()`,
      [sha256(token)],
    );
    if (!row) throw notFound("Invite");
    return { orgName: row.name, role: row.role, email: row.email };
  }

  /** Join an org from an invite link: a new account, or an existing one if `existing` is signed in. */
  async acceptInvite(
    token: string,
    input: { name?: string; email?: string; password?: string },
    existing: Principal | null,
    meta: SessionMeta = {},
  ): Promise<{ token: string; principal: Principal }> {
    const { userId, orgId } = await this.db.tx(async (q) => {
      const [inv] = await q.query<{ id: string; org_id: string; role: Role; email: string | null }>(
        `select id, org_id, role, email from invites where token_hash = $1 and accepted_at is null and expires_at > now() for update`,
        [sha256(token)],
      );
      if (!inv) throw notFound("Invite");
      let userId: string;
      if (existing) {
        userId = existing.userId;
      } else {
        const email = normEmail(input.email ?? inv.email ?? "");
        const errors = [...this.checkProfile(input.name ?? "", email), ...checkPassword(input.password ?? "")];
        if (inv.email && email !== inv.email) errors.push(`This invite is for ${inv.email}.`);
        if (errors.length) throw invalid(errors);
        const [taken] = await q.query(`select 1 from users where email = $1`, [email]);
        if (taken) throw conflict("An account with this email exists. Sign in first, then open the invite link again.");
        userId = newId();
        await q.query(`insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)`, [userId, email, input.name!.trim(), await hashPassword(input.password!)]);
      }
      await q.query(`insert into memberships (org_id, user_id, role) values ($1, $2, $3) on conflict (org_id, user_id) do nothing`, [inv.org_id, userId, inv.role]);
      await q.query(`update invites set accepted_at = now(), accepted_by = $2 where id = $1`, [inv.id, userId]);
      await audit(q, { orgId: inv.org_id, userId }, "invite.accepted", inv.id, { role: inv.role });
      return { userId, orgId: inv.org_id };
    });
    return this.startSession(userId, orgId, meta);
  }

  // ---------------------------------------------------------------- tokens

  async createToken(p: Principal, input: { name: string; scopes: string[]; expiresInDays?: number | null }): Promise<{ token: string; info: TokenDto }> {
    if (!input.name?.trim()) throw invalid(["Name is required."]);
    const scopes = [...new Set(input.scopes ?? [])];
    const unknown = scopes.filter((s) => !isPermission(s));
    if (unknown.length) throw invalid([`Unknown scope ${unknown.map((s) => `"${s}"`).join(", ")}.`]);
    if (scopes.length === 0) throw invalid(["Pick at least one scope."]);
    // A token can never do more than the person who made it (and a token cannot mint wider tokens).
    const allowed = ROLE_PERMISSIONS[p.role].filter((x) => !p.scopes || p.scopes.includes(x));
    const beyond = scopes.filter((s) => !allowed.includes(s as Permission));
    if (beyond.length) throw new ConclaveError(403, "Not allowed", `Your role cannot grant ${beyond.join(", ")}.`);
    const days = input.expiresInDays ?? null;
    if (days !== null && !(days > 0 && days <= 3650)) throw invalid(["Expiry must be between 1 and 3650 days."]);

    const token = newSecret("cnc_");
    const id = newId();
    const prefix = token.slice(0, 10);
    const [row] = await this.db.query<{ created_at: Date; expires_at: Date | null }>(
      `insert into api_tokens (id, org_id, user_id, name, prefix, token_hash, scopes, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, case when $8::int is null then null else now() + ($8::int * interval '1 day') end)
       returning created_at, expires_at`,
      [id, p.orgId, p.userId, input.name.trim().slice(0, 80), prefix, sha256(token), json(scopes), days],
    );
    await audit(this.db, p, "token.created", id, { scopes });
    return {
      token,
      info: { id, name: input.name.trim(), prefix, scopes: scopes as Permission[], createdAt: iso(row!.created_at)!, lastUsedAt: null, expiresAt: iso(row!.expires_at) },
    };
  }

  async tokens(p: Principal): Promise<TokenDto[]> {
    const rows = await this.db.query<{ id: string; name: string; prefix: string; scopes: Permission[]; created_at: Date; last_used_at: Date | null; expires_at: Date | null }>(
      `select id, name, prefix, scopes, created_at, last_used_at, expires_at from api_tokens
        where user_id = $1 and org_id = $2 and revoked_at is null and (expires_at is null or expires_at > now()) order by created_at desc`,
      [p.userId, p.orgId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes, createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), expiresAt: iso(r.expires_at) }));
  }

  async revokeToken(p: Principal, id: string): Promise<void> {
    const rows = await this.db.query(`update api_tokens set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null returning id`, [id, p.userId]);
    if (rows.length === 0) throw notFound("Token");
    await audit(this.db, p, "token.revoked", id, {});
  }

  private checkProfile(name: string, email: string): string[] {
    const errors: string[] = [];
    if (!name?.trim()) errors.push("Name is required.");
    if (!email || !EMAIL.test(email.trim())) errors.push("Enter a valid email address.");
    return errors;
  }
}

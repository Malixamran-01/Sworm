import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "./accounts";
import type { Principal } from "./access";
import { hashPassword, verifyPassword } from "./accounts";
import { harness, type Harness } from "./test-helpers";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const PASSWORD = "correct horse battery";

async function withOwner() {
  h = await harness();
  const { principal } = await h.conclave.accounts.setup({ name: "Ada", email: "Ada@Example.com", password: PASSWORD, orgName: "Ada Co" });
  return { h, owner: principal };
}

async function member(h: Harness, owner: Principal, role: "editor" | "runner" | "viewer", email: string) {
  const { token } = await h.conclave.accounts.createInvite(owner, { email, role });
  const { principal } = await h.conclave.accounts.acceptInvite(token, { name: email.split("@")[0], email, password: PASSWORD }, null);
  return principal;
}

describe("Passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("wrong password!", stored)).toBe(false);
  });
});

describe("Setup and sign-in (ACC-001)", () => {
  it("claims the bootstrap owner once, then signs in with email and password", async () => {
    h = await harness();
    expect(await h.conclave.accounts.setupRequired()).toBe(true);
    const { principal, token } = await h.conclave.accounts.setup({ name: "Ada", email: "ada@example.com", password: PASSWORD });
    // The harness's existing workspace belongs to the claimed owner.
    expect(principal).toMatchObject({ orgId: h.actor.orgId, userId: h.actor.userId, role: "owner", via: "session" });
    expect(await h.conclave.accounts.fromSession(token)).toMatchObject({ userId: h.actor.userId });
    expect(await h.conclave.accounts.setupRequired()).toBe(false);
    await expect(h.conclave.accounts.setup({ name: "Eve", email: "eve@example.com", password: PASSWORD })).rejects.toThrow(/already set up/);

    await expect(h.conclave.accounts.signIn({ email: "ada@example.com", password: "nope nope nope" })).rejects.toThrow(/email or password is wrong/);
    await expect(h.conclave.accounts.signIn({ email: "nobody@example.com", password: PASSWORD })).rejects.toThrow(/email or password is wrong/);
    const again = (await h.conclave.accounts.signIn({ email: "ADA@example.com", password: PASSWORD })) as Session;
    expect(again.principal.role).toBe("owner");

    await h.conclave.accounts.signOut(again.token);
    expect(await h.conclave.accounts.fromSession(again.token)).toBeNull();
  });

  it("rejects short passwords", async () => {
    h = await harness();
    await expect(h.conclave.accounts.setup({ name: "Ada", email: "ada@example.com", password: "short" })).rejects.toThrow(/at least 10/);
  });
});

describe("Members, roles and invites (ACC-003, ACC-004)", () => {
  it("invites people with a role and keeps at least one owner", async () => {
    const { h, owner } = await withOwner();
    const runner = await member(h, owner, "runner", "rui@example.com");
    expect(runner.role).toBe("runner");
    expect((await h.conclave.accounts.members(owner)).map((m) => [m.email, m.role])).toEqual([
      ["ada@example.com", "owner"],
      ["rui@example.com", "runner"],
    ]);
    await expect(h.conclave.accounts.setMemberRole(owner, owner.userId, "editor")).rejects.toThrow(/at least one owner/);
    await h.conclave.accounts.setMemberRole(owner, runner.userId, "editor");
    expect(((await h.conclave.accounts.signIn({ email: "rui@example.com", password: PASSWORD })) as Session).principal.role).toBe("editor");
  });

  it("allows each role exactly its permissions, with per-workspace overrides", async () => {
    const { h, owner } = await withOwner();
    const viewer = await member(h, owner, "viewer", "vic@example.com");
    const access = h.conclave.access;
    const ws = h.workspaceId;
    expect(await access.can(h.conclave.db, viewer, "workspace:read", ws)).toBe(true);
    expect(await access.can(h.conclave.db, viewer, "task:run", ws)).toBe(false);
    expect(await access.can(h.conclave.db, viewer, "connection:manage")).toBe(false);
    expect(await access.can(h.conclave.db, owner, "member:manage")).toBe(true);

    await h.conclave.accounts.setWorkspaceRole(owner, ws, viewer.userId, "runner");
    expect(await access.can(h.conclave.db, viewer, "task:run", ws)).toBe(true);
    expect(await access.can(h.conclave.db, viewer, "workspace:edit", ws)).toBe(false);
    await h.conclave.accounts.setWorkspaceRole(owner, ws, viewer.userId, null);
    expect(await access.can(h.conclave.db, viewer, "task:run", ws)).toBe(false);
  });

  it("hides personal workspaces from everyone but their creator", async () => {
    const { h, owner } = await withOwner();
    const editor = await member(h, owner, "editor", "eda@example.com");
    const personal = await h.conclave.workspaces.createFromTemplate(owner, { templateKey: "research-brief", name: "Mine", private: true });
    expect((await h.conclave.workspaces.list(owner)).map((w) => w.name)).toContain("Mine");
    expect((await h.conclave.workspaces.list(editor)).map((w) => w.name)).not.toContain("Mine");
    expect(await h.conclave.access.workspaceRole(h.conclave.db, editor, personal.id)).toBeNull();
    await expect(h.conclave.access.ensure(h.conclave.db, editor, "workspace:read", personal.id)).rejects.toThrow(/not found/);
  });

  it("keeps each org's workspaces in that org", async () => {
    const { h, owner } = await withOwner();
    const other = await h.conclave.accounts.createOrg(owner, "Side project");
    const inOther: Principal = { ...owner, orgId: other.id };
    expect(await h.conclave.workspaces.list(inOther)).toEqual([]);
    expect((await h.conclave.workspaces.list(owner)).length).toBe(1);
    const me = await h.conclave.accounts.me(owner);
    expect(me.orgs.map((o) => o.name).sort()).toEqual(["Ada Co", "Side project"]);
  });
});

describe("Access tokens (ACC-006)", () => {
  it("issues scoped tokens no wider than the maker's role, and revokes them", async () => {
    const { h, owner } = await withOwner();
    const viewer = await member(h, owner, "viewer", "vic@example.com");
    await expect(h.conclave.accounts.createToken(viewer, { name: "CI", scopes: ["task:run"] })).rejects.toThrow(/cannot grant task:run/);

    const { token, info } = await h.conclave.accounts.createToken(owner, { name: "Script", scopes: ["workspace:read", "task:run"], expiresInDays: 30 });
    expect(token).toMatch(/^cnc_/);
    expect(info.prefix).toBe(token.slice(0, 10));
    const p = await h.conclave.accounts.fromToken(token);
    expect(p).toMatchObject({ userId: owner.userId, scopes: ["workspace:read", "task:run"], via: "token" });
    expect(await h.conclave.access.can(h.conclave.db, p!, "task:run", h.workspaceId)).toBe(true);
    expect(await h.conclave.access.can(h.conclave.db, p!, "connection:manage")).toBe(false);

    const rows = await h.conclave.db.query(`select * from api_tokens`);
    expect(JSON.stringify(rows)).not.toContain(token);

    await h.conclave.accounts.revokeToken(owner, info.id);
    expect(await h.conclave.accounts.fromToken(token)).toBeNull();
  });
});

describe("Outside identities (OIDC, GitHub)", () => {
  it("needs an invite or an allowed domain, then links the identity", async () => {
    const { h, owner } = await withOwner();
    const identity = { provider: "oidc:google", subject: "123", email: "gia@example.com", emailVerified: true, name: "Gia" };
    await expect(h.conclave.accounts.signInWithIdentity(identity)).rejects.toThrow(/no invite/i);

    await h.conclave.accounts.createInvite(owner, { email: "gia@example.com", role: "runner" });
    const first = await h.conclave.accounts.signInWithIdentity(identity);
    expect(first.principal.role).toBe("runner");
    const second = await h.conclave.accounts.signInWithIdentity({ ...identity, email: "changed@example.com" });
    expect(second.principal.userId).toBe(first.principal.userId);

    // An existing password account links by verified email.
    const linked = await h.conclave.accounts.signInWithIdentity({ provider: "github", subject: "9", email: "ada@example.com", emailVerified: true, name: "Ada" });
    expect(linked.principal.userId).toBe(owner.userId);
    await expect(
      h.conclave.accounts.signInWithIdentity({ provider: "github", subject: "10", email: "ada@example.com", emailVerified: false, name: "Ada" }),
    ).rejects.toThrow(/verified email/);
  });
});

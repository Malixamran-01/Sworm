import type { PermissionName, RoleName } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { authKey, replaceSession, useCan, useMe } from "../../lib/auth";
import { DevicesSection } from "./DevicesSection";
import { SsoSection } from "./SsoSection";
import { ago } from "../../lib/format";
import { initials } from "../../lib/palette";
import { Button, Card, cx, ErrorNote, Field, Input, PageHeader, Pill, Select } from "../../ui";
import { NotificationsSection } from "./NotificationsSection";
import { SecuritySection } from "./SecuritySection";

const ROLE_HELP: Record<RoleName, string> = {
  owner: "Everything, including members and the organisation",
  editor: "Builds workspaces and manages connections",
  runner: "Runs tasks and answers approvals",
  viewer: "Reads workspaces, tasks and results",
};

const SCOPES: { value: PermissionName; label: string }[] = [
  { value: "workspace:read", label: "Read workspaces and tasks" },
  { value: "task:run", label: "Start and cancel tasks" },
  { value: "approval:decide", label: "Answer approvals" },
  { value: "workspace:edit", label: "Change workspaces" },
  { value: "connection:read", label: "Read connections" },
  { value: "connection:manage", label: "Change connections" },
  { value: "member:manage", label: "Manage members" },
];

type Tab = "account" | "security" | "notifications" | "members" | "tokens" | "devices" | "sso";

function AccountSection() {
  const me = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState(me.user.name);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [orgName, setOrgName] = useState("");
  const refresh = () => qc.invalidateQueries();
  const saveName = useMutation({ mutationFn: () => api.updateMe({ name }), onSuccess: refresh });
  const changePw = useMutation({ mutationFn: () => api.changePassword(pw), onSuccess: () => setPw({ current: "", next: "" }) });
  const switchOrg = useMutation({ mutationFn: (id: string) => api.switchOrg(id), onSuccess: (next) => replaceSession(qc, next) });
  const createOrg = useMutation({ mutationFn: () => api.createOrg(orgName), onSuccess: () => qc.invalidateQueries({ queryKey: authKey }).then(() => setOrgName("")) });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card as="section" className="flex flex-col gap-4 p-5">
        <h2 className="m-0 text-[15px] font-semibold">Profile</h2>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveName.mutate();
          }}
        >
          <Field label="Name" htmlFor="me-name">
            <Input id="me-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Email" htmlFor="me-email">
            <Input id="me-email" value={me.user.email} readOnly className="bg-sunken text-muted" />
          </Field>
          <ErrorNote error={saveName.error} />
          <Button type="submit" variant="primary" size="sm" className="self-start" disabled={name === me.user.name || saveName.isPending}>
            Save
          </Button>
        </form>
      </Card>

      <Card as="section" className="flex flex-col gap-4 p-5">
        <h2 className="m-0 text-[15px] font-semibold">{me.user.hasPassword ? "Change password" : "Set a password"}</h2>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            changePw.mutate();
          }}
        >
          {me.user.hasPassword ? (
            <Field label="Current password" htmlFor="pw-current">
              <Input id="pw-current" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} required />
            </Field>
          ) : null}
          <Field label="New password" htmlFor="pw-next" help="At least 10 characters.">
            <Input id="pw-next" type="password" autoComplete="new-password" minLength={10} value={pw.next} onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} required />
          </Field>
          <ErrorNote error={changePw.error} />
          {changePw.isSuccess ? <p className="m-0 text-[13px] font-semibold text-good">Password changed.</p> : null}
          <Button type="submit" variant="primary" size="sm" className="self-start" disabled={changePw.isPending}>
            Change password
          </Button>
        </form>
      </Card>

      <Card as="section" className="flex flex-col gap-3 p-5 lg:col-span-2">
        <h2 className="m-0 text-[15px] font-semibold">Organisations</h2>
        <ul className="m-0 flex list-none flex-col gap-0 p-0">
          {me.orgs.map((o) => (
            <li key={o.id} className="flex items-center gap-3 border-t border-line-soft py-2.5 first:border-t-0">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-line-soft text-xs font-bold" aria-hidden>
                {initials(o.name, 1)}
              </span>
              <span className="flex-1 text-sm font-semibold">{o.name}</span>
              <Pill>{o.role}</Pill>
              {o.id === me.org.id ? (
                <span className="w-16 text-right text-xs text-muted">Current</span>
              ) : (
                <Button size="sm" className="w-16" disabled={switchOrg.isPending} onClick={() => switchOrg.mutate(o.id)}>
                  Switch
                </Button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            createOrg.mutate();
          }}
        >
          <label htmlFor="new-org" className="sr-only">
            New organisation name
          </label>
          <Input id="new-org" placeholder="New organisation name" value={orgName} onChange={(e) => setOrgName(e.target.value)} className="!w-64" required />
          <Button type="submit" disabled={!orgName.trim() || createOrg.isPending}>
            Create organisation
          </Button>
        </form>
        <ErrorNote error={createOrg.error ?? switchOrg.error} />
      </Card>
    </div>
  );
}

function MembersSection() {
  const qc = useQueryClient();
  const canManage = useCan("member:manage");
  const me = useMe();
  const members = useQuery({ queryKey: ["members"], queryFn: api.members });
  const invites = useQuery({ queryKey: ["invites"], queryFn: api.invites, enabled: canManage });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleName>("runner");
  const [link, setLink] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["members"] });
    void qc.invalidateQueries({ queryKey: ["invites"] });
  };
  const invite = useMutation({
    mutationFn: () => api.createInvite({ email: email.trim() || null, role }),
    onSuccess: (r) => {
      setLink(r.link);
      setEmail("");
      refresh();
    },
  });
  const setMemberRole = useMutation({ mutationFn: (v: { userId: string; role: RoleName }) => api.setMemberRole(v.userId, v.role), onSettled: refresh });
  const remove = useMutation({ mutationFn: (userId: string) => api.removeMember(userId), onSettled: refresh });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeInvite(id), onSettled: refresh });

  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-3">
        <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
          <table className="w-full min-w-[560px] border-collapse text-[13px]">
            <thead>
              <tr className="bg-surface-2 text-left text-xs text-muted">
                <th className="px-4 py-3 font-semibold">Person</th>
                <th className="px-2 py-3 font-semibold">Role</th>
                <th className="px-2 py-3 font-semibold">Last sign-in</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {members.data?.map((m) => (
                <tr key={m.userId} className="border-t border-line-soft">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-inverse text-xs font-bold text-on-inverse" aria-hidden>
                        {initials(m.name)}
                      </span>
                      <span className="flex flex-col">
                        <span className="font-semibold">
                          {m.name} {m.you ? <span className="font-normal text-muted">(you)</span> : null}
                        </span>
                        <span className="text-xs text-muted">{m.email}</span>
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    {canManage ? (
                      <Select
                        aria-label={`${m.name}'s role`}
                        value={m.role}
                        className="!h-[34px] !w-auto text-[13px] font-semibold"
                        disabled={setMemberRole.isPending || (m.role === "owner" && me.role !== "owner")}
                        onChange={(e) => setMemberRole.mutate({ userId: m.userId, role: e.target.value as RoleName })}
                      >
                        {(["owner", "editor", "runner", "viewer"] as const).map((r) => (
                          <option key={r} value={r} disabled={r === "owner" && me.role !== "owner"}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Pill>{m.role}</Pill>
                    )}
                  </td>
                  <td className="px-2 py-3 text-muted">{m.lastSignInAt ? ago(m.lastSignInAt) : "Never"}</td>
                  <td className="px-4 py-3 text-right">
                    {canManage && !m.you ? (
                      <button
                        type="button"
                        className="text-xs font-semibold text-bad hover:underline"
                        onClick={() => {
                          if (confirm(`Remove ${m.name}? Their sessions and access tokens stop working.`)) remove.mutate(m.userId);
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorNote error={setMemberRole.error ?? remove.error} />
        <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 text-xs text-muted">
          {(Object.keys(ROLE_HELP) as RoleName[]).map((r) => (
            <li key={r}>
              <strong className="text-ink-2">{r}</strong>: {ROLE_HELP[r]}
            </li>
          ))}
        </ul>
      </div>

      {canManage ? (
        <aside className="flex max-w-[380px] flex-[1_1_300px] flex-col gap-3.5">
          <Card as="section" className="flex flex-col gap-3 p-[18px]">
            <h2 className="m-0 text-[15px] font-semibold">Invite someone</h2>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                invite.mutate();
              }}
            >
              <Field label="Email (optional)" htmlFor="inv-email" help="With an email, only that person can use the link.">
                <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Role" htmlFor="inv-role" help={ROLE_HELP[role]}>
                <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as RoleName)}>
                  {(["viewer", "runner", "editor", "owner"] as const).map((r) => (
                    <option key={r} value={r} disabled={r === "owner" && me.role !== "owner"}>
                      {r}
                    </option>
                  ))}
                </Select>
              </Field>
              <ErrorNote error={invite.error} />
              <Button type="submit" variant="primary" disabled={invite.isPending}>
                Create invite link
              </Button>
            </form>
            {link ? (
              <div className="flex flex-col gap-2 rounded-[10px] border border-good bg-good-soft p-3">
                <span className="text-xs font-semibold text-good">Send this link. It works once and expires in 7 days; it will not be shown again.</span>
                <code className="font-mono text-xs break-all text-ink">{link}</code>
                <Button size="sm" className="self-start" onClick={() => void navigator.clipboard.writeText(link)}>
                  Copy link
                </Button>
              </div>
            ) : null}
          </Card>
          {invites.data && invites.data.length > 0 ? (
            <Card as="section" className="flex flex-col gap-2 p-[18px]">
              <h2 className="m-0 text-[15px] font-semibold">Pending invites</h2>
              {invites.data.map((i) => (
                <div key={i.id} className="flex items-center gap-2 text-[13px]">
                  <span className="flex-1 truncate">{i.email ?? "Anyone with the link"}</span>
                  <Pill>{i.role}</Pill>
                  <button type="button" className="text-xs font-semibold text-bad hover:underline" onClick={() => revoke.mutate(i.id)}>
                    Revoke
                  </button>
                </div>
              ))}
            </Card>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

function TokensSection() {
  const qc = useQueryClient();
  const me = useMe();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: api.tokens });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<PermissionName[]>(["workspace:read"]);
  const [days, setDays] = useState("90");
  const [made, setMade] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createToken({ name, scopes, expiresInDays: days ? Number(days) : null }),
    onSuccess: (r) => {
      setMade(r.token);
      setName("");
      void qc.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeToken(id), onSettled: () => void qc.invalidateQueries({ queryKey: ["tokens"] }) });

  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-3">
        <p className="m-0 text-sm text-muted">
          Tokens let scripts and outside agents call Conclave as you, limited to the scopes you pick. Send them as <code className="font-mono text-xs">Authorization: Bearer cnc_…</code>.
        </p>
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {tokens.data?.map((t, i) => (
            <div key={t.id} className={cx("flex flex-wrap items-center gap-3 px-4 py-3", i > 0 && "border-t border-line-soft")}>
              <span className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                <span className="text-sm font-semibold">{t.name}</span>
                <span className="font-mono text-xs text-muted">{t.prefix}…</span>
              </span>
              <span className="flex max-w-[320px] flex-wrap gap-1">
                {t.scopes.map((s) => (
                  <Pill key={s}>{s}</Pill>
                ))}
              </span>
              <span className="w-28 text-right text-xs text-muted">{t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : "never used"}</span>
              <button
                type="button"
                className="text-xs font-semibold text-bad hover:underline"
                onClick={() => {
                  if (confirm(`Revoke ${t.name}? Anything using it stops working.`)) revoke.mutate(t.id);
                }}
              >
                Revoke
              </button>
            </div>
          ))}
          {tokens.data?.length === 0 ? <p className="m-0 px-4 py-6 text-center text-[13px] text-muted">No tokens yet.</p> : null}
        </div>
      </div>
      <aside className="flex max-w-[380px] flex-[1_1_300px] flex-col gap-3.5">
        <Card as="section" className="flex flex-col gap-3 p-[18px]">
          <h2 className="m-0 text-[15px] font-semibold">Create a token</h2>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Name" htmlFor="tok-name">
              <Input id="tok-name" placeholder="Nightly report script" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 p-0 text-[13px] font-semibold">Scopes</legend>
              {SCOPES.filter((s) => me.permissions.includes(s.value)).map((s) => (
                <label key={s.value} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s.value)}
                    onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s.value] : cur.filter((x) => x !== s.value)))}
                    className="h-[18px] w-[18px] accent-[var(--accent)]"
                  />
                  {s.label}
                </label>
              ))}
            </fieldset>
            <Field label="Expires after (days)" htmlFor="tok-days" help="Leave empty for no expiry.">
              <Input id="tok-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <ErrorNote error={create.error} />
            <Button type="submit" variant="primary" disabled={!name.trim() || scopes.length === 0 || create.isPending}>
              Create token
            </Button>
          </form>
          {made ? (
            <div className="flex flex-col gap-2 rounded-[10px] border border-good bg-good-soft p-3">
              <span className="text-xs font-semibold text-good">Copy it now. It will not be shown again.</span>
              <code className="font-mono text-xs break-all text-ink">{made}</code>
              <Button size="sm" className="self-start" onClick={() => void navigator.clipboard.writeText(made)}>
                Copy token
              </Button>
            </div>
          ) : null}
        </Card>
      </aside>
    </div>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("account");
  const me = useMe();
  const canManageOrg = useCan("org:manage");
  const tabs: { key: Tab; label: string }[] = [
    { key: "account", label: "Account" },
    { key: "security", label: "Security" },
    { key: "notifications", label: "Notifications" },
    { key: "members", label: "Members" },
    { key: "tokens", label: "Access tokens" },
    { key: "devices", label: "Devices" },
    // Only owners manage how people sign in.
    ...(canManageOrg ? [{ key: "sso" as const, label: "Single sign-on" }] : []),
  ];
  return (
    <main className="flex flex-col gap-5 px-4 py-5 md:px-9 md:py-7">
      <PageHeader title="Settings" subtitle={`${me.user.name} · ${me.org.name} · ${me.role}`} />
      <nav aria-label="Settings sections" className="no-scrollbar flex gap-6 overflow-x-auto whitespace-nowrap border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-current={tab === t.key ? "page" : undefined}
            onClick={() => setTab(t.key)}
            className={cx("-mb-px border-b-2 px-0.5 py-2.5 text-sm", tab === t.key ? "border-accent font-semibold text-accent-ink" : "border-transparent text-ink-2 hover:text-ink")}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "account" ? <AccountSection /> : tab === "security" ? <SecuritySection /> : tab === "notifications" ? <NotificationsSection /> : tab === "members" ? <MembersSection /> : tab === "sso" ? <SsoSection /> : tab === "devices" ? <DevicesSection /> : <TokensSection />}
    </main>
  );
}

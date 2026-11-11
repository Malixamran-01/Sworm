import type { AuthStateDto, MfaChallengeDto } from "@conclave/contract";
import { browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { Button, ErrorNote, Field, Input } from "../../ui";

/** Centered card on the warm background, with the Conclave mark. */
function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="flex w-full max-w-[420px] flex-col gap-6">
        <div className="flex items-center justify-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-[15px] font-bold text-on-accent" aria-hidden>
            C
          </span>
          <span className="text-lg font-bold">Conclave</span>
        </div>
        <section className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-7">
          <header className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[22px] font-bold tracking-[-0.01em]">{title}</h1>
            {subtitle ? <p className="m-0 text-sm text-muted">{subtitle}</p> : null}
          </header>
          {children}
        </section>
      </div>
    </main>
  );
}

const useRefreshAuth = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
};

export function SetupPage({ state }: { state: AuthStateDto }) {
  const refresh = useRefreshAuth();
  const [form, setForm] = useState({ name: "", email: "", password: "", orgName: "", setupCode: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setup = useMutation({
    mutationFn: () => {
      const { setupCode, orgName, ...rest } = form;
      return api.setup({ ...rest, ...(orgName.trim() ? { orgName } : {}), ...(state.setupCodeRequired ? { setupCode } : {}) });
    },
    onSuccess: refresh,
  });

  return (
    <AuthCard title="Set up Conclave" subtitle="Create the owner account for this instance. You can invite your team afterwards.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setup.mutate();
        }}
      >
        <Field label="Your name" htmlFor="setup-name">
          <Input id="setup-name" autoComplete="name" value={form.name} onChange={set("name")} required />
        </Field>
        <Field label="Email" htmlFor="setup-email">
          <Input id="setup-email" type="email" autoComplete="email" value={form.email} onChange={set("email")} required />
        </Field>
        <Field label="Password" htmlFor="setup-password" help="At least 10 characters.">
          <Input id="setup-password" type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={set("password")} required />
        </Field>
        <Field label="Organisation name (optional)" htmlFor="setup-org">
          <Input id="setup-org" placeholder="My organisation" value={form.orgName} onChange={set("orgName")} />
        </Field>
        {state.setupCodeRequired ? (
          <Field label="Setup code" htmlFor="setup-code" help="Printed in the server log. It proves you run this server.">
            <Input id="setup-code" inputMode="numeric" className="font-mono" value={form.setupCode} onChange={set("setupCode")} required />
          </Field>
        ) : null}
        <ErrorNote error={setup.error} />
        <Button type="submit" variant="primary" size="lg" disabled={setup.isPending}>
          {setup.isPending ? "Creating…" : "Create owner account"}
        </Button>
      </form>
    </AuthCard>
  );
}

function Providers({ state }: { state: AuthStateDto }) {
  if (state.providers.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-2">
        {state.providers.map((p) => (
          <a
            key={p.id}
            href={p.startUrl}
            className="flex h-10 items-center justify-center rounded-[9px] border border-line-strong bg-surface text-sm font-semibold text-ink no-underline hover:bg-sunken hover:text-ink"
          >
            Continue with {p.name}
          </a>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-line" />
        or with email
        <span className="h-px flex-1 bg-line" />
      </div>
    </>
  );
}

export function SignInPage({ state }: { state: AuthStateDto }) {
  const refresh = useRefreshAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [second, setSecond] = useState<MfaChallengeDto | null>(null);
  const providerError = new URLSearchParams(location.search).get("error");
  const signIn = useMutation({
    mutationFn: () => api.signIn({ email, password }),
    onSuccess: async (r) => {
      if ("mfaRequired" in r) setSecond(r.mfaRequired);
      else await refresh();
    },
  });
  const passkey = useMutation({
    mutationFn: async () => {
      const { challengeId, options } = await api.passkeySignInOptions();
      const response = await startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON });
      return api.passkeySignIn({ challengeId, response });
    },
    onSuccess: refresh,
  });

  if (second) return <SecondStep challenge={second} onBack={() => setSecond(null)} onDone={refresh} />;

  return (
    <AuthCard title="Sign in" subtitle="Welcome back.">
      {providerError ? <ErrorNote error={new Error(providerError)} /> : null}
      <Providers state={state} />
      {browserSupportsWebAuthn() && (
        <>
          <Button size="lg" disabled={passkey.isPending} onClick={() => passkey.mutate()}>
            {passkey.isPending ? "Waiting for your passkey…" : "Sign in with a passkey"}
          </Button>
          <ErrorNote error={passkey.error && !isCancel(passkey.error) ? passkey.error : null} />
          <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          signIn.mutate();
        }}
      >
        <Field label="Email" htmlFor="signin-email">
          <Input id="signin-email" type="email" autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Password" htmlFor="signin-password">
          <Input id="signin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorNote error={signIn.error} />
        <Button type="submit" variant="primary" size="lg" disabled={signIn.isPending}>
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="m-0 text-center text-xs text-muted">New here? Ask an owner of this instance for an invite link.</p>
    </AuthCard>
  );
}

/** A closed or cancelled passkey prompt is not an error worth showing. */
const isCancel = (err: unknown) => err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError");

function SecondStep({ challenge, onBack, onDone }: { challenge: MfaChallengeDto; onBack: () => void; onDone: () => Promise<unknown> }) {
  const hasTotp = challenge.methods.includes("totp");
  const hasPasskey = challenge.methods.includes("passkey") && !!challenge.passkeyOptions && browserSupportsWebAuthn();
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [code, setCode] = useState("");
  const submit = useMutation({
    mutationFn: () => api.completeSignIn({ ticket: challenge.ticket, ...(mode === "totp" ? { code } : { recoveryCode: code }) }),
    onSuccess: onDone,
  });
  const passkey = useMutation({
    mutationFn: async () => {
      const response = await startAuthentication({ optionsJSON: challenge.passkeyOptions as PublicKeyCredentialRequestOptionsJSON });
      return api.completeSignIn({ ticket: challenge.ticket, passkey: response });
    },
    onSuccess: onDone,
  });

  return (
    <AuthCard title="One more step" subtitle={hasTotp ? "Enter the code from your authenticator app." : "Confirm it is you with your passkey."}>
      {hasPasskey && (
        <Button variant={hasTotp ? "secondary" : "primary"} size="lg" disabled={passkey.isPending} onClick={() => passkey.mutate()}>
          {passkey.isPending ? "Waiting for your passkey…" : "Use a passkey"}
        </Button>
      )}
      <ErrorNote error={passkey.error && !isCancel(passkey.error) ? passkey.error : null} />
      {hasTotp && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          <Field label={mode === "totp" ? "Six-digit code" : "Recovery code"} htmlFor="mfa-code">
            <Input
              id="mfa-code"
              value={code}
              onChange={(e) => setCode(mode === "totp" ? e.target.value.replace(/\D/g, "").slice(0, 6) : e.target.value)}
              inputMode={mode === "totp" ? "numeric" : "text"}
              autoComplete="one-time-code"
              placeholder={mode === "totp" ? "123456" : "abcde-fghij"}
              required
              autoFocus
              className="font-mono tracking-widest"
            />
          </Field>
          <ErrorNote error={submit.error} />
          <Button type="submit" variant="primary" size="lg" disabled={submit.isPending || (mode === "totp" && code.length !== 6)}>
            {submit.isPending ? "Checking…" : "Continue"}
          </Button>
          <button
            type="button"
            className="self-start text-xs font-semibold text-accent-ink hover:underline"
            onClick={() => {
              setMode(mode === "totp" ? "recovery" : "totp");
              setCode("");
            }}
          >
            {mode === "totp" ? "Lost your phone? Use a recovery code" : "Use the authenticator app instead"}
          </button>
        </form>
      )}
      <button type="button" className="self-center text-xs text-muted hover:underline" onClick={onBack}>
        Back to sign-in
      </button>
    </AuthCard>
  );
}

export function InvitePage({ token, state }: { token: string; state: AuthStateDto }) {
  const refresh = useRefreshAuth();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.inviteInfo(token), retry: false });
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token, state.me ? {} : { ...form, email: form.email || info.data?.email || "" }),
    onSuccess: async () => {
      history.replaceState(null, "", "/");
      await refresh();
    },
  });

  if (info.isLoading) return <AuthCard title="Opening your invite…">{null}</AuthCard>;
  if (info.error || !info.data) {
    return (
      <AuthCard title="This invite does not work" subtitle="It may have expired, been used, or been revoked. Ask for a new link.">
        <a href="/" className="text-sm font-semibold">
          Go to sign-in
        </a>
      </AuthCard>
    );
  }
  const { orgName, role, email } = info.data;
  const subtitle = (
    <>
      You are invited to <strong className="text-ink">{orgName}</strong> as {role === "owner" || role === "editor" ? "an" : "a"} <strong className="text-ink">{role}</strong>.
    </>
  );

  if (state.me) {
    return (
      <AuthCard title="Join the organisation" subtitle={subtitle}>
        <p className="m-0 text-sm text-muted">You are signed in as {state.me.user.email}.</p>
        <ErrorNote error={accept.error} />
        <Button variant="primary" size="lg" disabled={accept.isPending} onClick={() => accept.mutate()}>
          Join {orgName}
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your account" subtitle={subtitle}>
      <Providers state={state} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          accept.mutate();
        }}
      >
        <Field label="Your name" htmlFor="inv-name">
          <Input id="inv-name" autoComplete="name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
        </Field>
        <Field label="Email" htmlFor="inv-email">
          <Input
            id="inv-email"
            type="email"
            autoComplete="email"
            value={email ?? form.email}
            readOnly={!!email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            required
          />
        </Field>
        <Field label="Password" htmlFor="inv-password" help="At least 10 characters.">
          <Input id="inv-password" type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required />
        </Field>
        <ErrorNote error={accept.error} />
        <Button type="submit" variant="primary" size="lg" disabled={accept.isPending}>
          {accept.isPending ? "Joining…" : `Join ${orgName}`}
        </Button>
      </form>
      <p className="m-0 text-center text-xs text-muted">
        Already have an account? <a href="/sign-in">Sign in</a>, then open this link again.
      </p>
    </AuthCard>
  );
}

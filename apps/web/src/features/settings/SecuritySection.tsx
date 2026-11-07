import type { TotpSetupDto } from "@conclave/contract";
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { Button, Card, ErrorNote, Field, Input, Pill } from "../../ui";

const KEY = ["security"];
const digits = (v: string) => v.replace(/\D/g, "").slice(0, 6);

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join("\n");
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-warn-line bg-warn-soft p-4">
      <p className="m-0 text-[13px] font-semibold text-warn-ink">Save these recovery codes now. Each works once, and they will not be shown again.</p>
      <ol aria-label="Recovery codes" className="m-0 grid grid-cols-2 gap-x-6 gap-y-1 p-0 pl-5 font-mono text-[13px]">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(text)}>
          Copy
        </Button>
        <a
          className="flex h-8 items-center rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink no-underline"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`Conclave recovery codes\n\n${text}\n`)}`}
          download="conclave-recovery-codes.txt"
        >
          Download
        </a>
        <Button size="sm" variant="primary" onClick={onDone}>
          I saved them
        </Button>
      </div>
    </div>
  );
}

function TotpCard() {
  const qc = useQueryClient();
  const security = useQuery({ queryKey: KEY, queryFn: api.security });
  const [setup, setSetup] = useState<TotpSetupDto | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState<"off" | "codes" | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  const start = useMutation({ mutationFn: api.totpSetup, onSuccess: (s) => (setSetup(s), setCode("")) });
  const enable = useMutation({
    mutationFn: () => api.totpEnable(code),
    onSuccess: async (r) => {
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      await refresh();
    },
  });
  const disable = useMutation({ mutationFn: () => api.totpDisable({ code }), onSuccess: async () => (setConfirming(null), setCode(""), await refresh()) });
  const regenerate = useMutation({
    mutationFn: () => api.newRecoveryCodes(code),
    onSuccess: async (r) => (setCodes(r.recoveryCodes), setConfirming(null), setCode(""), await refresh()),
  });

  const totp = security.data?.totp;
  return (
    <Card as="section" aria-labelledby="sec-totp" className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="sec-totp" className="m-0 text-[15px] font-semibold">
          Authenticator app
        </h2>
        {totp?.enabled ? <Pill tone="good">On</Pill> : <Pill>Off</Pill>}
      </div>
      <p className="m-0 text-xs text-muted">After your password, sign-in asks for a six-digit code from an app like 1Password, Google Authenticator or Authy.</p>

      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

      {!totp?.enabled && !setup && (
        <Button className="self-start" variant="primary" disabled={start.isPending} onClick={() => start.mutate()}>
          Set up
        </Button>
      )}

      {setup && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <div className="flex flex-wrap items-start gap-4">
            <img src={setup.qr} alt="QR code to scan with your authenticator app" width={164} height={164} className="rounded-lg border border-line bg-white p-1" />
            <div className="flex min-w-[200px] flex-1 flex-col gap-2 text-[13px]">
              <span>1. Scan the code with your app.</span>
              <span>
                Can't scan? Enter this key: <code className="break-all rounded bg-sunken px-1.5 py-0.5 font-mono text-xs">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
              </span>
              <span>2. Enter the code the app shows.</span>
            </div>
          </div>
          <Field label="Code from the app" htmlFor="totp-code">
            <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(digits(e.target.value))} className="!w-40 font-mono tracking-widest" required />
          </Field>
          <ErrorNote error={enable.error} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={code.length !== 6 || enable.isPending}>
              Turn on
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {totp?.enabled && !codes && (
        <>
          <p className="m-0 text-[13px]">
            {totp.recoveryCodesLeft} recovery code{totp.recoveryCodesLeft === 1 ? "" : "s"} left.
            {totp.recoveryCodesLeft <= 3 ? " Make new ones soon." : ""}
          </p>
          {confirming ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                (confirming === "off" ? disable : regenerate).mutate();
              }}
            >
              <Field label="Current code from the app" htmlFor="totp-confirm">
                <Input id="totp-confirm" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(digits(e.target.value))} className="!w-40 font-mono tracking-widest" autoFocus />
              </Field>
              <Button type="submit" variant={confirming === "off" ? "danger" : "primary"} disabled={code.length !== 6}>
                {confirming === "off" ? "Turn off" : "Make new codes"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => (setConfirming(null), setCode(""))}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setConfirming("codes")}>
                New recovery codes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming("off")}>
                Turn off
              </Button>
            </div>
          )}
          <ErrorNote error={disable.error ?? regenerate.error} />
        </>
      )}
    </Card>
  );
}

function PasskeysCard() {
  const qc = useQueryClient();
  const security = useQuery({ queryKey: KEY, queryFn: api.security });
  const [name, setName] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const supported = browserSupportsWebAuthn();

  const add = useMutation({
    mutationFn: async () => {
      const { challengeId, options } = await api.passkeyOptions();
      const response = await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON });
      return api.addPasskey({ challengeId, response, ...(name.trim() ? { name: name.trim() } : {}) });
    },
    onSuccess: async () => (setName(""), await refresh()),
  });
  const remove = useMutation({ mutationFn: api.removePasskey, onSuccess: refresh });
  const cancelled = add.error instanceof Error && (add.error.name === "NotAllowedError" || add.error.name === "AbortError");

  return (
    <Card as="section" aria-labelledby="sec-passkeys" className="flex flex-col gap-4 p-5">
      <h2 id="sec-passkeys" className="m-0 text-[15px] font-semibold">
        Passkeys
      </h2>
      <p className="m-0 text-xs text-muted">
        Sign in with your fingerprint, face or device PIN instead of a password. A passkey also counts as your second step after a password.
      </p>
      {security.data?.passkeys.length ? (
        <ul aria-label="Your passkeys" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {security.data.passkeys.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sunken px-3 py-2 text-[13px]">
              <span>
                <span className="font-semibold">{p.name}</span>
                <span className="text-muted">
                  {" "}
                  · added {ago(p.createdAt)}
                  {p.lastUsedAt ? ` · used ${ago(p.lastUsedAt)}` : " · not used yet"}
                  {p.synced ? " · synced" : ""}
                </span>
              </span>
              <Button size="sm" variant="ghost" aria-label={`Remove ${p.name}`} disabled={remove.isPending} onClick={() => remove.mutate(p.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {supported ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Name" htmlFor="passkey-name">
            <Input id="passkey-name" value={name} placeholder="Work laptop" maxLength={80} onChange={(e) => setName(e.target.value)} className="!w-52" />
          </Field>
          <Button type="submit" variant="primary" disabled={add.isPending}>
            {add.isPending ? "Waiting for your device…" : "Add a passkey"}
          </Button>
        </form>
      ) : (
        <p className="m-0 text-[13px] text-muted">This browser cannot create passkeys.</p>
      )}
      <ErrorNote error={cancelled ? null : (add.error ?? remove.error)} />
    </Card>
  );
}

export function SecuritySection() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <TotpCard />
      <PasskeysCard />
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { Card, ErrorNote, Pill } from "../../ui";

/** A value to hand to the identity provider, with a copy button. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12px]">{value}</code>
        <button
          type="button"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="h-8 shrink-0 rounded-lg border border-line-strong px-2.5 text-xs font-semibold text-ink hover:bg-sunken"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

const ENV = [
  ["CONCLAVE_SAML_METADATA", "The identity provider's metadata: an https URL, a file path, or the XML itself."],
  ["CONCLAVE_SAML_NAME", "What the button says after “Continue with”. Default: single sign-on."],
  ["CONCLAVE_SAML_SSO_URL, CONCLAVE_SAML_IDP_CERT", "Instead of metadata: the sign-in URL and signing certificate."],
  ["CONCLAVE_SAML_SP_KEY, CONCLAVE_SAML_SP_CERT", "Optional: sign requests and accept encrypted assertions."],
  ["CONCLAVE_SAML_IDP_INITIATED=true", "Also accept sign-ins started from the identity provider's dashboard."],
  ["CONCLAVE_SAML_TRUST_EMAIL=false", "Do not link to existing accounts by the email the provider sends."],
] as const;

/** How single sign-on is set up (ACC-001), for owners. The settings live in the server's environment. */
export function SsoSection() {
  const sso = useQuery({ queryKey: ["sso"], queryFn: api.sso });
  if (sso.error) return <ErrorNote error={sso.error} />;
  if (!sso.data) return <p className="text-muted">Loading…</p>;
  const { saml, oidc } = sso.data;

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <Card as="section" className="flex flex-col gap-4 p-5" aria-labelledby="saml-title">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="saml-title" className="m-0 text-base font-semibold">
            SAML
          </h2>
          {saml ? <Pill tone="good">On · {saml.name}</Pill> : <Pill>Not set up</Pill>}
        </div>
        {saml ? (
          <>
            <p className="m-0 text-[13px] text-muted">Give these to your identity provider (Okta, Microsoft Entra ID, Google Workspace, OneLogin, Keycloak…). Most can read them all from the metadata URL.</p>
            <CopyRow label="Metadata URL" value={saml.metadataUrl} />
            <CopyRow label="Entity ID (audience)" value={saml.spEntityId} />
            <CopyRow label="Reply URL (Assertion Consumer Service)" value={saml.acsUrl} />
            <div className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
              <span className="text-muted">Identity provider</span>
              <span className="min-w-0 truncate">{saml.idpEntityId ?? "Not named in its metadata"}</span>
              <span className="text-muted">Sign-in URL</span>
              <span className="min-w-0 truncate">{saml.idpSsoUrl}</span>
              <span className="text-muted">Started from its dashboard</span>
              <span>{saml.idpInitiated ? "Accepted" : "Not accepted: sign-ins start here"}</span>
              <span className="text-muted">Existing accounts</span>
              <span>{saml.trustEmail ? "Linked by the email it sends" : "Not linked by email"}</span>
              <span className="text-muted">Our requests</span>
              <span>{saml.signsRequests ? "Signed" : "Not signed"}</span>
            </div>
            <section className="flex flex-col gap-1.5" aria-label="Signing certificates">
              <span className="text-xs font-semibold text-muted">Its signing certificates</span>
              {saml.certificates.map((c) => (
                <div key={c.expiresAt + c.subject} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                  <Pill tone={c.daysLeft < 0 ? "bad" : c.daysLeft < 30 ? "warn" : "neutral"}>
                    {c.daysLeft < 0 ? "Expired" : `Expires in ${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"}`}
                  </Pill>
                </div>
              ))}
              {saml.certificates.some((c) => c.daysLeft < 30) ? (
                <p role="status" className="m-0 text-xs text-warn-ink">
                  Get the new certificate from your identity provider and update CONCLAVE_SAML_METADATA before it expires, or sign-in will stop working.
                </p>
              ) : null}
            </section>
            <p className="m-0 text-xs text-muted">Each reply must be signed, answer a sign-in started here within 10 minutes, and is used once. New people still need an invite or an allowed email domain.</p>
          </>
        ) : (
          <>
            <p className="m-0 text-[13px] text-muted">Sign-in with a SAML identity provider is set in the server environment. Set these and restart:</p>
            <dl className="m-0 grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[auto_1fr]">
              {ENV.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>
                    <code className="text-[12px]">{k}</code>
                  </dt>
                  <dd className="m-0 text-muted">{v}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </Card>

      <Card as="section" className="flex flex-col gap-3 p-5" aria-labelledby="oidc-title">
        <h2 id="oidc-title" className="m-0 text-base font-semibold">
          OpenID Connect and GitHub
        </h2>
        {oidc.length ? (
          oidc.map((p) => <CopyRow key={p.id} label={`${p.name}: redirect URL`} value={p.callbackUrl} />)
        ) : (
          <p className="m-0 text-[13px] text-muted">None set up. Google, GitHub and any OpenID Connect provider are set with CONCLAVE_GOOGLE_*, CONCLAVE_GITHUB_* and CONCLAVE_OIDC_* in the server environment.</p>
        )}
      </Card>
    </div>
  );
}

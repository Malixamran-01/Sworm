import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import type { OutsideIdentity } from "@conclave/core";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * SAML 2.0 sign-in (ACC-001): Okta, Microsoft Entra ID, Google Workspace,
 * OneLogin, Keycloak, ADFS and any other SAML identity provider.
 *
 * SP-initiated, HTTP-Redirect to the IdP and HTTP-POST back. Defaults are strict:
 * assertions must be signed, replies must answer a request this instance made
 * (each once, within 10 minutes), and the audience and issuer are checked.
 * Signature checks are left to @node-saml/node-saml, which guards against
 * signature wrapping; Conclave never parses an assertion itself.
 */

export interface SamlSettings {
  /** The button says "Continue with {name}". */
  name: string;
  /** This instance's entity ID, which the IdP knows it by. */
  spEntityId: string;
  /** Where the IdP posts its reply. */
  acsUrl: string;
  metadataUrl: string;
  idpEntityId: string | null;
  idpSsoUrl: string;
  /** PEM certificates the IdP signs with; more than one during a rollover. */
  idpCerts: string[];
  /** Optional: signs our requests and decrypts encrypted assertions. */
  spPrivateKey: string | null;
  spCert: string | null;
  /** Accept sign-ins the IdP starts (from its app dashboard). Off by default. */
  allowIdpInitiated: boolean;
  /** Link to existing accounts by the email the IdP sends. On by default: the owner chose to trust this IdP. */
  trustEmail: boolean;
  emailAttribute: string | null;
}

export interface IdpMetadata {
  entityId: string | null;
  ssoUrl: string | null;
  certs: string[];
}

const MD = "urn:oasis:names:tc:SAML:2.0:metadata";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";

const pem = (body: string) => `-----BEGIN CERTIFICATE-----\n${body.replace(/\s+/g, "").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END CERTIFICATE-----`;

/** Read the IdP's entity ID, its HTTP-Redirect sign-in URL and its signing certificates from metadata XML. */
export function parseIdpMetadata(xml: string): IdpMetadata {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const entity = doc.getElementsByTagNameNS(MD, "EntityDescriptor")[0];
  const idp = doc.getElementsByTagNameNS(MD, "IDPSSODescriptor")[0];
  if (!idp) throw new Error("The SAML metadata has no identity provider (IDPSSODescriptor).");
  const sso = Array.from(idp.getElementsByTagNameNS(MD, "SingleSignOnService")).find((e) => e.getAttribute("Binding") === REDIRECT);
  const certs: string[] = [];
  for (const kd of Array.from(idp.getElementsByTagNameNS(MD, "KeyDescriptor"))) {
    const use = kd.getAttribute("use");
    if (use && use !== "signing") continue;
    for (const c of Array.from(kd.getElementsByTagNameNS(DS, "X509Certificate"))) {
      const body = c.textContent?.trim();
      if (body && !certs.some((x) => x.includes(body.slice(0, 40)))) certs.push(pem(body));
    }
  }
  return { entityId: entity?.getAttribute("entityID") ?? null, ssoUrl: sso?.getAttribute("Location") ?? null, certs };
}

/** A value that is a PEM, a file path, or (for metadata) raw XML or an https URL. */
const readish = (v: string) => (!v.trim().startsWith("<") && !v.includes("-----BEGIN") && existsSync(v) ? readFileSync(v, "utf8") : v);

/**
 * SAML settings from the environment, or null when SAML is off. Metadata may
 * be a file path, the XML itself, or an https URL (fetched once at start).
 */
export async function samlFromEnv(env: NodeJS.ProcessEnv, publicUrl: string, fetchImpl: typeof fetch = fetch): Promise<SamlSettings | null> {
  const source = env.CONCLAVE_SAML_METADATA;
  if (!source && !env.CONCLAVE_SAML_SSO_URL) return null;
  let meta: IdpMetadata = { entityId: null, ssoUrl: null, certs: [] };
  if (source) {
    const xml = /^https:\/\//i.test(source.trim())
      ? await fetchImpl(source.trim()).then((r) => {
          if (!r.ok) throw new Error(`Could not read the SAML metadata at ${source} (${r.status}).`);
          return r.text();
        })
      : readish(source);
    meta = parseIdpMetadata(xml);
  }
  const certs = env.CONCLAVE_SAML_IDP_CERT ? [readish(env.CONCLAVE_SAML_IDP_CERT)] : meta.certs;
  const ssoUrl = env.CONCLAVE_SAML_SSO_URL ?? meta.ssoUrl;
  if (!ssoUrl) throw new Error("SAML is set up without a sign-in URL: the metadata has no HTTP-Redirect SingleSignOnService, and CONCLAVE_SAML_SSO_URL is not set.");
  if (!certs.length) throw new Error("SAML is set up without the identity provider's signing certificate (metadata or CONCLAVE_SAML_IDP_CERT).");
  const base = publicUrl.replace(/\/+$/, "");
  return {
    name: env.CONCLAVE_SAML_NAME ?? "single sign-on",
    spEntityId: env.CONCLAVE_SAML_ENTITY_ID ?? `${base}/v1/auth/saml/metadata`,
    acsUrl: `${base}/v1/auth/saml/acs`,
    metadataUrl: `${base}/v1/auth/saml/metadata`,
    idpEntityId: env.CONCLAVE_SAML_IDP_ENTITY_ID ?? meta.entityId,
    idpSsoUrl: ssoUrl,
    idpCerts: certs,
    spPrivateKey: env.CONCLAVE_SAML_SP_KEY ? readish(env.CONCLAVE_SAML_SP_KEY) : null,
    spCert: env.CONCLAVE_SAML_SP_CERT ? readish(env.CONCLAVE_SAML_SP_CERT) : null,
    allowIdpInitiated: env.CONCLAVE_SAML_IDP_INITIATED === "true",
    trustEmail: env.CONCLAVE_SAML_TRUST_EMAIL !== "false",
    emailAttribute: env.CONCLAVE_SAML_EMAIL_ATTRIBUTE ?? null,
  };
}

const EMAIL_CLAIMS = [
  "email",
  "mail",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "emailAddress",
];
const NAME_CLAIMS = ["displayName", "name", "urn:oid:2.16.840.1.113730.3.1.241", "http://schemas.microsoft.com/identity/claims/displayname", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"];
const GIVEN = ["givenName", "firstName", "urn:oid:2.5.4.42", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"];
const FAMILY = ["sn", "surname", "lastName", "urn:oid:2.5.4.4", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"];

const first = (p: Profile, keys: string[]): string | null => {
  for (const k of keys) {
    const v = p[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return null;
};

/** What an owner sees in Settings, and how close each IdP certificate is to expiring. */
export interface SamlSummary {
  name: string;
  spEntityId: string;
  acsUrl: string;
  metadataUrl: string;
  idpEntityId: string | null;
  idpSsoUrl: string;
  idpInitiated: boolean;
  trustEmail: boolean;
  signsRequests: boolean;
  certificates: { subject: string; expiresAt: string; daysLeft: number }[];
}

export class SamlSignIn {
  readonly settings: SamlSettings;
  private readonly saml: SAML;

  constructor(settings: SamlSettings) {
    this.settings = settings;
    this.saml = new SAML({
      callbackUrl: settings.acsUrl,
      entryPoint: settings.idpSsoUrl,
      issuer: settings.spEntityId,
      audience: settings.spEntityId,
      idpCert: settings.idpCerts,
      ...(settings.idpEntityId ? { idpIssuer: settings.idpEntityId } : {}),
      // The assertion must be signed; some IdPs sign only it, not the whole response.
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: settings.allowIdpInitiated ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: 10 * 60_000,
      acceptedClockSkewMs: 60_000,
      // Let the IdP choose its NameID format and how people authenticate (so its MFA rules apply).
      identifierFormat: null,
      disableRequestedAuthnContext: true,
      signatureAlgorithm: "sha256",
      ...(settings.spPrivateKey ? { privateKey: settings.spPrivateKey, decryptionPvk: settings.spPrivateKey } : {}),
    });
  }

  provider(): { id: string; name: string; startUrl: string } {
    return { id: "saml", name: this.settings.name, startUrl: "/v1/auth/saml/start" };
  }

  /** The XML to give the IdP: entity ID, where to post replies, and our certificate if we sign. */
  metadata(): string {
    return this.saml.generateServiceProviderMetadata(this.settings.spCert, this.settings.spCert);
  }

  /** The IdP URL to send the browser to, carrying a fresh request this instance will expect an answer to. */
  start(): Promise<string> {
    return this.saml.getAuthorizeUrlAsync("", undefined, {});
  }

  /** Check the IdP's posted reply and turn it into an identity. Throws a readable reason when it is not valid. */
  async finish(body: { SAMLResponse?: string }): Promise<OutsideIdentity> {
    if (!body.SAMLResponse) throw new Error("The identity provider sent no SAML response.");
    let profile: Profile | null;
    try {
      ({ profile } = await this.saml.validatePostResponseAsync({ SAMLResponse: body.SAMLResponse }));
    } catch (err) {
      throw new Error(`The identity provider's reply was not accepted: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!profile?.nameID) throw new Error("The identity provider's reply named no user.");
    const fromNameId = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(profile.nameID) ? profile.nameID : null;
    const email = (this.settings.emailAttribute ? first(profile, [this.settings.emailAttribute]) : null) ?? first(profile, EMAIL_CLAIMS) ?? fromNameId;
    const given = first(profile, GIVEN);
    const family = first(profile, FAMILY);
    const name = first(profile, NAME_CLAIMS) ?? ([given, family].filter(Boolean).join(" ") || null);
    return {
      provider: `saml:${this.settings.idpEntityId ?? "default"}`,
      subject: profile.nameID,
      email,
      emailVerified: !!email && this.settings.trustEmail,
      name,
    };
  }

  summary(now = new Date()): SamlSummary {
    const s = this.settings;
    return {
      name: s.name,
      spEntityId: s.spEntityId,
      acsUrl: s.acsUrl,
      metadataUrl: s.metadataUrl,
      idpEntityId: s.idpEntityId,
      idpSsoUrl: s.idpSsoUrl,
      idpInitiated: s.allowIdpInitiated,
      trustEmail: s.trustEmail,
      signsRequests: !!s.spPrivateKey,
      certificates: s.idpCerts.flatMap((c) => {
        try {
          const x = new X509Certificate(c);
          const expires = new Date(x.validTo);
          return [{ subject: x.subject.replace(/\n/g, ", "), expiresAt: expires.toISOString(), daysLeft: Math.floor((expires.getTime() - now.getTime()) / 86_400_000) }];
        } catch {
          return [];
        }
      }),
    };
  }
}

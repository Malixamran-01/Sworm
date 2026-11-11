import { createConclave, SecretVault, type Conclave } from "@conclave/core";
import { createTestDb } from "@conclave/db";
import mockModel from "@conclave/module-mock-model";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { generate } from "selfsigned";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignedXml } from "xml-crypto";
import { buildApp } from "../app";
import { parseIdpMetadata, SamlSignIn, type SamlSettings } from "./saml";

/** SAML sign-in (ACC-001) against a fake identity provider that signs real assertions. */

const PUBLIC = "http://localhost:8787";
const IDP = "https://idp.example.test/saml";
const SSO = "https://idp.example.test/sso";
const SP = `${PUBLIC}/v1/auth/saml/metadata`;
const ACS = `${PUBLIC}/v1/auth/saml/acs`;
const PASSWORD = "correct horse battery";

let idp: { key: string; cert: string };
let other: { key: string; cert: string };
let conclave: Conclave;
let app: FastifyInstance;
let ownerCookie = "";

const certBody = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

beforeAll(async () => {
  // Fresh test-only keys each run, so no private key ever sits in the repository.
  const make = async (cn: string) => {
    const r = await generate([{ name: "commonName", value: cn }], { keySize: 2048, algorithm: "sha256", notAfterDate: new Date(Date.now() + 20 * 86_400_000) });
    return { key: r.private, cert: r.cert };
  };
  [idp, other] = await Promise.all([make("Test IdP"), make("Someone else")]);
});

const metadataXml = () => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(idp.cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(other.cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${SSO}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SSO}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

function settings(extra: Partial<SamlSettings> = {}): SamlSettings {
  const meta = parseIdpMetadata(metadataXml());
  return {
    name: "Acme SSO",
    spEntityId: SP,
    acsUrl: ACS,
    metadataUrl: SP,
    idpEntityId: meta.entityId,
    idpSsoUrl: meta.ssoUrl!,
    idpCerts: meta.certs,
    spPrivateKey: null,
    spCert: null,
    allowIdpInitiated: false,
    trustEmail: true,
    emailAttribute: null,
    ...extra,
  };
}

async function boot(saml: SamlSettings | null = settings()) {
  conclave = await createConclave({ db: await createTestDb(), modules: [mockModel], masterKey: SecretVault.generateMasterKey() });
  await conclave.bootstrapOwner();
  app = await buildApp({ conclave, publicUrl: PUBLIC, saml: saml ? new SamlSignIn(saml) : null });
  const res = await app.inject({ method: "POST", url: "/v1/auth/setup", payload: { name: "Ada", email: "ada@example.com", password: PASSWORD, orgName: "Ada Co" } });
  ownerCookie = String([res.headers["set-cookie"] ?? []].flat()[0] ?? "").split(";")[0]!;
}

beforeEach(() => boot());
afterEach(async () => {
  await app.close();
  await conclave.stop();
  await conclave.db.close();
});

/** Start a sign-in and read the request ID the IdP would answer. */
async function startRequest(): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/v1/auth/saml/start" });
  expect(res.statusCode).toBe(302);
  const url = new URL(String(res.headers.location));
  expect(url.origin + url.pathname).toBe(SSO);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString();
  expect(xml).toContain(`AssertionConsumerServiceURL="${ACS}"`);
  return /ID="([^"]+)"/.exec(xml)![1]!;
}

interface Reply {
  inResponseTo?: string | null;
  email?: string;
  audience?: string;
  signWith?: { key: string; cert: string } | null;
  tamper?: (signedXml: string) => string;
}

/** A signed SAML response, as the IdP would post it. */
function response(r: Reply = {}): string {
  const now = new Date();
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const irt = r.inResponseTo === null ? "" : ` InResponseTo="${r.inResponseTo}"`;
  const email = r.email ?? "ada@example.com";
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID()}" Version="2.0" IssueInstant="${at(0)}" Destination="${ACS}"${irt}>` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="_a${randomUUID()}" Version="2.0" IssueInstant="${at(0)}">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">user-${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} Recipient="${ACS}" NotOnOrAfter="${at(300_000)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${at(-60_000)}" NotOnOrAfter="${at(300_000)}"><saml:AudienceRestriction><saml:Audience>${r.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${at(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="http://schemas.microsoft.com/identity/claims/displayname"><saml:AttributeValue>Ada Lovelace</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  let out = xml;
  const signer = r.signWith === undefined ? idp : r.signWith;
  if (signer) {
    const sig = new SignedXml({
      privateKey: signer.key,
      publicCert: signer.cert,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
    out = sig.getSignedXml();
  }
  return Buffer.from(r.tamper ? r.tamper(out) : out).toString("base64");
}

/** Post a response to the ACS like the IdP's auto-submitting form: no CSRF header, a form body. */
async function post(samlResponse: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/saml/acs",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `SAMLResponse=${encodeURIComponent(samlResponse)}&RelayState=`,
  });
  const location = String(res.headers.location ?? "");
  const cookie = String([res.headers["set-cookie"] ?? []].flat()[0] ?? "").split(";")[0]!;
  return { status: res.statusCode, location, cookie, error: new URL(location, PUBLIC).searchParams.get("error") };
}

describe("SAML sign-in (ACC-001)", () => {
  it("reads IdP metadata, publishes ours, and shows a button", async () => {
    const meta = parseIdpMetadata(metadataXml());
    expect(meta).toMatchObject({ entityId: IDP, ssoUrl: SSO });
    // Only the signing certificate counts, not the encryption one.
    expect(meta.certs).toHaveLength(1);

    const res = await app.inject({ method: "GET", url: "/v1/auth/saml/metadata" });
    expect(res.headers["content-type"]).toContain("application/samlmetadata+xml");
    expect(res.body).toContain(`entityID="${SP}"`);
    expect(res.body).toContain(`Location="${ACS}"`);

    const state = JSON.parse((await app.inject({ method: "GET", url: "/v1/auth/state" })).body) as { providers: { id: string; name: string; startUrl: string }[] };
    expect(state.providers).toContainEqual({ id: "saml", name: "Acme SSO", startUrl: "/v1/auth/saml/start" });
  });

  it("signs in with a signed reply to our own request, linking the account by email", async () => {
    const id = await startRequest();
    const r = await post(response({ inResponseTo: id }));
    expect(r).toMatchObject({ status: 303, location: "/" });
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: r.cookie } });
    expect(JSON.parse(me.body).user).toMatchObject({ email: "ada@example.com" });
    const [identity] = await conclave.db.query<{ provider: string; subject: string }>(`select provider, subject from identities`);
    expect(identity).toEqual({ provider: `saml:${IDP}`, subject: "user-ada@example.com" });
  });

  it("refuses a replayed, tampered, wrongly signed, unsigned, mis-addressed or unsolicited reply", async () => {
    const refused = async (reply: string, why: RegExp) => {
      const r = await post(reply);
      expect(r.status).toBe(303);
      expect(r.location.startsWith("/sign-in?error=")).toBe(true);
      expect(r.cookie).toBe("");
      expect(r.error).toMatch(why);
    };

    const id = await startRequest();
    const good = response({ inResponseTo: id });
    expect((await post(good)).status).toBe(303);
    await refused(good, /InResponseTo/i);

    await refused(response({ inResponseTo: await startRequest(), tamper: (x) => x.replace(/ada@example\.com/g, "eve@example.com") }), /signature|digest|invalid/i);
    await refused(response({ inResponseTo: await startRequest(), signWith: other }), /signature|invalid/i);
    await refused(response({ inResponseTo: await startRequest(), signWith: null }), /signature|signed/i);
    await refused(response({ inResponseTo: await startRequest(), audience: "https://another.app/saml" }), /audience/i);
    await refused(response({ inResponseTo: null }), /InResponseTo/i);
    await refused(response({ inResponseTo: "_not-ours" }), /InResponseTo/i);
  });

  it("needs an invite or an allowed domain for someone new", async () => {
    const r = await post(response({ inResponseTo: await startRequest(), email: "newcomer@corp.test" }));
    expect(r.location.startsWith("/sign-in?error=")).toBe(true);
    expect(r.cookie).toBe("");
  });

  it("takes form bodies only on the ACS, so a cross-site form cannot sign anyone in elsewhere", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `email=ada%40example.com&password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(res.statusCode).toBe(415);
  });

  it("shows owners the setup and how long the IdP certificate has left", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/org/sso", headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { saml: { acsUrl: string; spEntityId: string; certificates: { daysLeft: number }[] } };
    expect(body.saml).toMatchObject({ acsUrl: ACS, spEntityId: SP });
    expect(body.saml.certificates[0]!.daysLeft).toBeGreaterThanOrEqual(18);
    expect(body.saml.certificates[0]!.daysLeft).toBeLessThanOrEqual(20);
  });
});

describe("SAML settings from the environment", () => {
  it("reads metadata XML, applies the switches, and refuses a setup with no certificate", async () => {
    const { samlFromEnv } = await import("./saml");
    const s = await samlFromEnv({ CONCLAVE_SAML_METADATA: metadataXml(), CONCLAVE_SAML_NAME: "Okta", CONCLAVE_SAML_IDP_INITIATED: "true" }, PUBLIC);
    expect(s).toMatchObject({ name: "Okta", idpEntityId: IDP, idpSsoUrl: SSO, acsUrl: ACS, allowIdpInitiated: true, trustEmail: true });
    expect(await samlFromEnv({}, PUBLIC)).toBeNull();
    await expect(samlFromEnv({ CONCLAVE_SAML_SSO_URL: SSO }, PUBLIC)).rejects.toThrow(/signing certificate/);
  });
});

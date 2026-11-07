import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import type { OutsideIdentity } from "@conclave/core";

/**
 * Sign-in with outside identity providers (ACC-001): any OpenID Connect
 * provider (Google, Microsoft, Keycloak, Okta, Authentik…) and GitHub (OAuth 2).
 * Authorization code flow with PKCE, state and nonce; ID tokens are verified
 * against the provider's published keys.
 */

export interface ProviderConfig {
  id: string;
  name: string;
  kind: "oidc" | "github";
  clientId: string;
  clientSecret: string;
  /** OIDC issuer URL; discovery reads `${issuer}/.well-known/openid-configuration`. */
  issuer?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Pending {
  provider: string;
  verifier: string;
  nonce: string;
  at: number;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** Read providers from the environment. */
export function providersFromEnv(env: NodeJS.ProcessEnv): ProviderConfig[] {
  const list: ProviderConfig[] = [];
  if (env.CONCLAVE_GOOGLE_CLIENT_ID && env.CONCLAVE_GOOGLE_CLIENT_SECRET) {
    list.push({ id: "google", name: "Google", kind: "oidc", issuer: "https://accounts.google.com", clientId: env.CONCLAVE_GOOGLE_CLIENT_ID, clientSecret: env.CONCLAVE_GOOGLE_CLIENT_SECRET });
  }
  if (env.CONCLAVE_GITHUB_CLIENT_ID && env.CONCLAVE_GITHUB_CLIENT_SECRET) {
    list.push({ id: "github", name: "GitHub", kind: "github", clientId: env.CONCLAVE_GITHUB_CLIENT_ID, clientSecret: env.CONCLAVE_GITHUB_CLIENT_SECRET });
  }
  // Any other OIDC provider: CONCLAVE_OIDC_ISSUER, _CLIENT_ID, _CLIENT_SECRET, optional _NAME.
  if (env.CONCLAVE_OIDC_ISSUER && env.CONCLAVE_OIDC_CLIENT_ID && env.CONCLAVE_OIDC_CLIENT_SECRET) {
    list.push({
      id: "oidc",
      name: env.CONCLAVE_OIDC_NAME ?? "Single sign-on",
      kind: "oidc",
      issuer: env.CONCLAVE_OIDC_ISSUER.replace(/\/+$/, ""),
      clientId: env.CONCLAVE_OIDC_CLIENT_ID,
      clientSecret: env.CONCLAVE_OIDC_CLIENT_SECRET,
    });
  }
  return list;
}

export class IdentityProviders {
  private readonly providers: Map<string, ProviderConfig>;
  private readonly publicUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pending = new Map<string, Pending>();
  private readonly discovery = new Map<string, Promise<Discovery>>();

  constructor(providers: ProviderConfig[], publicUrl: string, fetchImpl: typeof fetch = fetch) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
    this.publicUrl = publicUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  list(): { id: string; name: string }[] {
    return [...this.providers.values()].map((p) => ({ id: p.id, name: p.name }));
  }

  callbackUrl(id: string): string {
    return `${this.publicUrl}/v1/auth/oidc/${id}/callback`;
  }

  /** The URL to send the browser to. */
  async start(id: string): Promise<string> {
    const p = this.get(id);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(16));
    this.sweep();
    this.pending.set(state, { provider: id, verifier, nonce, at: Date.now() });
    if (p.kind === "github") {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({ client_id: p.clientId, redirect_uri: this.callbackUrl(id), state, scope: "read:user user:email" }).toString();
      return url.href;
    }
    const d = await this.discover(p);
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: p.clientId,
      redirect_uri: this.callbackUrl(id),
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  /** Exchange the code from the callback for a verified identity. */
  async finish(id: string, query: { code?: string; state?: string; error?: string }): Promise<OutsideIdentity> {
    if (query.error) throw new Error(`The provider said: ${query.error}`);
    const pending = query.state ? this.pending.get(query.state) : undefined;
    if (!pending || pending.provider !== id || Date.now() - pending.at > 10 * 60_000) throw new Error("This sign-in link expired. Try again.");
    this.pending.delete(query.state!);
    if (!query.code) throw new Error("The provider sent no code.");
    const p = this.get(id);
    return p.kind === "github" ? this.finishGithub(p, query.code) : this.finishOidc(p, query.code, pending);
  }

  private async finishOidc(p: ProviderConfig, code: string, pending: Pending): Promise<OutsideIdentity> {
    const d = await this.discover(p);
    const res = await this.fetchImpl(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.callbackUrl(p.id),
        client_id: p.clientId,
        client_secret: p.clientSecret,
        code_verifier: pending.verifier,
      }),
    });
    if (!res.ok) throw new Error(`The provider refused the code (${res.status}).`);
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new Error("The provider sent no ID token.");
    const claims = await this.verifyIdToken(p, d, body.id_token);
    if (claims.nonce !== pending.nonce) throw new Error("The ID token's nonce does not match.");
    return {
      provider: `oidc:${p.id}`,
      subject: String(claims.sub),
      email: typeof claims.email === "string" ? claims.email : null,
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      name: typeof claims.name === "string" ? claims.name : null,
    };
  }

  private async verifyIdToken(p: ProviderConfig, d: Discovery, token: string): Promise<Record<string, unknown>> {
    const [h, b, s] = token.split(".");
    if (!h || !b || !s) throw new Error("The ID token is malformed.");
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string; kid?: string };
    const claims = JSON.parse(Buffer.from(b, "base64url").toString()) as Record<string, unknown>;
    const algs: Record<string, { hash: string; ec?: boolean }> = { RS256: { hash: "sha256" }, ES256: { hash: "sha256", ec: true } };
    const alg = algs[header.alg];
    if (!alg) throw new Error(`Unsupported ID token algorithm ${header.alg}.`);

    const jwks = (await (await this.fetchImpl(d.jwks_uri)).json()) as { keys: (JsonWebKey & { kid?: string })[] };
    const jwk = jwks.keys.find((k) => !header.kid || k.kid === header.kid);
    if (!jwk) throw new Error("No published key matches the ID token.");
    const ok = verify(alg.hash, Buffer.from(`${h}.${b}`), { key: createPublicKey({ key: jwk, format: "jwk" }), ...(alg.ec ? { dsaEncoding: "ieee-p1363" as const } : {}) }, Buffer.from(s, "base64url"));
    if (!ok) throw new Error("The ID token signature is not valid.");

    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== d.issuer) throw new Error("The ID token comes from another issuer.");
    if (!aud.includes(p.clientId)) throw new Error("The ID token is for another app.");
    if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("The ID token expired.");
    return claims;
  }

  private async finishGithub(p: ProviderConfig, code: string): Promise<OutsideIdentity> {
    const res = await this.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: p.clientId, client_secret: p.clientSecret, code, redirect_uri: this.callbackUrl(p.id) }),
    });
    const { access_token } = (await res.json()) as { access_token?: string };
    if (!access_token) throw new Error("GitHub refused the code.");
    const headers = { authorization: `Bearer ${access_token}`, accept: "application/vnd.github+json", "user-agent": "conclave" };
    const user = (await (await this.fetchImpl("https://api.github.com/user", { headers })).json()) as { id: number; login: string; name: string | null };
    const emails = (await (await this.fetchImpl("https://api.github.com/user/emails", { headers })).json()) as { email: string; primary: boolean; verified: boolean }[];
    const primary = Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)) : undefined;
    return { provider: "github", subject: String(user.id), email: primary?.email ?? null, emailVerified: !!primary, name: user.name ?? user.login };
  }

  private discover(p: ProviderConfig): Promise<Discovery> {
    let d = this.discovery.get(p.id);
    if (!d) {
      d = this.fetchImpl(`${p.issuer}/.well-known/openid-configuration`).then(async (r) => {
        if (!r.ok) throw new Error(`Could not read ${p.name}'s configuration (${r.status}).`);
        return (await r.json()) as Discovery;
      });
      d.catch(() => this.discovery.delete(p.id));
      this.discovery.set(p.id, d);
    }
    return d;
  }

  private get(id: string): ProviderConfig {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Sign-in with "${id}" is not set up on this instance.`);
    return p;
  }

  private sweep() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.pending) if (v.at < cutoff) this.pending.delete(k);
  }
}

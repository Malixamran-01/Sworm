import { ConclaveError, isPermission, SESSION_DAYS, type Conclave, type Principal } from "@conclave/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { param, principal, RateLimiter, SESSION_COOKIE } from "../auth/guard";
import type { IdentityProviders } from "../auth/oidc";

export interface AuthRouteOptions {
  conclave: Conclave;
  providers: IdentityProviders;
  secureCookies: boolean;
  /** Required to set up an instance that listens beyond localhost. */
  setupCode: string | null;
}

const PUBLIC = { guard: { auth: "public" as const } };
const USER = { guard: { auth: "user" as const } };

export function authRoutes(app: FastifyInstance, opts: AuthRouteOptions) {
  const { conclave, providers } = opts;
  const limiter = new RateLimiter(10, 5 * 60_000);
  const meta = (req: FastifyRequest) => ({ userAgent: req.headers["user-agent"], ip: req.ip });

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: opts.secureCookies,
      maxAge: SESSION_DAYS * 86_400,
    });

  const signedIn = async (reply: FastifyReply, session: { token: string; principal: Principal }) => {
    setCookie(reply, session.token);
    return conclave.accounts.me(session.principal);
  };

  app.get("/v1/auth/state", { config: PUBLIC }, async (req) => ({
    setupRequired: await conclave.accounts.setupRequired(),
    setupCodeRequired: !!opts.setupCode,
    providers: providers.list(),
    me: req.principal ? await conclave.accounts.me(req.principal) : null,
  }));

  app.post("/v1/auth/setup", { config: PUBLIC }, async (req, reply) => {
    limiter.check(`setup:${req.ip}`);
    const body = z
      .object({ name: z.string(), email: z.string(), password: z.string(), orgName: z.string().optional(), setupCode: z.string().optional() })
      .parse(req.body);
    if (opts.setupCode && body.setupCode?.trim() !== opts.setupCode) {
      throw new ConclaveError(403, "Setup code needed", "Enter the setup code printed in the server log.");
    }
    return signedIn(reply, await conclave.accounts.setup(body, meta(req)));
  });

  app.post("/v1/auth/sign-in", { config: PUBLIC }, async (req, reply) => {
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    limiter.check(`sign-in:${req.ip}:${body.email.toLowerCase()}`);
    const result = await conclave.accounts.signIn(body, meta(req));
    // With a second factor on, no cookie yet: the client finishes with /v1/auth/mfa (ACC-002).
    if ("mfaRequired" in result) return result;
    return signedIn(reply, result);
  });

  app.post("/v1/auth/mfa", { config: PUBLIC }, async (req, reply) => {
    const body = z
      .object({ ticket: z.string().max(200), code: z.string().max(20).optional(), recoveryCode: z.string().max(40).optional(), passkey: z.unknown().optional() })
      .parse(req.body);
    limiter.check(`mfa:${req.ip}`);
    return signedIn(reply, await conclave.accounts.completeSignIn(body, meta(req)));
  });

  // Passwordless sign-in with a passkey (ACC-002).
  app.post("/v1/auth/passkey/options", { config: PUBLIC }, async (req) => {
    limiter.check(`passkey:${req.ip}`);
    return conclave.mfa.passkeySignInOptions();
  });
  app.post("/v1/auth/passkey", { config: PUBLIC }, async (req, reply) => {
    const body = z.object({ challengeId: z.string().uuid(), response: z.record(z.string(), z.unknown()) }).parse(req.body);
    return signedIn(reply, await conclave.accounts.signInWithPasskey(body, meta(req)));
  });

  app.post("/v1/auth/sign-out", { config: PUBLIC }, async (req, reply) => {
    if (req.sessionToken) await conclave.accounts.signOut(req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/v1/auth/invites/:token", { config: PUBLIC }, async (req) => conclave.accounts.inviteInfo(param("token")(req)!));

  app.post("/v1/auth/invites/:token/accept", { config: PUBLIC }, async (req, reply) => {
    limiter.check(`invite:${req.ip}`);
    const body = z.object({ name: z.string().optional(), email: z.string().optional(), password: z.string().optional() }).parse(req.body ?? {});
    return signedIn(reply, await conclave.accounts.acceptInvite(param("token")(req)!, body, req.principal?.via === "session" ? req.principal : null, meta(req)));
  });

  // Outside identity providers. Errors come back to the sign-in page as a message.
  app.get("/v1/auth/oidc/:provider/start", { config: PUBLIC }, async (req, reply) => {
    try {
      return reply.redirect(await providers.start(param("provider")(req)!));
    } catch (err) {
      return reply.redirect(`/sign-in?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
    }
  });

  app.get("/v1/auth/oidc/:provider/callback", { config: PUBLIC }, async (req, reply) => {
    try {
      const identity = await providers.finish(param("provider")(req)!, req.query as Record<string, string>);
      setCookie(reply, (await conclave.accounts.signInWithIdentity(identity, meta(req))).token);
      return reply.redirect("/");
    } catch (err) {
      const message = err instanceof ConclaveError ? (err.detail ?? err.title) : err instanceof Error ? err.message : String(err);
      return reply.redirect(`/sign-in?error=${encodeURIComponent(message)}`);
    }
  });

  // ------------------------------------------------------- the caller's account
  app.get("/v1/me", { config: USER }, async (req) => conclave.accounts.me(principal(req)));

  app.patch("/v1/me", { config: USER }, async (req) => {
    await conclave.accounts.updateProfile(principal(req), z.object({ name: z.string().optional() }).parse(req.body));
    return conclave.accounts.me(principal(req));
  });

  app.post("/v1/me/password", { config: USER }, async (req, reply) => {
    limiter.check(`password:${principal(req).userId}`);
    await conclave.accounts.changePassword(principal(req), z.object({ current: z.string().optional(), next: z.string() }).parse(req.body));
    return reply.code(204).send();
  });

  // Second factors (ACC-002). Only a browser session may change them, never an access token.
  const self = (req: FastifyRequest) => {
    const p = principal(req);
    if (p.via !== "session") throw new ConclaveError(403, "Not allowed", "Sign-in methods can only be changed from a signed-in browser.");
    return p;
  };
  const mfa = conclave.mfa;
  app.get("/v1/me/security", { config: USER }, async (req) => mfa.security(self(req).userId));
  app.post("/v1/me/totp/setup", { config: USER }, async (req) => {
    const me = await conclave.accounts.me(self(req));
    return mfa.totpSetup(me.user.id, me.user.email);
  });
  app.post("/v1/me/totp/enable", { config: USER }, async (req) => {
    limiter.check(`totp:${principal(req).userId}`);
    return mfa.totpEnable(self(req).userId, z.object({ code: z.string().max(20) }).parse(req.body).code);
  });
  app.post("/v1/me/totp/disable", { config: USER }, async (req, reply) => {
    limiter.check(`totp:${principal(req).userId}`);
    const body = z.object({ code: z.string().max(20).optional(), recoveryCode: z.string().max(40).optional() }).parse(req.body);
    await mfa.totpDisable(self(req).userId, { ...(body.code ? { code: body.code } : {}), ...(body.recoveryCode ? { recoveryCode: body.recoveryCode } : {}) });
    return reply.code(204).send();
  });
  app.post("/v1/me/recovery-codes", { config: USER }, async (req) => {
    limiter.check(`totp:${principal(req).userId}`);
    return mfa.regenerateRecoveryCodes(self(req).userId, z.object({ code: z.string().max(20) }).parse(req.body));
  });
  app.post("/v1/me/passkeys/options", { config: USER }, async (req) => {
    const me = await conclave.accounts.me(self(req));
    return mfa.passkeyRegistrationOptions(me.user);
  });
  app.post("/v1/me/passkeys", { config: USER }, async (req, reply) => {
    const body = z.object({ challengeId: z.string().uuid(), response: z.record(z.string(), z.unknown()), name: z.string().max(80).optional() }).parse(req.body);
    return reply.code(201).send(await mfa.passkeyRegister(self(req).userId, body as unknown as Parameters<typeof mfa.passkeyRegister>[1]));
  });
  app.patch("/v1/me/passkeys/:id", { config: USER }, async (req) => mfa.renamePasskey(self(req).userId, param("id")(req)!, z.object({ name: z.string().max(80) }).parse(req.body).name));
  app.delete("/v1/me/passkeys/:id", { config: USER }, async (req, reply) => {
    await mfa.removePasskey(self(req).userId, param("id")(req)!);
    return reply.code(204).send();
  });

  app.post("/v1/orgs", { config: USER }, async (req, reply) => {
    const org = await conclave.accounts.createOrg(principal(req), z.object({ name: z.string() }).parse(req.body).name);
    return reply.code(201).send(org);
  });

  app.post("/v1/auth/switch-org", { config: USER }, async (req) => {
    if (!req.sessionToken) throw new ConclaveError(400, "Only browser sessions can switch organisation");
    const next = await conclave.accounts.switchOrg(req.sessionToken, principal(req), z.object({ orgId: z.string().uuid() }).parse(req.body).orgId);
    return conclave.accounts.me(next);
  });

  // -------------------------------------------------------- access tokens
  app.get("/v1/tokens", { config: USER }, async (req) => conclave.accounts.tokens(principal(req)));

  app.post("/v1/tokens", { config: USER }, async (req, reply) => {
    const body = z
      .object({ name: z.string(), scopes: z.array(z.string()).refine((s) => s.every(isPermission), "Unknown scope."), expiresInDays: z.number().int().nullable().optional() })
      .parse(req.body);
    return reply.code(201).send(await conclave.accounts.createToken(principal(req), body));
  });

  app.delete("/v1/tokens/:id", { config: USER }, async (req, reply) => {
    await conclave.accounts.revokeToken(principal(req), z.string().uuid().parse(param("id")(req)));
    return reply.code(204).send();
  });
}

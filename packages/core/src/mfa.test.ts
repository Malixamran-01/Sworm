import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { Session } from "./accounts";
import { base32Decode, base32Encode, hotp, totp } from "./mfa";
import { harness, type Harness } from "./test-helpers";

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const ORIGIN = "http://localhost:8787";
const PASSWORD = "correct horse battery";
const b64u = (b: Uint8Array | Buffer) => isoBase64URL.fromBuffer(new Uint8Array(b));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/**
 * A software passkey: a P-256 key, "none" attestation, and real ES256
 * signatures, so the server's WebAuthn checks run for real.
 */
class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  private counter = 0;
  userHandle = "";

  constructor(private readonly opts: { uv?: boolean; origin?: string; synced?: boolean } = {}) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = pair.privateKey;
    this.publicJwk = pair.publicKey.export({ format: "jwk" }) as { x: string; y: string };
  }

  private authData(withCredential: boolean): Buffer {
    const flags = 0x01 | (this.opts.uv === false ? 0 : 0x04) | (this.opts.synced ? 0x18 : 0) | (withCredential ? 0x40 : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.opts.synced ? 0 : ++this.counter);
    const parts = [sha("localhost"), Buffer.from([flags]), count];
    if (withCredential) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      const cose = new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(this.publicJwk.x)],
        [-3, isoBase64URL.toBuffer(this.publicJwk.y)],
      ]);
      parts.push(Buffer.alloc(16), len, this.credentialId, Buffer.from(isoCBOR.encode(cose)));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.opts.origin ?? ORIGIN, crossOrigin: false }));
  }

  create(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id;
    const attestation = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(this.authData(true))]]) as never);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge)), attestationObject: b64u(attestation), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  get(options: { challenge: string }) {
    const authData = this.authData(false);
    const clientData = this.clientData("webauthn.get", options.challenge);
    const signature = sign("sha256", Buffer.concat([authData, sha(clientData)]), this.key);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.userHandle },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

async function owner(h: Harness): Promise<Session> {
  return h.conclave.accounts.setup({ name: "Ada", email: "ada@example.com", password: PASSWORD });
}

async function addPasskey(h: Harness, userId: string, auth = new SoftAuthenticator()) {
  const me = await h.conclave.accounts.me((await h.conclave.accounts.fromSession((await h.conclave.accounts.sessionFor(userId, {}, "test")).token))!);
  const { challengeId, options } = await h.conclave.mfa.passkeyRegistrationOptions(me.user);
  const passkey = await h.conclave.mfa.passkeyRegister(userId, { challengeId, response: auth.create(options as never) as never, name: "Laptop" });
  return { auth, passkey };
}

const secretOf = async (h: Harness, userId: string) => {
  const [row] = await h.conclave.db.query<{ secret_sealed: string }>(`select secret_sealed from user_totp where user_id = $1`, [userId]);
  return base32Decode((h.conclave as unknown as { mfa: { vault: { openPersonal(s: string): string } } }).mfa.vault.openPersonal(row!.secret_sealed));
};

describe("TOTP (ACC-002)", () => {
  it("matches the RFC 6238 test vector and round-trips base32", () => {
    const seed = Buffer.from("12345678901234567890");
    // RFC 6238 appendix B, SHA-1, T = 59 s → 94287082 (8 digits); the low 6 digits are 287082.
    expect(totp(seed, new Date(59_000))).toBe("287082");
    expect(hotp(seed, 1)).toBe("287082");
    expect(base32Decode(base32Encode(seed)).equals(seed)).toBe(true);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  it("enrols with a code, then asks for one after the password, and refuses a replayed code", async () => {
    h = await harness();
    const s = await owner(h);
    const userId = s.principal.userId;
    const setup = await h.conclave.mfa.totpSetup(userId, "ada@example.com");
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/Conclave%3Aada%40example\.com\?secret=[A-Z2-7]+&issuer=Conclave/);
    expect(setup.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    // The seed is sealed, not stored in plain text.
    expect(JSON.stringify(await h.conclave.db.query(`select * from user_totp`))).not.toContain(setup.secret);

    await expect(h.conclave.mfa.totpEnable(userId, "000000")).rejects.toThrow(/not right/);
    const seed = base32Decode(setup.secret);
    const { recoveryCodes } = await h.conclave.mfa.totpEnable(userId, totp(seed, new Date()));
    expect(recoveryCodes).toHaveLength(10);
    expect((await h.conclave.mfa.security(userId)).totp).toEqual({ enabled: true, recoveryCodesLeft: 10 });

    const first = await h.conclave.accounts.signIn({ email: "ada@example.com", password: PASSWORD });
    expect("mfaRequired" in first && first.mfaRequired.methods).toEqual(["totp", "recovery"]);
    const ticket = "mfaRequired" in first ? first.mfaRequired.ticket : "";

    // The code used to enable is spent; the same step cannot be used again.
    await expect(h.conclave.accounts.completeSignIn({ ticket, code: totp(seed, new Date()) })).rejects.toThrow(/not right/);
    const next = totp(seed, new Date(Date.now() + 30_000));
    const session = await h.conclave.accounts.completeSignIn({ ticket, code: next });
    expect(session.principal.userId).toBe(userId);
    // The ticket is single-use.
    await expect(h.conclave.accounts.completeSignIn({ ticket, code: next })).rejects.toThrow(/expired/);
    expect(await secretOf(h, userId)).toEqual(seed);
  });

  it("accepts each recovery code once, and drops the ticket after five wrong tries", async () => {
    h = await harness();
    const s = await owner(h);
    const userId = s.principal.userId;
    const setup = await h.conclave.mfa.totpSetup(userId, "ada");
    const { recoveryCodes } = await h.conclave.mfa.totpEnable(userId, totp(base32Decode(setup.secret), new Date()));

    const ticketOf = async () => {
      const r = await h.conclave.accounts.signIn({ email: "ada@example.com", password: PASSWORD });
      return "mfaRequired" in r ? r.mfaRequired.ticket : "";
    };
    const t1 = await ticketOf();
    await h.conclave.accounts.completeSignIn({ ticket: t1, recoveryCode: recoveryCodes[0]!.toUpperCase() });
    const t2 = await ticketOf();
    await expect(h.conclave.accounts.completeSignIn({ ticket: t2, recoveryCode: recoveryCodes[0]! })).rejects.toThrow(/not right/);
    expect((await h.conclave.mfa.security(userId)).totp.recoveryCodesLeft).toBe(9);

    for (let i = 0; i < 3; i++) await expect(h.conclave.accounts.completeSignIn({ ticket: t2, code: "123456" })).rejects.toThrow(/not right/);
    await expect(h.conclave.accounts.completeSignIn({ ticket: t2, code: "123456" })).rejects.toThrow(/Too many/);
    await expect(h.conclave.accounts.completeSignIn({ ticket: t2, recoveryCode: recoveryCodes[1]! })).rejects.toThrow(/expired/);

    // Turning it off needs a code too.
    await expect(h.conclave.mfa.totpDisable(userId, { code: "000000" })).rejects.toThrow(/not right/);
    await h.conclave.mfa.totpDisable(userId, { recoveryCode: recoveryCodes[2]! });
    expect("token" in (await h.conclave.accounts.signIn({ email: "ada@example.com", password: PASSWORD }))).toBe(true);
  });
});

describe("Passkeys (ACC-002)", () => {
  it("registers a passkey and signs in with it, without a password", async () => {
    h = await harness();
    const s = await owner(h);
    const { auth, passkey } = await addPasskey(h, s.principal.userId);
    expect(passkey).toMatchObject({ name: "Laptop", synced: false, lastUsedAt: null });

    const { challengeId, options } = await h.conclave.mfa.passkeySignInOptions();
    const session = await h.conclave.accounts.signInWithPasskey({ challengeId, response: auth.get(options as never) });
    expect(session.principal.userId).toBe(s.principal.userId);
    expect((await h.conclave.mfa.security(s.principal.userId)).passkeys[0]!.lastUsedAt).not.toBeNull();

    // Challenges are single-use.
    await expect(h.conclave.accounts.signInWithPasskey({ challengeId, response: auth.get(options as never) })).rejects.toThrow(/expired/);
  });

  it("refuses a passkey from another origin, without user verification, or with a counter that went back", async () => {
    h = await harness();
    const s = await owner(h);
    const { auth } = await addPasskey(h, s.principal.userId);

    const elsewhere = Object.assign(Object.create(Object.getPrototypeOf(auth)), auth, { opts: { origin: "https://evil.example" } }) as SoftAuthenticator;
    let o = await h.conclave.mfa.passkeySignInOptions();
    await expect(h.conclave.accounts.signInWithPasskey({ challengeId: o.challengeId, response: elsewhere.get(o.options as never) })).rejects.toThrow(/did not check out/);

    const noUv = Object.assign(Object.create(Object.getPrototypeOf(auth)), auth, { opts: { uv: false } }) as SoftAuthenticator;
    o = await h.conclave.mfa.passkeySignInOptions();
    await expect(h.conclave.accounts.signInWithPasskey({ challengeId: o.challengeId, response: noUv.get(o.options as never) })).rejects.toThrow(/did not check out/);

    // A good sign-in moves the stored counter forward; replaying an older counter is refused.
    o = await h.conclave.mfa.passkeySignInOptions();
    await h.conclave.accounts.signInWithPasskey({ challengeId: o.challengeId, response: auth.get(o.options as never) });
    await h.conclave.db.query(`update passkeys set counter = 1000`);
    o = await h.conclave.mfa.passkeySignInOptions();
    await expect(h.conclave.accounts.signInWithPasskey({ challengeId: o.challengeId, response: auth.get(o.options as never) })).rejects.toThrow(/cloned/);
  });

  it("works as the second factor after a password", async () => {
    h = await harness();
    const s = await owner(h);
    const { auth } = await addPasskey(h, s.principal.userId);
    const r = await h.conclave.accounts.signIn({ email: "ada@example.com", password: PASSWORD });
    if (!("mfaRequired" in r)) throw new Error("expected a second step");
    expect(r.mfaRequired.methods).toEqual(["passkey"]);
    const session = await h.conclave.accounts.completeSignIn({ ticket: r.mfaRequired.ticket, passkey: auth.get(r.mfaRequired.passkeyOptions as never) });
    expect(session.principal.userId).toBe(s.principal.userId);
  });

  it("will not remove someone's only way in", async () => {
    h = await harness();
    const s = await owner(h);
    const { passkey } = await addPasskey(h, s.principal.userId);
    await h.conclave.db.query(`update users set password_hash = null where id = $1`, [s.principal.userId]);
    await expect(h.conclave.mfa.removePasskey(s.principal.userId, passkey.id)).rejects.toThrow(/only way/);
    await h.conclave.db.query(`update users set password_hash = 'x' where id = $1`, [s.principal.userId]);
    await h.conclave.mfa.removePasskey(s.principal.userId, passkey.id);
    expect((await h.conclave.mfa.security(s.principal.userId)).passkeys).toEqual([]);
  });
});

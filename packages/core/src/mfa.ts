import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newId, type MfaChallengeDto, type MfaMethod, type PasskeyDto, type SecurityDto, type TotpSetupDto } from "@conclave/contract";
import { iso, json, num, type Db, type Queryable } from "@conclave/db";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import QRCode from "qrcode";
import { sha256 } from "./accounts";
import { ConclaveError, conflict, invalid, notFound } from "./errors";
import type { SecretVault } from "./secrets";

/**
 * Second factors (ACC-002): TOTP (RFC 6238) with single-use recovery codes,
 * and passkeys (WebAuthn) for passwordless sign-in or as a second factor.
 * TOTP seeds are sealed by the vault; recovery codes and tickets are hashed.
 */

export interface WebAuthnConfig {
  /** Usually the hostname people reach the app at. */
  rpId: string;
  rpName: string;
  /** Origins a browser may sign from, e.g. https://conclave.example.com */
  origins: string[];
}

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TICKET_MINUTES = 10;
const CHALLENGE_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const RECOVERY_CODES = 10;

// ------------------------------------------------------------------ TOTP

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("Not base32.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) at one counter value. */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = (((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 10 ** TOTP_DIGITS;
  return String(code).padStart(TOTP_DIGITS, "0");
}

export const totpStep = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_PERIOD);
export const totp = (secret: Buffer, at: Date) => hotp(secret, totpStep(at));

const sameCode = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: string | number;
  transports: AuthenticatorTransportFuture[];
  device_type: string;
  backed_up: boolean;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

interface ChallengeRow {
  id: string;
  purpose: string;
  challenge: string;
  user_id: string | null;
  attempts: number;
}

const wrong = (detail: string) => new ConclaveError(401, "Sign-in failed", detail);

export class SecondFactors {
  private readonly db: Db;
  private readonly vault: SecretVault;
  private readonly webauthn: WebAuthnConfig;
  private readonly now: () => Date;

  constructor(db: Db, vault: SecretVault, webauthn: WebAuthnConfig, now: () => Date = () => new Date()) {
    this.db = db;
    this.vault = vault;
    this.webauthn = webauthn;
    this.now = now;
  }

  // ------------------------------------------------------------ status

  async security(userId: string): Promise<SecurityDto> {
    const [t] = await this.db.query<{ enabled_at: Date | null }>(`select enabled_at from user_totp where user_id = $1`, [userId]);
    const [codes] = await this.db.query<{ n: string | number }>(`select count(*) as n from recovery_codes where user_id = $1 and used_at is null`, [userId]);
    const passkeys = await this.db.query<PasskeyRow>(`select * from passkeys where user_id = $1 order by created_at`, [userId]);
    return {
      totp: { enabled: !!t?.enabled_at, recoveryCodesLeft: t?.enabled_at ? num(codes?.n) : 0 },
      passkeys: passkeys.map(toPasskeyDto),
    };
  }

  /** Second factors this person must use after a password, if any. */
  async methodsFor(userId: string): Promise<MfaMethod[]> {
    const s = await this.security(userId);
    return [...(s.totp.enabled ? (["totp", "recovery"] as const) : []), ...(s.passkeys.length ? (["passkey"] as const) : [])];
  }

  // ------------------------------------------------------------ TOTP

  /** Start (or restart) TOTP enrolment. Nothing changes for sign-in until it is confirmed with a code. */
  async totpSetup(userId: string, label: string): Promise<TotpSetupDto> {
    const [existing] = await this.db.query<{ enabled_at: Date | null }>(`select enabled_at from user_totp where user_id = $1`, [userId]);
    if (existing?.enabled_at) throw conflict("Two-factor codes are already on. Turn them off first to use a new app.");
    const secret = base32Encode(randomBytes(20));
    await this.db.query(
      `insert into user_totp (user_id, secret_sealed) values ($1, $2)
       on conflict (user_id) do update set secret_sealed = excluded.secret_sealed, last_step = 0, created_at = now()`,
      [userId, this.vault.sealPersonal(secret)],
    );
    const uri = `otpauth://totp/${encodeURIComponent(`Conclave:${label}`)}?secret=${secret}&issuer=Conclave&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
    const svg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { secret, uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
  }

  /** Confirm enrolment with a first code; returns recovery codes, shown once. */
  async totpEnable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    return this.db.tx(async (q) => {
      const [row] = await q.query<{ enabled_at: Date | null }>(`select enabled_at from user_totp where user_id = $1 for update`, [userId]);
      if (!row) throw invalid(["Start two-factor setup first."]);
      if (row.enabled_at) throw conflict("Two-factor codes are already on.");
      if (!(await this.checkTotp(q, userId, code))) throw invalid(["That code is not right. Check the time on your phone and try the newest code."]);
      await q.query(`update user_totp set enabled_at = now() where user_id = $1`, [userId]);
      return { recoveryCodes: await this.replaceRecoveryCodes(q, userId) };
    });
  }

  async totpDisable(userId: string, proof: { code?: string; recoveryCode?: string }): Promise<void> {
    await this.db.tx(async (q) => {
      if (!(await this.checkSecond(q, userId, proof))) throw invalid(["That code is not right."]);
      await q.query(`delete from user_totp where user_id = $1`, [userId]);
      await q.query(`delete from recovery_codes where user_id = $1`, [userId]);
    });
  }

  async regenerateRecoveryCodes(userId: string, proof: { code?: string }): Promise<{ recoveryCodes: string[] }> {
    return this.db.tx(async (q) => {
      if (!(await this.checkSecond(q, userId, { ...(proof.code ? { code: proof.code } : {}) }))) throw invalid(["That code is not right."]);
      return { recoveryCodes: await this.replaceRecoveryCodes(q, userId) };
    });
  }

  private async replaceRecoveryCodes(q: Queryable, userId: string): Promise<string[]> {
    await q.query(`delete from recovery_codes where user_id = $1`, [userId]);
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    for (const c of codes) await q.query(`insert into recovery_codes (id, user_id, code_hash) values ($1, $2, $3)`, [newId(), userId, sha256(normRecovery(c))]);
    return codes;
  }

  /** A TOTP code, accepted once: the step it matched is remembered so it cannot be replayed. */
  private async checkTotp(q: Queryable, userId: string, code: string | undefined): Promise<boolean> {
    const clean = String(code ?? "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(clean)) return false;
    const [row] = await q.query<{ secret_sealed: string; last_step: string | number }>(`select secret_sealed, last_step from user_totp where user_id = $1`, [userId]);
    if (!row) return false;
    const secret = base32Decode(this.vault.openPersonal(row.secret_sealed));
    const now = totpStep(this.now());
    // One step either side allows for clock drift.
    for (const step of [now - 1, now, now + 1]) {
      if (step <= num(row.last_step)) continue;
      if (sameCode(hotp(secret, step), clean)) {
        const updated = await q.query(`update user_totp set last_step = $2 where user_id = $1 and last_step < $2 returning user_id`, [userId, step]);
        return updated.length === 1;
      }
    }
    return false;
  }

  private async checkRecovery(q: Queryable, userId: string, code: string | undefined): Promise<boolean> {
    const clean = normRecovery(String(code ?? ""));
    if (clean.length < 8) return false;
    const used = await q.query(`update recovery_codes set used_at = now() where user_id = $1 and code_hash = $2 and used_at is null returning id`, [userId, sha256(clean)]);
    return used.length === 1;
  }

  private async checkSecond(q: Queryable, userId: string, proof: { code?: string; recoveryCode?: string }): Promise<boolean> {
    if (proof.code) return this.checkTotp(q, userId, proof.code);
    if (proof.recoveryCode) return this.checkRecovery(q, userId, proof.recoveryCode);
    return false;
  }

  // ------------------------------------------------------------ passkeys

  private async storeChallenge(q: Queryable, input: { purpose: string; challenge: string; userId?: string; ticketHash?: string; minutes: number }): Promise<string> {
    await q.query(`delete from auth_challenges where expires_at < $1`, [this.now()]);
    const id = newId();
    await q.query(`insert into auth_challenges (id, purpose, challenge, user_id, ticket_hash, expires_at) values ($1, $2, $3, $4, $5, $6)`, [
      id,
      input.purpose,
      input.challenge,
      input.userId ?? null,
      input.ticketHash ?? null,
      new Date(this.now().getTime() + input.minutes * 60_000),
    ]);
    return id;
  }

  /** One-time: the challenge is deleted as it is read. */
  private async takeChallenge(id: string, purpose: string): Promise<ChallengeRow> {
    const [row] = await this.db.query<ChallengeRow>(`delete from auth_challenges where id = $1 and purpose = $2 and expires_at > $3 returning *`, [id, purpose, this.now()]);
    if (!row) throw wrong("That sign-in request expired. Try again.");
    return row;
  }

  async passkeyRegistrationOptions(user: { id: string; email: string; name: string }): Promise<{ challengeId: string; options: unknown }> {
    const existing = await this.db.query<PasskeyRow>(`select * from passkeys where user_id = $1`, [user.id]);
    const options = await generateRegistrationOptions({
      rpName: this.webauthn.rpName,
      rpID: this.webauthn.rpId,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = await this.storeChallenge(this.db, { purpose: "passkey-register", challenge: options.challenge, userId: user.id, minutes: CHALLENGE_MINUTES });
    return { challengeId, options };
  }

  async passkeyRegister(userId: string, input: { challengeId: string; response: RegistrationResponseJSON; name?: string }): Promise<PasskeyDto> {
    const ch = await this.takeChallenge(input.challengeId, "passkey-register");
    if (ch.user_id !== userId) throw wrong("That passkey request was for someone else.");
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.webauthn.origins,
        expectedRPID: this.webauthn.rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      throw invalid([`The passkey could not be checked: ${(err as Error).message}`]);
    }
    if (!verified.verified || !verified.registrationInfo) throw invalid(["The passkey could not be checked."]);
    const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;
    const name = input.name?.trim().slice(0, 80) || (credentialBackedUp ? "Synced passkey" : "Passkey");
    const [taken] = await this.db.query(`select 1 from passkeys where id = $1`, [credential.id]);
    if (taken) throw conflict("This passkey is already registered.");
    await this.db.query(
      `insert into passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [credential.id, userId, isoBase64URL.fromBuffer(credential.publicKey), credential.counter, json(input.response.response.transports ?? credential.transports ?? []), credentialDeviceType, credentialBackedUp, name],
    );
    const [row] = await this.db.query<PasskeyRow>(`select * from passkeys where id = $1`, [credential.id]);
    return toPasskeyDto(row!);
  }

  async renamePasskey(userId: string, id: string, name: string): Promise<PasskeyDto> {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw invalid(["Give the passkey a name."]);
    const [row] = await this.db.query<PasskeyRow>(`update passkeys set name = $3 where id = $1 and user_id = $2 returning *`, [id, userId, clean]);
    if (!row) throw notFound("Passkey");
    return toPasskeyDto(row);
  }

  async removePasskey(userId: string, id: string): Promise<void> {
    await this.db.tx(async (q) => {
      const [u] = await q.query<{ password_hash: string | null; identities: string | number; passkeys: string | number }>(
        `select password_hash, (select count(*) from identities where user_id = $1) as identities,
                (select count(*) from passkeys where user_id = $1) as passkeys from users where id = $1`,
        [userId],
      );
      // Never remove someone's only way in.
      if (u && !u.password_hash && num(u.identities) === 0 && num(u.passkeys) <= 1) {
        throw conflict("This is your only way to sign in. Set a password or add another passkey first.");
      }
      const gone = await q.query(`delete from passkeys where id = $1 and user_id = $2 returning id`, [id, userId]);
      if (gone.length === 0) throw notFound("Passkey");
    });
  }

  /** Passwordless sign-in: any passkey on this site, chosen in the browser. */
  async passkeySignInOptions(): Promise<{ challengeId: string; options: unknown }> {
    const options = await generateAuthenticationOptions({ rpID: this.webauthn.rpId, userVerification: "required" });
    const challengeId = await this.storeChallenge(this.db, { purpose: "passkey-signin", challenge: options.challenge, minutes: CHALLENGE_MINUTES });
    return { challengeId, options };
  }

  /** Check a passwordless passkey sign-in; returns who it is. The passkey must verify the person (PIN or biometrics). */
  async passkeySignIn(input: { challengeId: string; response: AuthenticationResponseJSON }): Promise<string> {
    const ch = await this.takeChallenge(input.challengeId, "passkey-signin");
    const passkey = await this.verifyAssertion(input.response, ch.challenge, true);
    return passkey.user_id;
  }

  private async verifyAssertion(response: AuthenticationResponseJSON, challenge: string, requireUserVerification: boolean, userId?: string): Promise<PasskeyRow> {
    const [pk] = await this.db.query<PasskeyRow>(`select * from passkeys where id = $1`, [String(response?.id ?? "")]);
    if (!pk || (userId && pk.user_id !== userId)) throw wrong("That passkey is not registered here.");
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.webauthn.origins,
        expectedRPID: this.webauthn.rpId,
        requireUserVerification,
        credential: { id: pk.id, publicKey: isoBase64URL.toBuffer(pk.public_key), counter: num(pk.counter), transports: pk.transports },
      });
    } catch (err) {
      if (/counter/i.test((err as Error).message)) throw wrong("This passkey looks cloned. Remove it and add it again.");
      throw wrong("The passkey did not check out.");
    }
    if (!result.verified) throw wrong("The passkey did not check out.");
    // A counter that goes backwards means a cloned authenticator; synced passkeys report 0.
    const next = result.authenticationInfo.newCounter;
    if (next > 0 && next <= num(pk.counter)) throw wrong("This passkey looks cloned. Remove it and add it again.");
    await this.db.query(`update passkeys set counter = $2, last_used_at = now() where id = $1`, [pk.id, next]);
    return pk;
  }

  // ------------------------------------------------------------ tickets

  /** After a correct password: a short-lived ticket to finish sign-in with a second factor. */
  async issueTicket(userId: string): Promise<MfaChallengeDto> {
    const methods = await this.methodsFor(userId);
    const ticket = `mfa_${randomBytes(32).toString("base64url")}`;
    let passkeyOptions: unknown = null;
    let challenge = "";
    if (methods.includes("passkey")) {
      const keys = await this.db.query<PasskeyRow>(`select * from passkeys where user_id = $1`, [userId]);
      const options = await generateAuthenticationOptions({
        rpID: this.webauthn.rpId,
        userVerification: "preferred",
        allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports })),
      });
      passkeyOptions = options;
      challenge = options.challenge;
    }
    await this.storeChallenge(this.db, { purpose: "mfa", challenge, userId, ticketHash: sha256(ticket), minutes: TICKET_MINUTES });
    return { ticket, methods, passkeyOptions };
  }

  /** Finish sign-in with a second factor. A ticket allows a few tries, then it is gone. */
  async redeemTicket(ticket: string, proof: { code?: string; recoveryCode?: string; passkey?: AuthenticationResponseJSON }): Promise<{ userId: string; method: MfaMethod }> {
    const [row] = await this.db.query<ChallengeRow>(`select * from auth_challenges where ticket_hash = $1 and purpose = 'mfa' and expires_at > $2`, [sha256(String(ticket ?? "")), this.now()]);
    if (!row?.user_id) throw wrong("The sign-in expired. Enter your password again.");
    const userId = row.user_id;
    let method: MfaMethod | null = null;
    try {
      if (proof.passkey) {
        if (!row.challenge) throw wrong("No passkey is registered for this account.");
        await this.verifyAssertion(proof.passkey, row.challenge, false, userId);
        method = "passkey";
      } else if (proof.code && (await this.db.tx((q) => this.checkTotp(q, userId, proof.code)))) {
        method = "totp";
      } else if (proof.recoveryCode && (await this.db.tx((q) => this.checkRecovery(q, userId, proof.recoveryCode)))) {
        method = "recovery";
      }
    } catch (err) {
      if (!(err instanceof ConclaveError)) throw err;
    }
    if (!method) {
      const [left] = await this.db.query<{ attempts: number }>(`update auth_challenges set attempts = attempts + 1 where id = $1 returning attempts`, [row.id]);
      if ((left?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS) {
        await this.db.query(`delete from auth_challenges where id = $1`, [row.id]);
        throw wrong("Too many wrong codes. Enter your password again.");
      }
      throw wrong("That code is not right.");
    }
    await this.db.query(`delete from auth_challenges where id = $1`, [row.id]);
    return { userId, method };
  }
}

function toPasskeyDto(row: PasskeyRow): PasskeyDto {
  return { id: row.id, name: row.name, createdAt: iso(row.created_at)!, lastUsedAt: iso(row.last_used_at), synced: row.backed_up };
}

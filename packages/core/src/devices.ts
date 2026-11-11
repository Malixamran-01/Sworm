import { createHash, createPrivateKey, createPublicKey, hkdfSync, randomInt, sign, verify, type KeyObject } from "node:crypto";
import { newId } from "@conclave/contract";
import { iso, type Db } from "@conclave/db";
import { audit } from "./connections";
import { invalid, notFound, type Actor } from "./errors";

/**
 * Local Bridge devices (SRS 8.8). A device proves itself with an Ed25519 key
 * it made on the machine; the server signs every call it sends with its own
 * key, which the device pinned when it paired. Pairing takes a one-time code
 * entered here by a signed-in person, then a confirmation on the device.
 */

export interface DeviceDto {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
}

interface DeviceRow {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  public_key: string;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

interface PairingRow {
  id: string;
  name: string;
  public_key: string;
  org_id: string | null;
  user_id: string | null;
  device_id: string | null;
  expires_at: Date;
  claimed_at: Date | null;
  confirmed_at: Date | null;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIRING_MS = 10 * 60_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const normaliseCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The server's signing key, derived from the master key so it survives restarts and needs no extra file. */
export function bridgeSigningKey(masterKey: Buffer): KeyObject {
  const seed = Buffer.from(hkdfSync("sha256", masterKey, "conclave", "local-bridge-signing-key", 32));
  // PKCS#8 wrapper for a raw Ed25519 seed.
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/**
 * The server's key for signing requests to remote modules. A separate key from
 * the bridge's, so a signature made for one can never be used for the other.
 */
export function remoteSigningKey(masterKey: Buffer): KeyObject {
  const seed = Buffer.from(hkdfSync("sha256", masterKey, "conclave", "remote-module-signing-key", 32));
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** A device's public key, as sent at pairing: base64 SPKI DER, Ed25519 only. */
function parseDeviceKey(publicKey: string): KeyObject {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType === "ed25519") return key;
  } catch {
    /* fall through */
  }
  throw invalid(["The device key must be an Ed25519 public key (base64 SPKI)."]);
}

function verifyDevice(publicKey: string, message: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(message), parseDeviceKey(publicKey), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** A signed request from a device must be fresh: within 5 minutes. */
const fresh = (ts: string) => /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) < 300;

export class Devices {
  private readonly db: Db;
  private readonly key: KeyObject;
  readonly serverKey: string;

  constructor(db: Db, signingKey: KeyObject) {
    this.db = db;
    this.key = signingKey;
    this.serverKey = createPublicKey(signingKey).export({ format: "der", type: "spki" }).toString("base64");
  }

  /** Sign a message for a device to check against the key it pinned. */
  sign(message: string): string {
    return sign(null, Buffer.from(message), this.key).toString("base64");
  }

  /** Step 1, on the device: it sends its name and key and gets a code to show its person. */
  async startPairing(input: { name: string; publicKey: string }): Promise<{ pairingId: string; code: string; expiresAt: string; serverKey: string }> {
    const name = String(input.name ?? "").trim().slice(0, 80);
    if (!name) throw invalid(["Give the device a name."]);
    parseDeviceKey(String(input.publicKey ?? ""));
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const id = newId();
    const expiresAt = new Date(Date.now() + PAIRING_MS);
    await this.db.query(`insert into bridge_pairings (id, code_hash, name, public_key, expires_at) values ($1, $2, $3, $4, $5)`, [
      id,
      hash(raw),
      name,
      input.publicKey,
      expiresAt.toISOString(),
    ]);
    return { pairingId: id, code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: expiresAt.toISOString(), serverKey: this.serverKey };
  }

  /** Step 2, here: a signed-in person enters the code. The device still has to confirm. */
  async claim(actor: Actor, code: string): Promise<{ pairingId: string; name: string }> {
    const [row] = await this.db.query<PairingRow>(
      `update bridge_pairings set org_id = $2, user_id = $3, claimed_at = now()
        where code_hash = $1 and claimed_at is null and expires_at > now() returning *`,
      [hash(normaliseCode(code)), actor.orgId, actor.userId],
    );
    if (!row) throw invalid(["That code is not valid, or it has expired. Start pairing again on the device."]);
    await audit(this.db, actor, "device.pairing_claimed", row.id, { name: row.name });
    return { pairingId: row.id, name: row.name };
  }

  /** The device asks how pairing stands, signing with its key. */
  async pairingStatus(pairingId: string, ts: string, signature: string): Promise<{ state: "waiting" | "claimed" | "confirmed" | "expired"; claimedBy?: { name: string; email: string; org: string } }> {
    const row = await this.pairing(pairingId);
    if (!fresh(ts) || !verifyDevice(row.public_key, `status:${pairingId}:${ts}`, signature)) throw invalid(["The request is not signed by the pairing device."]);
    if (row.confirmed_at) return { state: "confirmed" };
    if (row.expires_at.getTime() < Date.now()) return { state: "expired" };
    if (!row.claimed_at) return { state: "waiting" };
    const [who] = await this.db.query<{ name: string; email: string; org: string }>(
      `select u.name, u.email, o.name as org from users u, orgs o where u.id = $1 and o.id = $2`,
      [row.user_id, row.org_id],
    );
    return { state: "claimed", ...(who ? { claimedBy: who } : {}) };
  }

  /** Step 3, on the device: its person confirms who claimed it, and the device is paired. */
  async confirm(pairingId: string, ts: string, signature: string): Promise<{ deviceId: string }> {
    const row = await this.pairing(pairingId);
    if (!fresh(ts) || !verifyDevice(row.public_key, `confirm:${pairingId}:${ts}`, signature)) throw invalid(["The request is not signed by the pairing device."]);
    if (row.confirmed_at && row.device_id) return { deviceId: row.device_id };
    if (!row.claimed_at || !row.org_id || !row.user_id) throw invalid(["Nobody has entered this device's code yet."]);
    if (row.expires_at.getTime() < Date.now()) throw invalid(["The pairing expired. Start again on the device."]);
    const deviceId = newId();
    await this.db.tx(async (q) => {
      await q.query(`insert into bridge_devices (id, org_id, user_id, name, public_key) values ($1, $2, $3, $4, $5)`, [
        deviceId,
        row.org_id,
        row.user_id,
        row.name,
        row.public_key,
      ]);
      await q.query(`update bridge_pairings set confirmed_at = now(), device_id = $2 where id = $1`, [pairingId, deviceId]);
      await audit(q, { orgId: row.org_id!, userId: row.user_id! }, "device.paired", deviceId, { name: row.name });
      // Every new pairing is told to its person (SRS 8.8, stolen credentials).
      await q.query(
        `insert into inbox_items (id, org_id, user_id, kind, title, body, path, action, urgent) values ($1, $2, $3, 'problem', $4, $5, 'Settings > Devices', 'open', true)`,
        [newId(), row.org_id, row.user_id, `New device paired: ${row.name}`, "A Local Bridge device was paired to your account. If this was not you, remove it in Settings > Devices."],
      );
    });
    return { deviceId };
  }

  private async pairing(id: string): Promise<PairingRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Pairing");
    const [row] = await this.db.query<PairingRow>(`select * from bridge_pairings where id = $1`, [id]);
    if (!row) throw notFound("Pairing");
    return row;
  }

  /** A connecting device signs the server's challenge with its key. */
  async authenticate(deviceId: string, nonce: string, signature: string): Promise<{ id: string; orgId: string; userId: string; name: string } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(deviceId)) return null;
    const [row] = await this.db.query<DeviceRow>(`select * from bridge_devices where id = $1 and revoked_at is null`, [deviceId]);
    if (!row || !verifyDevice(row.public_key, `hello:${deviceId}:${nonce}`, signature)) return null;
    await this.db.query(`update bridge_devices set last_seen_at = now() where id = $1`, [deviceId]);
    return { id: row.id, orgId: row.org_id, userId: row.user_id, name: row.name };
  }

  /** A device of this organisation, by id or name. */
  async resolve(orgId: string, ref: string): Promise<{ id: string; name: string } | null> {
    const value = ref.trim();
    const byId = /^[0-9a-f-]{36}$/i.test(value);
    const [row] = await this.db.query<DeviceRow>(
      `select * from bridge_devices where org_id = $1 and revoked_at is null and ${byId ? "id = $2" : "lower(name) = lower($2)"} order by created_at desc limit 1`,
      [orgId, value],
    );
    return row ? { id: row.id, name: row.name } : null;
  }

  /** Devices of an organisation; everyone's for org admins, otherwise one's own. */
  async list(actor: Actor, all: boolean): Promise<DeviceDto[]> {
    const rows = await this.db.query<DeviceRow>(
      `select * from bridge_devices where org_id = $1 ${all ? "" : "and user_id = $2"} and revoked_at is null order by created_at`,
      all ? [actor.orgId] : [actor.orgId, actor.userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, userId: r.user_id, createdAt: iso(r.created_at)!, lastSeenAt: iso(r.last_seen_at), revoked: !!r.revoked_at }));
  }

  async revoke(actor: Actor, id: string, all: boolean): Promise<void> {
    const rows = await this.db.query(
      `update bridge_devices set revoked_at = now() where id = $1 and org_id = $2 ${all ? "" : "and user_id = $3"} and revoked_at is null returning id`,
      all ? [id, actor.orgId] : [id, actor.orgId, actor.userId],
    );
    if (!rows.length) throw notFound("Device");
    await audit(this.db, actor, "device.removed", id, {});
  }
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { newId } from "@conclave/contract";
import type { Queryable } from "@conclave/db";

/**
 * Envelope encryption (CON-002, SEC-002). Each org has a data key wrapped by
 * the master key; each secret is encrypted with its org's data key using
 * AES-256-GCM. Destroying a data key makes everything it encrypted
 * unreadable, including copies in backups (crypto-shredding, PRIV-004).
 */

const VERSION = "v1";

function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

function open(key: Buffer, sealed: string): Buffer {
  const [version, iv, tag, ct] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || !ct) throw new Error("Unrecognised ciphertext format.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]);
}

export class SecretVault {
  private readonly masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error("The master key must be 32 bytes.");
    this.masterKey = masterKey;
  }

  static generateMasterKey(): Buffer {
    return randomBytes(32);
  }

  /** Seal a secret that belongs to a person, not an org (a TOTP seed): wrapped by the master key itself. */
  sealPersonal(plaintext: string): string {
    return seal(this.masterKey, Buffer.from(plaintext, "utf8"));
  }

  openPersonal(sealed: string): string {
    return open(this.masterKey, sealed).toString("utf8");
  }

  private async dataKey(q: Queryable, orgId: string): Promise<{ id: string; key: Buffer }> {
    const rows = await q.query<{ id: string; wrapped_key: string }>(
      `select id, wrapped_key from data_keys where org_id = $1 and scope = 'org' and destroyed_at is null order by created_at limit 1`,
      [orgId],
    );
    const existing = rows[0];
    if (existing) return { id: existing.id, key: open(this.masterKey, existing.wrapped_key) };
    const key = randomBytes(32);
    const id = newId();
    await q.query(`insert into data_keys (id, org_id, scope, wrapped_key) values ($1, $2, 'org', $3)`, [id, orgId, seal(this.masterKey, key)]);
    return { id, key };
  }

  /** Store a set of secret values; returns the secret row id. */
  async store(q: Queryable, orgId: string, values: Record<string, string>): Promise<string> {
    const { id: dataKeyId, key } = await this.dataKey(q, orgId);
    const id = newId();
    await q.query(`insert into secrets (id, org_id, data_key_id, ciphertext) values ($1, $2, $3, $4)`, [
      id,
      orgId,
      dataKeyId,
      seal(key, Buffer.from(JSON.stringify(values), "utf8")),
    ]);
    return id;
  }

  async replace(q: Queryable, secretId: string, values: Record<string, string>): Promise<void> {
    const rows = await q.query<{ wrapped_key: string }>(
      `select k.wrapped_key from secrets s join data_keys k on k.id = s.data_key_id where s.id = $1 and k.destroyed_at is null`,
      [secretId],
    );
    const row = rows[0];
    if (!row) throw new Error("Secret not found.");
    const key = open(this.masterKey, row.wrapped_key);
    await q.query(`update secrets set ciphertext = $2, rotated_at = now() where id = $1`, [
      secretId,
      seal(key, Buffer.from(JSON.stringify(values), "utf8")),
    ]);
  }

  /** Decrypt a secret. Callers use the values for one call and keep them out of logs and responses. */
  async reveal(q: Queryable, secretId: string): Promise<Record<string, string>> {
    const rows = await q.query<{ ciphertext: string; wrapped_key: string; destroyed_at: Date | null }>(
      `select s.ciphertext, k.wrapped_key, k.destroyed_at from secrets s join data_keys k on k.id = s.data_key_id where s.id = $1`,
      [secretId],
    );
    const row = rows[0];
    if (!row) throw new Error("Secret not found.");
    if (row.destroyed_at) throw new Error("This secret's key was destroyed.");
    const key = open(this.masterKey, row.wrapped_key);
    return JSON.parse(open(key, row.ciphertext).toString("utf8")) as Record<string, string>;
  }

  /** Crypto-shred every secret of an org. */
  async destroyOrgKeys(q: Queryable, orgId: string): Promise<void> {
    await q.query(`update data_keys set destroyed_at = now(), wrapped_key = '' where org_id = $1`, [orgId]);
  }
}

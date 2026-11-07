import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { migrations } from "./migrations";

/**
 * One small interface over node-postgres (Standard, Scale) and PGlite
 * (Lite and tests). Core code writes plain SQL against it, so both
 * backends run exactly the same statements.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly kind: "pglite" | "postgres";
  /** Run `fn` in one transaction; it commits when `fn` resolves and rolls back when it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * - `pglite:memory` — in-memory, for tests
 * - `pglite:<dir>` — PGlite persisted to a folder (Lite profile without a Postgres server)
 * - `postgres://…` — a real Postgres server
 */
export async function createDb(url: string, opts: { schema?: string; dropSchemaOnClose?: boolean } = {}): Promise<Db> {
  if (url.startsWith("pglite:")) {
    const target = url.slice("pglite:".length);
    const lite = target === "memory" || target === "" ? new PGlite() : new PGlite(target);
    await lite.waitReady;
    return new PgliteDb(lite);
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const schema = opts.schema;
    if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Invalid schema name "${schema}".`);
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    if (schema) {
      // Every pooled connection works inside the schema, so migrations and queries need no prefixes.
      // Registered before the first query, so no connection ever starts outside it.
      pool.on("connect", (client) => void client.query(`set search_path to "${schema}", public`));
      await pool.query(`create schema if not exists "${schema}"`);
    }
    await pool.query("select 1");
    return new PostgresDb(pool, schema && opts.dropSchemaOnClose ? schema : undefined);
  }
  throw new Error(`Unsupported database URL "${url}". Use pglite:memory, pglite:<dir> or postgres://…`);
}

/**
 * A fresh database for one test: in-memory PGlite by default, or its own
 * schema on a real Postgres when CONCLAVE_TEST_DATABASE_URL is set (dropped on close).
 */
export async function createTestDb(): Promise<Db> {
  const url = process.env.CONCLAVE_TEST_DATABASE_URL;
  if (!url) return createDb("pglite:memory");
  const schema = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return createDb(url, { schema, dropSchemaOnClose: true });
}

class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  private readonly lite: PGlite;

  constructor(lite: PGlite) {
    this.lite = lite;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.lite.query<T>(sql, params);
    return result.rows;
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.lite.transaction(async (tx) =>
      fn({
        query: async <R>(sql: string, params: unknown[] = []) => (await tx.query<R>(sql, params)).rows,
      }),
    );
  }

  async close(): Promise<void> {
    await this.lite.close();
  }
}

class PostgresDb implements Db {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;
  private readonly dropSchema: string | undefined;

  constructor(pool: pg.Pool, dropSchema?: string) {
    this.pool = pool;
    this.dropSchema = dropSchema;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const value = await fn({
        query: async <R>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as R[],
      });
      await client.query("commit");
      return value;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.dropSchema) await this.pool.query(`drop schema if exists "${this.dropSchema}" cascade`).catch(() => {});
    await this.pool.end();
  }
}

/** Apply pending migrations in order. Migrations are forward-only (SRS 9.6). */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ id: string }>(`select id from schema_migrations`)).map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.tx(async (q) => {
      for (const statement of splitStatements(m.sql)) await q.query(statement);
      await q.query(`insert into schema_migrations (id) values ($1)`, [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Numeric and bigint columns come back as strings from Postgres; read them as numbers. */
export const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
export const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
/** JSON parameters are always sent as text and cast to jsonb in SQL. */
export const json = (value: unknown): string => JSON.stringify(value ?? null);

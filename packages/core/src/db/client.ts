import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { schema } from "./schema";

type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Anything that can run queries: a root connection or an open transaction. */
export type DbLike = Db | Tx;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
  /** Which driver backs this handle; tests use it to describe their run. */
  driver: "postgres" | "pglite";
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Row-level security only bites for roles that are neither superuser nor BYPASSRLS. Docker's
 * `postgres` image makes POSTGRES_USER a superuser, and PGlite always connects as one, so both
 * would silently bypass every policy. In that case the app runs as a plain role instead. A
 * hosted database user that is already a plain role (Neon, RDS, Supabase) is used as is: FORCE
 * ROW LEVEL SECURITY applies the policies to table owners too.
 */
export const APP_ROLE = "referly_app";

const APP_ROLE_SETUP = [
  sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'referly_app') then create role referly_app nosuperuser nocreatedb nocreaterole nobypassrls; end if; end $$`,
  sql`grant usage on schema public to referly_app`,
  sql`grant all on all tables in schema public to referly_app`,
  sql`grant usage, select, update on all sequences in schema public to referly_app`,
];

async function connectionBypassesRls(db: Db): Promise<{ superuser: boolean; bypassrls: boolean; user: string }> {
  const result = (await db.execute(sql`select current_user as "user", rolsuper as superuser, rolbypassrls as bypassrls from pg_roles where rolname = current_user`)) as unknown as { rows: { user: string; superuser: boolean; bypassrls: boolean }[] };
  const rows = result.rows;
  const r = rows[0]!;
  return { user: r.user, superuser: r.superuser, bypassrls: r.bypassrls };
}

/** Fails closed: refuse to hand out a connection whose role would ignore the tenant policies. */
async function assertRlsEffective(db: Db): Promise<void> {
  const who = await connectionBypassesRls(db);
  if (who.superuser || who.bypassrls) throw new Error(`refusing to run as database role "${who.user}": it ${who.superuser ? "is a superuser" : "has BYPASSRLS"}, so row-level security would be ignored`);
}

/**
 * Create a database connection.
 * - `DATABASE_URL` set (or `url` passed) → node-postgres against a real Postgres.
 * - otherwise → embedded PGlite. `dataDir` persists data; omit for in-memory (tests).
 *
 * `fresh: true` (tests) creates a throwaway database on the Postgres server for this handle
 * and drops it on close, so migrations run from zero every time and test files stay isolated.
 */
export async function createDb(opts: { url?: string; dataDir?: string; migrate?: boolean; fresh?: boolean; driver?: "postgres" | "pglite" } = {}): Promise<DbHandle> {
  const url = opts.driver === "pglite" ? undefined : (opts.url ?? process.env.DATABASE_URL);
  const shouldMigrate = opts.migrate ?? true;

  if (url) return createPostgres(url, shouldMigrate, opts.fresh ?? false);

  const client = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  const db = drizzlePglite(client, { schema });
  if (shouldMigrate) await migratePglite(db, { migrationsFolder });
  // PGlite connects as a superuser, and superusers ignore row-level security. Run the app as a
  // plain role so dev and tests are subject to the same policies as production.
  for (const stmt of APP_ROLE_SETUP) await db.execute(stmt);
  await db.execute(sql`set role referly_app`);
  await assertRlsEffective(db as unknown as Db);
  return { db: db as unknown as Db, close: () => client.close(), driver: "pglite" };
}

async function createPostgres(url: string, shouldMigrate: boolean, fresh: boolean): Promise<DbHandle> {
  let effectiveUrl = url;
  let dropDatabase: (() => Promise<void>) | null = null;
  if (fresh) {
    const name = `referly_test_${randomBytes(6).toString("hex")}`;
    await withClient(url, (c) => c.query(`create database "${name}"`));
    const u = new URL(url);
    u.pathname = `/${name}`;
    effectiveUrl = u.toString();
    dropDatabase = async () => {
      await withClient(url, (c) => c.query(`drop database "${name}" with (force)`));
    };
  }

  // Migrations and role setup run as the connecting user (the owner); the app pool runs as the
  // plain role when the owner would bypass RLS.
  const adminPool = new pg.Pool({ connectionString: effectiveUrl, max: 1 });
  const adminDb = drizzlePg(adminPool, { schema }) as unknown as Db;
  let appRole: string | null = null;
  try {
    if (shouldMigrate) await migratePg(adminDb as never, { migrationsFolder });
    const who = await connectionBypassesRls(adminDb);
    if (who.superuser || who.bypassrls) {
      for (const stmt of APP_ROLE_SETUP) await adminDb.execute(stmt);
      appRole = APP_ROLE;
    }
  } finally {
    await adminPool.end();
  }

  const pool = new pg.Pool({ connectionString: effectiveUrl });
  if (appRole) {
    // Every pooled connection switches role before its first query; pg runs queries per
    // connection in order, so nothing can slip in ahead of the SET ROLE.
    pool.on("connect", (client) => {
      client.query(`set role ${appRole}`).catch((err: unknown) => console.error("set role failed", err));
    });
  }
  const db = drizzlePg(pool, { schema }) as unknown as Db;
  try {
    await assertRlsEffective(db);
  } catch (err) {
    await pool.end();
    if (dropDatabase) await dropDatabase();
    throw err;
  }
  return {
    db,
    driver: "postgres",
    close: async () => {
      await pool.end();
      if (dropDatabase) await dropDatabase();
    },
  };
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Database for a test file: a throwaway database on `TEST_DATABASE_URL` when set (real Postgres,
 * migrations from zero, dropped on close), otherwise in-memory PGlite.
 */
export function createTestDb(): Promise<DbHandle> {
  const url = process.env.TEST_DATABASE_URL;
  return url ? createDb({ url, fresh: true }) : createDb({ driver: "pglite" });
}

/**
 * Run `fn` inside a transaction. When `db` is already a transaction this opens a savepoint,
 * so an expected failure inside (for example a unique-violation race) does not poison the
 * enclosing request transaction.
 */
export async function withTx<T>(db: DbLike, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as Tx));
}

function isTx(db: DbLike): db is Tx {
  return typeof (db as { rollback?: unknown }).rollback === "function";
}

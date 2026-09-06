import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import path from "node:path";
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
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Create a database connection.
 * - `DATABASE_URL` set (or `url` passed) → node-postgres against a real Postgres.
 * - otherwise → embedded PGlite. `dataDir` persists data; omit for in-memory (tests).
 */
export async function createDb(opts: { url?: string; dataDir?: string; migrate?: boolean } = {}): Promise<DbHandle> {
  const url = opts.url ?? process.env.DATABASE_URL;
  const shouldMigrate = opts.migrate ?? true;

  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    const db = drizzlePg(pool, { schema });
    if (shouldMigrate) await migratePg(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => pool.end() };
  }

  const client = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  const db = drizzlePglite(client, { schema });
  if (shouldMigrate) await migratePglite(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}

/** Run `fn` inside a transaction unless `db` already is one. */
export async function withTx<T>(db: DbLike, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (isTx(db)) return fn(db);
  return db.transaction(async (tx) => fn(tx as unknown as Tx));
}

function isTx(db: DbLike): db is Tx {
  return typeof (db as { rollback?: unknown }).rollback === "function";
}

import { sql } from "drizzle-orm";
import type { Db, DbLike, Tx } from "../db/client";
import { setRlsBypass } from "../db/rls";

/**
 * Logical backup and restore without pg_dump. The dump is a stream of JSON lines that any
 * Postgres (real or embedded) can produce and consume through the app's own connection:
 *
 *   {"t":"header","format":1,"at":...,"migrations":[...],"tables":[...]}
 *   {"t":"table","name":"tenants","columns":[...],"pk":["id"]}
 *   {"t":"row","table":"tenants","r":[...values in column order...]}
 *   {"t":"end","table":"tenants","count":12}
 *   ...
 *   {"t":"footer","tables":42,"rows":1234}
 *
 * Tables are written in foreign-key order (parents first) so a restore can insert in the same
 * order; self-referencing columns are written back in a second pass. Rows go back through
 * json_populate_recordset, so Postgres does the type conversion for every column, and only the
 * columns the current schema still has are inserted (defaults fill the rest), which lets a
 * backup from an older release restore into a newer one after its migrations have run.
 *
 * The API layer wraps this in gzip and AES-256-GCM and stores the result; see apps/api/src/backup.ts.
 */
export const BACKUP_FORMAT = 1;

export interface TableInfo {
  name: string;
  columns: string[];
  pk: string[];
  /** Columns of this table that reference this same table. */
  selfRefs: string[];
  /** Serial columns whose sequence must be reset after a restore. */
  serials: string[];
  hasTenantId: boolean;
}

export type BackupLine =
  | { t: "header"; format: number; at: string; migrations: { hash: string; createdAt: number }[]; tables: string[] }
  | { t: "table"; name: string; columns: string[]; pk: string[] }
  | { t: "row"; table: string; r: unknown[] }
  | { t: "end"; table: string; count: number }
  | { t: "footer"; tables: number; rows: number }
  | { t: "file"; key: string; contentType: string; size: number }
  | { t: "blob"; data: string }
  | { t: "fileend"; key: string };

type Rows<T> = { rows: T[] };
async function rowsOf<T = Record<string, unknown>>(db: DbLike, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as Rows<T> | T[];
  return Array.isArray(res) ? res : res.rows;
}

/** Every base table in `public`, in foreign-key order (parents before children). */
export async function describeTables(db: DbLike): Promise<TableInfo[]> {
  const tables = await rowsOf<{ name: string }>(db, sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`);
  const columns = await rowsOf<{ table: string; column: string; serial: boolean }>(
    db,
    sql`select table_name as "table", column_name as "column", coalesce(column_default like 'nextval(%', false) as serial from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`,
  );
  const pks = await rowsOf<{ table: string; column: string }>(
    db,
    sql`select tc.table_name as "table", kcu.column_name as "column" from information_schema.table_constraints tc join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public' order by kcu.ordinal_position`,
  );
  const fks = await rowsOf<{ child: string; parent: string; cols: string }>(
    db,
    sql`select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
          (select string_agg(a.attname, ',' order by k.ord) from unnest(c.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
        from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
  );
  const unquote = (s: string) => s.replace(/^"|"$/g, "").replace(/^public\./, "");

  const byName = new Map<string, TableInfo>();
  for (const t of tables) byName.set(t.name, { name: t.name, columns: [], pk: [], selfRefs: [], serials: [], hasTenantId: false });
  for (const c of columns) {
    const t = byName.get(c.table);
    if (!t) continue;
    t.columns.push(c.column);
    if (c.serial) t.serials.push(c.column);
    if (c.column === "tenant_id") t.hasTenantId = true;
  }
  for (const p of pks) byName.get(p.table)?.pk.push(p.column);

  // Kahn's algorithm over parent → child edges; self-references are handled per table.
  const parents = new Map<string, Set<string>>();
  for (const name of byName.keys()) parents.set(name, new Set());
  for (const fk of fks) {
    const child = unquote(fk.child);
    const parent = unquote(fk.parent);
    if (!byName.has(child) || !byName.has(parent)) continue;
    if (child === parent) {
      byName.get(child)!.selfRefs.push(...fk.cols.split(","));
      continue;
    }
    parents.get(child)!.add(parent);
  }
  const ordered: TableInfo[] = [];
  const done = new Set<string>();
  while (done.size < byName.size) {
    const ready = [...byName.keys()].filter((n) => !done.has(n) && [...parents.get(n)!].every((p) => done.has(p))).sort();
    if (ready.length === 0) throw new Error(`foreign-key cycle among tables: ${[...byName.keys()].filter((n) => !done.has(n)).join(", ")}`);
    for (const n of ready) {
      done.add(n);
      ordered.push(byName.get(n)!);
    }
  }
  return ordered;
}

function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (v === undefined) return null;
  return v;
}

const ident = (name: string) => sql.identifier(name);
const identList = (names: string[]) => sql.join(names.map(ident), sql`, `);

/**
 * Stream the whole database as backup lines. Runs in one REPEATABLE READ transaction with RLS
 * bypassed, so the dump is a consistent snapshot across tables. Only for trusted callers (the
 * worker, the CLI); never reachable from a tenant request.
 */
export async function* dumpDatabase(db: Db, opts: { batchSize?: number; now?: () => Date } = {}): AsyncGenerator<BackupLine> {
  const batchSize = opts.batchSize ?? 1000;
  // Collect inside the transaction, hand out from the generator: drizzle transactions cannot
  // yield, so each table is fetched page by page through a queue of promises.
  const queue: BackupLine[] = [];
  let finished = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const push = (line: BackupLine) => {
    queue.push(line);
    notify();
  };
  const work = db
    .transaction(
      async (tx) => {
        await setRlsBypass(tx as unknown as Tx);
        const tables = await describeTables(tx);
        const migrations = await rowsOf<{ hash: string; created_at: string | number }>(tx, sql`select hash, created_at from drizzle.__drizzle_migrations order by id`).catch(() => []);
        push({ t: "header", format: BACKUP_FORMAT, at: (opts.now ?? (() => new Date()))().toISOString(), migrations: migrations.map((m) => ({ hash: m.hash, createdAt: Number(m.created_at) })), tables: tables.map((t) => t.name) });
        let total = 0;
        for (const table of tables) {
          push({ t: "table", name: table.name, columns: table.columns, pk: table.pk });
          const order = table.pk.length ? identList(table.pk) : identList(table.columns);
          let offset = 0;
          let count = 0;
          for (;;) {
            const rows = await rowsOf(tx, sql`select ${identList(table.columns)} from ${ident(table.name)} order by ${order} limit ${batchSize} offset ${offset}`);
            for (const row of rows) push({ t: "row", table: table.name, r: table.columns.map((c) => plain(row[c])) });
            count += rows.length;
            offset += rows.length;
            if (rows.length < batchSize) break;
            // let the consumer drain before the next page
            await new Promise<void>((r) => setImmediate(r));
          }
          push({ t: "end", table: table.name, count });
          total += count;
        }
        push({ t: "footer", tables: tables.length, rows: total });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    )
    .then(
      () => {
        finished = true;
        notify();
      },
      (err) => {
        failure = err;
        finished = true;
        notify();
      },
    );
  for (;;) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) break;
    await new Promise<void>((r) => (wake = r));
  }
  await work;
  if (failure) throw failure;
}

export interface RestoreResult {
  tables: number;
  rows: number;
  /** Columns present in the backup but not in the current schema; their values were dropped. */
  droppedColumns: string[];
  /** Tables in the backup that no longer exist. */
  droppedTables: string[];
  migrations: { hash: string; createdAt: number }[];
}

/**
 * Load a backup into `db`, replacing everything: every table in the current schema is truncated
 * first (the target must be migrated; run it through the normal boot path). Files are not
 * handled here; the caller restores them from the archive's file entries.
 */
export async function restoreDatabase(db: Db, lines: AsyncIterable<BackupLine>, opts: { batchSize?: number; onTable?: (name: string, count: number) => void } = {}): Promise<RestoreResult> {
  const batchSize = opts.batchSize ?? 500;
  return db.transaction(async (tx) => {
    await setRlsBypass(tx as unknown as Tx);
    const tables = await describeTables(tx);
    const byName = new Map(tables.map((t) => [t.name, t]));
    let truncated = false;
    let sawHeader = false;
    // Sequences are reset per table with setval (the app role may update but not own them).
    const truncateAll = async () => {
      if (truncated) return;
      if (!sawHeader) throw new Error("backup has no header line");
      await tx.execute(sql`truncate table ${identList(tables.map((t) => t.name))} cascade`);
      truncated = true;
    };

    const result: RestoreResult = { tables: 0, rows: 0, droppedColumns: [], droppedTables: [], migrations: [] };
    let current: { info: TableInfo; columns: string[]; insertCols: string[]; batch: Record<string, unknown>[]; deferred: { key: Record<string, unknown>; set: Record<string, unknown> }[] } | null = null;

    const flush = async () => {
      if (!current || current.batch.length === 0) return;
      const { info, insertCols, batch } = current;
      await tx.execute(sql`insert into ${ident(info.name)} (${identList(insertCols)}) select ${identList(insertCols)} from json_populate_recordset(null::${ident(info.name)}, ${JSON.stringify(batch)}::json)`);
      result.rows += batch.length;
      current.batch = [];
    };
    const finishTable = async () => {
      if (!current) return;
      await flush();
      const { info, deferred } = current;
      for (const d of deferred) {
        const sets = sql.join(
          Object.entries(d.set).map(([c, v]) => sql`${ident(c)} = (select ${ident(c)} from json_populate_record(null::${ident(info.name)}, ${JSON.stringify({ [c]: v })}::json))`),
          sql`, `,
        );
        const where = sql.join(
          Object.entries(d.key).map(([c, v]) => sql`${ident(c)} = ${v as string}`),
          sql` and `,
        );
        await tx.execute(sql`update ${ident(info.name)} set ${sets} where ${where}`);
      }
      for (const s of info.serials) {
        await tx.execute(sql`select setval(pg_get_serial_sequence(${info.name}, ${s}), coalesce((select max(${ident(s)}) from ${ident(info.name)}), 0) + 1, false)`);
      }
      result.tables++;
      current = null;
    };

    for await (const line of lines) {
      switch (line.t) {
        case "header":
          if (line.format !== BACKUP_FORMAT) throw new Error(`unsupported backup format ${line.format}`);
          result.migrations = line.migrations;
          sawHeader = true;
          break;
        case "table": {
          await finishTable();
          await truncateAll();
          const info = byName.get(line.name);
          if (!info) {
            result.droppedTables.push(line.name);
            current = null;
            break;
          }
          const have = new Set(info.columns);
          for (const c of line.columns) if (!have.has(c)) result.droppedColumns.push(`${line.name}.${c}`);
          const usable = line.columns.filter((c) => have.has(c));
          const selfRefs = new Set(info.selfRefs);
          current = { info, columns: line.columns, insertCols: usable.filter((c) => !selfRefs.has(c)), batch: [], deferred: [] };
          break;
        }
        case "row": {
          if (!current || current.info.name !== line.table) break;
          const obj: Record<string, unknown> = {};
          const set: Record<string, unknown> = {};
          current.columns.forEach((c, i) => {
            const v = line.r[i];
            if (current!.info.selfRefs.includes(c)) {
              if (v !== null && v !== undefined) set[c] = v;
            } else if (current!.insertCols.includes(c)) obj[c] = v;
          });
          current.batch.push(obj);
          if (Object.keys(set).length) {
            const key: Record<string, unknown> = {};
            for (const c of current.info.pk) key[c] = obj[c];
            current.deferred.push({ key, set });
          }
          if (current.batch.length >= batchSize) await flush();
          break;
        }
        case "end": {
          if (current && current.info.name === line.table) {
            await finishTable();
            opts.onTable?.(line.table, line.count);
          }
          break;
        }
        default:
          break;
      }
    }
    await finishTable();
    await truncateAll();
    return result;
  });
}

/** Row counts per table; the restore drill compares source and target. */
export async function tableCounts(db: DbLike): Promise<Record<string, number>> {
  const tables = await describeTables(db);
  const out: Record<string, number> = {};
  for (const t of tables) {
    const [row] = await rowsOf<{ n: string | number }>(db, sql`select count(*) as n from ${ident(t.name)}`);
    out[t.name] = Number(row?.n ?? 0);
  }
  return out;
}

/**
 * Delete every row that belongs to a tenant, children first, then the tenant itself. Used when
 * a closed workspace passes its grace period. Runs with RLS bypassed inside one transaction.
 */
export async function purgeTenantRows(db: Db, tenantId: string): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    await setRlsBypass(tx as unknown as Tx);
    const tables = await describeTables(tx);
    const deleted: Record<string, number> = {};
    for (const t of [...tables].reverse()) {
      if (t.name === "tenants") continue;
      if (!t.hasTenantId) continue;
      const res = (await tx.execute(sql`delete from ${ident(t.name)} where ${ident("tenant_id")} = ${tenantId}`)) as unknown as { rowCount?: number; affectedRows?: number };
      const n = res.rowCount ?? res.affectedRows ?? 0;
      if (n) deleted[t.name] = n;
    }
    const res = (await tx.execute(sql`delete from ${ident("tenants")} where ${ident("id")} = ${tenantId}`)) as unknown as { rowCount?: number; affectedRows?: number };
    deleted.tenants = res.rowCount ?? res.affectedRows ?? 0;
    return deleted;
  });
}

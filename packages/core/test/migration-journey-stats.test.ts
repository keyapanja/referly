import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migrations 0018 and 0019 run against databases that already hold per-visitor journey rows.
 * Every other test migrates an empty database, which proves the SQL parses but not what it does
 * to data, so this one stops at 0017, writes the kind of rows a live workspace has, and then lets
 * the rest run: the click must learn its visitor, the daily visitor totals must carry over, the
 * tracking page must keep its "last heard from", and the per-visitor table must be gone.
 */
const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
let pg: PGlite;
let scratch: string;

type Column = { column_name: string; data_type: string; is_nullable: string; column_default: string | null };

/** Insert a row giving only the columns that matter; every other required column gets a filler of the right type. */
async function insertRow(table: string, values: Record<string, unknown>) {
  const cols = (await pg.query<Column>(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])).rows;
  const row: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (c.column_name in row || c.is_nullable === "YES" || c.column_default !== null) continue;
    row[c.column_name] = c.data_type === "boolean" ? false : /int|numeric/.test(c.data_type) ? 0 : c.data_type === "jsonb" ? "{}" : /timestamp|date/.test(c.data_type) ? "2026-01-01T00:00:00Z" : `x_${table}_${c.column_name}`;
  }
  const names = Object.keys(row);
  await pg.query(`insert into "${table}" (${names.map((n) => `"${n}"`).join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`, names.map((n) => row[n]));
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "referly-migration-"));
  const upTo17 = path.join(scratch, "drizzle");
  await cp(REAL, upTo17, { recursive: true });
  const journalPath = path.join(upTo17, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 17);
  await writeFile(journalPath, JSON.stringify(journal));
  pg = new PGlite();
  await migrate(drizzle(pg), { migrationsFolder: upTo17 });
});
afterAll(async () => {
  await pg?.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("migrating per-visitor journeys to daily totals", () => {
  it("starts from a database that still has journey_events and no journey_stats", async () => {
    const tables = (await pg.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'journey%'`)).rows.map((r) => r.table_name);
    expect(tables).toEqual(["journey_events"]);
  });

  it("carries over who landed with which click, the daily visitor totals per affiliate, and the last time the snippet reported", async () => {
    await insertRow("tenants", { id: "ten_1", slug: "acme" });
    await insertRow("tenants", { id: "ten_2", slug: "quiet" });
    await insertRow("affiliates", { id: "aff_1", tenant_id: "ten_1", email: "a1@example.com" });
    await insertRow("affiliates", { id: "aff_2", tenant_id: "ten_1", email: "a2@example.com" });
    // Clicks point at links, programs and offers this test has no use for.
    await pg.exec(`set session_replication_role = replica`);
    await insertRow("clicks", { id: "clk_1", tenant_id: "ten_1", affiliate_id: "aff_1", click_token: "tokenAAAA1" });
    await insertRow("clicks", { id: "clk_2", tenant_id: "ten_1", affiliate_id: "aff_2", click_token: "tokenBBBB2" });
    await insertRow("clicks", { id: "clk_3", tenant_id: "ten_1", affiliate_id: "aff_1", click_token: "tokenCCCC3" });
    const ev = (id: string, o: Record<string, unknown>) => insertRow("journey_events", { id, tenant_id: "ten_1", session_id: "s_1", type: "page_view", ...o });
    // day one: visitor 1 (Alice's click) views two pages and triggers an event; visitor 2 came through Bob's click
    await ev("jev_1", { visitor_id: "v_one_0000001", click_id: "clk_1", affiliate_id: "aff_1", occurred_at: "2026-09-11T08:45:00Z" });
    await ev("jev_2", { visitor_id: "v_one_0000001", click_id: "clk_1", affiliate_id: "aff_1", occurred_at: "2026-09-11T08:50:00Z" });
    await ev("jev_3", { visitor_id: "v_one_0000001", click_id: "clk_1", affiliate_id: "aff_1", type: "event", name: "add_to_cart", occurred_at: "2026-09-11T08:51:00Z" });
    await ev("jev_4", { visitor_id: "v_two_0000002", click_id: "clk_2", affiliate_id: "aff_2", occurred_at: "2026-09-11T23:59:00Z" });
    // the purchase row of visitor 1 is a sale, not a visit
    await ev("jev_5", { visitor_id: "v_one_0000001", click_id: "clk_1", affiliate_id: "aff_1", type: "conversion", occurred_at: "2026-09-11T09:08:00Z" });
    // day two: visitor 1 again, remembered without a click on the row, and a third visitor through Alice
    await ev("jev_6", { visitor_id: "v_one_0000001", click_id: null, affiliate_id: "aff_1", occurred_at: "2026-09-12T09:13:00Z" });
    await ev("jev_7", { visitor_id: "v_six_0000006", click_id: "clk_3", affiliate_id: "aff_1", occurred_at: "2026-09-12T10:00:00Z" });
    // from before only affiliate traffic was kept: a visitor nobody sent
    await ev("jev_8", { visitor_id: "v_nobody_00009", click_id: null, affiliate_id: null, occurred_at: "2026-09-12T11:00:00Z" });
    await pg.exec(`set session_replication_role = origin`);

    await migrate(drizzle(pg), { migrationsFolder: REAL });

    const clicks = (await pg.query<{ id: string; visitor_id: string | null }>(`select id, visitor_id from clicks order by id`)).rows;
    expect(clicks).toEqual([
      { id: "clk_1", visitor_id: "v_one_0000001" },
      { id: "clk_2", visitor_id: "v_two_0000002" },
      { id: "clk_3", visitor_id: "v_six_0000006" },
    ]);
    const stats = (await pg.query<{ tenant_id: string; day: string; affiliate_id: string; page: string; stage: string; count: number }>(`select tenant_id, day::text as day, affiliate_id, page, stage, count from journey_stats order by day, affiliate_id`)).rows;
    expect(stats).toEqual([
      { tenant_id: "ten_1", day: "2026-09-11", affiliate_id: "aff_1", page: "", stage: "visit", count: 1 },
      { tenant_id: "ten_1", day: "2026-09-11", affiliate_id: "aff_2", page: "", stage: "visit", count: 1 },
      { tenant_id: "ten_1", day: "2026-09-12", affiliate_id: "aff_1", page: "", stage: "visit", count: 2 },
    ]);
    const ids = (await pg.query<{ id: string }>(`select id from journey_stats`)).rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^jst_[0-9a-f]{21}$/);
    const tenants = (await pg.query<{ id: string; last: string | null }>(`select id, tracking_last_at::text as last from tenants order by id`)).rows;
    expect(new Date(tenants[0]!.last!).toISOString()).toBe("2026-09-12T11:00:00.000Z");
    expect(tenants[1]).toEqual({ id: "ten_2", last: null });
  });

  it("drops the per-visitor table, and the new one is under row-level security like every tenant table", async () => {
    const tables = (await pg.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'journey%'`)).rows.map((r) => r.table_name);
    expect(tables).toEqual(["journey_stats"]);
    const [rls] = (await pg.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'journey_stats'`)).rows;
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    // the bypass the migration switched on for its copy did not outlive its transaction
    const [setting] = (await pg.query<{ v: string | null }>(`select current_setting('app.rls_bypass', true) as v`)).rows;
    expect(setting!.v === null || setting!.v === "").toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import * as exportsSvc from "../src/services/exports";
import * as conversions from "../src/services/conversions";

/**
 * Exports as a merchant meets them: a catalog in plain words, an optional period measured on the
 * date that matters for each dataset, the affiliate performance report for a period, and a file
 * name that says what the file is and what it covers.
 */
let db: Db;
const clock = makeClock("2026-08-01T09:00:00Z");
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
});
afterAll(closeDb);

async function collect(entity: exportsSvc.ExportEntity, opts: exportsSvc.ExportRowOptions = {}) {
  const out: Record<string, unknown>[] = [];
  for await (const page of exportsSvc.iterateExportRows(db, ws.ctx, entity, opts)) out.push(...page);
  return out;
}

describe("exports", () => {
  it("offers every dataset in plain words, and only what the API can build", () => {
    expect(exportsSvc.EXPORT_DATASETS.map((d) => d.id).sort()).toEqual([...exportsSvc.EXPORT_ENTITIES].sort());
    for (const d of exportsSvc.EXPORT_DATASETS) {
      expect(d.label, d.id).toMatch(/^[A-Z]/);
      expect(d.description.length, d.id).toBeGreaterThan(20);
      expect(d.period === "optional" ? !!d.datedBy : true, d.id).toBe(true);
    }
    expect(exportsSvc.EXPORT_DATASETS.find((d) => d.id === "workspace")).toMatchObject({ format: "json", period: "none", ownerOnly: true });
    expect(exportsSvc.EXPORT_DATASETS[0]).toMatchObject({ id: "performance", period: "required" });
  });

  it("a period needs both ends in order; the performance report needs one; a workspace backup never has one", async () => {
    await expect(exportsSvc.requestExport(db, ws.ctx, { entity: "conversions", from: "2026-08-01" })).rejects.toThrow(/both ends/);
    await expect(exportsSvc.requestExport(db, ws.ctx, { entity: "conversions", from: "2026-08-10", to: "2026-08-01" })).rejects.toThrow(/start before/);
    await expect(exportsSvc.requestExport(db, ws.ctx, { entity: "performance" })).rejects.toThrow(/choose a period/);
    const all = await exportsSvc.requestExport(db, ws.ctx, { entity: "conversions" });
    expect(all).toMatchObject({ periodFrom: null, periodTo: null, status: "queued" });
    const dated = await exportsSvc.requestExport(db, ws.ctx, { entity: "conversions", from: "2026-08-01T00:00:00Z", to: "2026-08-31T23:59:59Z" });
    expect(dated.periodFrom?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    const backup = await exportsSvc.requestExport(db, ws.ctx, { entity: "workspace", from: "2026-08-01", to: "2026-08-31" });
    expect(backup).toMatchObject({ periodFrom: null, periodTo: null });

    expect(exportsSvc.exportFileName(all)).toBe("conversions-all-2026-08-01.csv");
    expect(exportsSvc.exportFileName(dated)).toBe("conversions-2026-08-01-to-2026-08-31.csv");
    expect(exportsSvc.exportFileName(backup)).toBe("workspace-all-2026-08-01.jsonl");
    expect(exportsSvc.publicExport(dated)).toMatchObject({ label: "Sales and leads", fileName: "conversions-2026-08-01-to-2026-08-31.csv" });
  });

  it("a period keeps the sales that happened inside it, by the date of the sale, and the performance report sums the same period per affiliate", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const bob = await createActiveAffiliate(db, ws, "Bob");
    const sell = async (aff: typeof alice, id: string, amountMinor: number) => {
      const { token } = await clickFor(db, ws, aff, clock);
      return conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: id, offerId: ws.offer.id, amountMinor, clickToken: token });
    };
    await sell(alice, "AUG-1", 10_000); // 1 August
    clock.advanceDays(20);
    await sell(alice, "AUG-2", 20_000); // 21 August
    clock.set(new Date(clock.now().getTime() + 60_000)); // a minute later: rows made in the same instant come out in id order, which is arbitrary
    await sell(bob, "AUG-3", 5_000);
    clock.advanceDays(20);
    await sell(bob, "SEP-1", 40_000); // 10 September

    const august = { from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-31T23:59:59Z") };
    expect((await collect("conversions")).map((r) => r.externalOrderId)).toEqual(["AUG-1", "AUG-2", "AUG-3", "SEP-1"]);
    expect((await collect("conversions", august)).map((r) => r.externalOrderId)).toEqual(["AUG-1", "AUG-2", "AUG-3"]);
    expect((await collect("conversions", { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T23:59:59Z") })).map((r) => r.externalOrderId)).toEqual(["SEP-1"]);
    // paging does not disturb the period
    expect((await collect("conversions", { ...august, batchSize: 1 })).map((r) => r.externalOrderId)).toEqual(["AUG-1", "AUG-2", "AUG-3"]);
    expect(await collect("clicks", august)).toHaveLength(3);
    expect(Object.keys((await collect("conversions"))[0]!)).not.toContain("customerEmailHash");

    const report = await exportsSvc.performanceReportRows(db, ws.ctx, august, "USD");
    expect(report.map((r) => [r.affiliate, r.clicks, r.sales, r.revenue, r.commission, r.conversionRate])).toEqual([
      ["Alice", 2, 2, "300.00", "60.00", "100.0%"],
      ["Bob", 1, 1, "50.00", "10.00", "100.0%"],
    ]);
    expect(Object.keys(report[0]!)).toEqual(exportsSvc.PERFORMANCE_COLUMNS);
    expect(report[0]).toMatchObject({ currency: "USD", periodFrom: "2026-08-01", periodTo: "2026-08-31" });
    // an affiliate's name cannot run as a formula when the file is opened in a spreadsheet
    expect(exportsSvc.toCsv([{ affiliate: "=HYPERLINK(\"http://evil\")" }])).toContain("'=HYPERLINK");
  });
});

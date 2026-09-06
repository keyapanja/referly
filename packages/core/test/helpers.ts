import { createDb, type Db, type DbHandle } from "../src/db/client";
import { setSessionBypass } from "../src/db/rls";
import { tenantContext, type TenantContext } from "../src/context";
import * as tenants from "../src/services/tenants";
import * as offers from "../src/services/offers";
import * as programs from "../src/services/programs";
import * as affiliates from "../src/services/affiliates";
import * as tracking from "../src/services/tracking";
import type { Affiliate, Offer, Program, Tenant, User } from "../src/db/schema";

export interface Clock {
  now: () => Date;
  set: (d: Date | string) => void;
  advanceDays: (n: number) => void;
}

export function makeClock(start = "2026-01-01T00:00:00Z"): Clock {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (d) => {
      current = new Date(d);
    },
    advanceDays: (n) => {
      current = new Date(current.getTime() + n * 86_400_000);
    },
  };
}

export interface Workspace {
  tenant: Tenant;
  owner: User;
  ctx: TenantContext;
  offer: Offer;
  program: Program;
}

let handle: DbHandle | null = null;
export async function getDb(): Promise<Db> {
  if (!handle) {
    handle = await createDb();
    // Core tests exercise services directly on one connection; RLS is covered by rls.test.ts.
    await setSessionBypass(handle.db);
  }
  return handle.db;
}
export async function closeDb() {
  await handle?.close();
  handle = null;
}

let counter = 0;
export async function createWorkspace(
  db: Db,
  clock: Clock,
  opts: { slug?: string; programOverrides?: Partial<programs.CreateProgramInput>; currency?: string } = {},
): Promise<Workspace> {
  counter++;
  const slug = opts.slug ?? `acme-${counter}-${Date.now().toString(36)}`;
  const { tenant, owner } = await tenants.createTenant(
    db,
    { name: `Acme ${counter}`, slug, currency: opts.currency ?? "USD", owner: { name: "Owner", email: `owner-${counter}@example.com`, password: "password123" } },
    clock.now(),
  );
  const ctx = tenantContext(tenant.id, { type: "user", id: owner.id, role: "owner" }, clock.now);
  const offer = await offers.createOffer(db, ctx, { name: "Coaching Program", priceMinor: 100_000, salesUrl: "https://acme.example.com/coaching" }, tenant.currency);
  await offers.setOfferStatus(db, ctx, offer.id, "active");
  const program = await programs.createProgram(db, ctx, {
    name: "Partner Program",
    commissionModel: "percentage",
    commissionPercent: 20,
    holdingDays: 30,
    attributionWindowDays: 30,
    refundPolicy: "full",
    offerIds: [offer.id],
    ...opts.programOverrides,
  });
  await programs.setProgramStatus(db, ctx, program.id, "active");
  return { tenant, owner, ctx, offer, program: await programs.getProgram(db, ctx, program.id) };
}

export async function createActiveAffiliate(db: Db, ws: Workspace, name = "Alice", programId = ws.program.id): Promise<Affiliate> {
  counter++;
  return affiliates.createAffiliate(db, ws.ctx, { name, email: `${name.toLowerCase()}-${counter}@example.com`, programIds: [programId] });
}

export async function clickFor(db: Db, ws: Workspace, affiliate: Affiliate, clock: Clock, offerId = ws.offer.id, programId = ws.program.id) {
  const link = await tracking.createTrackingLink(db, ws.ctx, { affiliateId: affiliate.id, programId, offerId });
  const result = await tracking.recordClick(db, link.token, { userAgent: "test" }, clock.now());
  if (!result?.click) throw new Error(`click not tracked: ${result?.reason}`);
  return { link, click: result.click, token: result.click.clickToken };
}

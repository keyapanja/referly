import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import * as tracking from "../src/services/tracking";
import * as assets from "../src/services/assets";
import * as account from "../src/services/account";
import * as auth from "../src/services/auth";
import * as programs from "../src/services/programs";
import * as offers from "../src/services/offers";
import * as tenants from "../src/services/tenants";
import { jobs as jobsTable, users } from "../src/db/schema";
import { tenantContext } from "../src/context";

let db: Db;
const clock = makeClock();
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
});
afterAll(closeDb);

describe("asset library permissions (AST-01, AST-02)", () => {
  it("affiliates see public assets plus those scoped to their program, offer or themselves", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const bob = await createActiveAffiliate(db, ws, "Bob");
    // a second program Bob is not in
    const vip = await programs.createProgram(db, ws.ctx, { name: "VIP", commissionModel: "percentage", commissionPercent: 30, offerIds: [ws.offer.id] });
    await programs.setProgramStatus(db, ws.ctx, vip.id, "active");
    const carol = await createActiveAffiliate(db, ws, "Carol", vip.id);
    const otherOffer = await offers.createOffer(db, ws.ctx, { name: "Other", salesUrl: "https://acme.example.com/other" }, "USD");
    await programs.attachOffer(db, ws.ctx, vip.id, otherOffer.id);

    const pub = await assets.createAsset(db, ws.ctx, { type: "copy", title: "Elevator pitch", body: "Best coaching ever." });
    const vipOnly = await assets.createAsset(db, ws.ctx, { type: "pdf", title: "VIP deck", url: "https://cdn.example.com/vip.pdf", visibility: "restricted", programIds: [vip.id] });
    const offerOnly = await assets.createAsset(db, ws.ctx, { type: "banner", title: "Other banner", url: "https://cdn.example.com/other.png", visibility: "restricted", offerIds: [otherOffer.id] });
    const aliceOnly = await assets.createAsset(db, ws.ctx, { type: "guideline", title: "Alice brief", body: "Just for Alice", visibility: "restricted", affiliateIds: [alice.id] });
    const archived = await assets.createAsset(db, ws.ctx, { type: "image", title: "Old", url: "https://cdn.example.com/old.png" });
    await assets.updateAsset(db, ws.ctx, archived.id, { status: "archived" });

    const ids = async (affId: string) => (await assets.listAssetsForAffiliate(db, tenantContext(ws.tenant.id, { type: "affiliate", id: affId, affiliateId: affId }, clock.now), affId)).map((a) => a.id).sort();
    expect(await ids(alice.id)).toEqual([pub.id, aliceOnly.id].sort());
    expect(await ids(bob.id)).toEqual([pub.id]);
    expect(await ids(carol.id)).toEqual([pub.id, vipOnly.id, offerOnly.id].sort());

    // restricted with no scope is rejected; permissions can be replaced later
    await expect(assets.createAsset(db, ws.ctx, { type: "link", title: "x", url: "https://x.example.com", visibility: "restricted" })).rejects.toThrow();
    await assets.setAssetPermissions(db, ws.ctx, vipOnly.id, { programIds: [ws.program.id] });
    expect(await ids(bob.id)).toEqual([pub.id, vipOnly.id].sort());
    expect(await ids(carol.id)).toEqual([pub.id, offerOnly.id].sort());
    await assets.setAssetPermissions(db, ws.ctx, vipOnly.id, {});
    expect((await assets.getAsset(db, ws.ctx, vipOnly.id)).visibility).toBe("all");

    // merchant list includes permission rows; other tenants see nothing
    const list = await assets.listAssets(db, ws.ctx);
    expect(list.find((a) => a.id === aliceOnly.id)?.permissions.map((p) => p.affiliateId)).toEqual([alice.id]);
    const other = await createWorkspace(db, clock);
    expect(await assets.listAssets(db, other.ctx)).toHaveLength(0);
    await expect(assets.getAsset(db, other.ctx, pub.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("email verification and password reset", () => {
  async function tokenFromQueue(type: string): Promise<string> {
    const rows = await db.select().from(jobsTable).where(eq(jobsTable.type, "domain_event"));
    const ev = rows.map((r) => r.payload as any).filter((p) => p.type === type).pop();
    return ev.data.token as string;
  }

  it("signup issues a verification token; consuming it marks the user verified once", async () => {
    const { owner } = await tenants.createTenant(db, { name: "Verify Co", slug: `verify-${Date.now().toString(36)}`, owner: { name: "V", email: `v-${Date.now()}@example.com`, password: "password123" } }, clock.now());
    expect(owner.emailVerifiedAt).toBeNull();
    const token = await tokenFromQueue("user.verify_email");
    const verified = await account.verifyEmail(db, token, clock.now());
    expect(verified.id).toBe(owner.id);
    expect(verified.emailVerifiedAt).not.toBeNull();
    await expect(account.verifyEmail(db, token, clock.now())).rejects.toMatchObject({ code: "validation" });
    await expect(account.verifyEmail(db, "nope-nope-nope", clock.now())).rejects.toMatchObject({ code: "validation" });
  });

  it("password reset works once, expires, and revokes existing sessions", async () => {
    const email = ws.owner.email;
    const before = await auth.loginWithPassword(db, { email, password: "password123" }, clock.now());
    expect(await account.requestPasswordReset(db, { email: "nobody@example.com" }, clock.now())).toBe(0);
    expect(await account.requestPasswordReset(db, { email }, clock.now())).toBe(1);
    const token = await tokenFromQueue("user.password_reset_requested");

    await account.resetPassword(db, { token, password: "newpassword9" }, clock.now());
    expect(await auth.resolveSession(db, before.token, clock.now())).toBeNull(); // old session gone
    await expect(auth.loginWithPassword(db, { email, password: "password123" })).rejects.toMatchObject({ code: "unauthenticated" });
    const after = await auth.loginWithPassword(db, { email, password: "newpassword9" }, clock.now());
    expect(after.user.id).toBe(ws.owner.id);
    await expect(account.resetPassword(db, { token, password: "another123" }, clock.now())).rejects.toMatchObject({ code: "validation" });

    // expiry
    await account.requestPasswordReset(db, { email }, clock.now());
    const token2 = await tokenFromQueue("user.password_reset_requested");
    clock.advanceDays(1);
    await expect(account.resetPassword(db, { token2, password: "x" } as never, clock.now())).rejects.toThrow();
    await expect(account.resetPassword(db, { token: token2, password: "another123" }, clock.now())).rejects.toMatchObject({ code: "validation" });
    // restore for other tests
    await db.update(users).set({ passwordHash: await auth.hashPassword("password123") }).where(eq(users.id, ws.owner.id));
  });

  describe("merge fields in copy assets", () => {
    it("renders known variables, leaves unknown ones visible, and reports which are used", () => {
      expect(assets.renderCopy("Hi {{affiliate_name}}, use {{ link }} or code {{coupon_code}}. {{nope}}", { affiliate_name: "Ann", link: "https://x/r/abc", coupon_code: null })).toBe("Hi Ann, use https://x/r/abc or code . {{nope}}");
      expect(assets.copyVariablesUsed("{{link}} {{link}} {{offer_url}} {{nope}}")).toEqual(["link", "offer_url"]);
      expect(assets.COPY_VARIABLES.map((v) => v.key)).toContain("commission");
    });

    it("personalises copy per affiliate with their own link (created if missing), coupon, commission and names", async () => {
      const ws2 = await createWorkspace(db, clock, { programOverrides: { approvalMode: "auto" } });
      const ann = await createActiveAffiliate(db, ws2, "Ann");
      const bea = await createActiveAffiliate(db, ws2, "Bea");
      await tracking.createCouponCode(db, ws2.ctx, { affiliateId: bea.id, programId: ws2.program.id, code: "BEA20" });
      const { link: beaLink } = await clickFor(db, ws2, bea, clock);
      const asset = await assets.createAsset(db, ws2.ctx, { type: "copy", title: "Post", body: "{{affiliate_name}} recommends {{offer_name}} by {{business_name}}: {{link}} code {{coupon_code}} ({{commission}}) {{offer_url}} {{portal_url}}", visibility: "all" });
      await assets.createAsset(db, ws2.ctx, { type: "guideline", title: "Plain", body: "No fields here", visibility: "all" });
      const opts = { baseUrl: "https://api.test", webUrl: "https://web.test/" };

      const annCtx = tenantContext(ws2.tenant.id, { type: "affiliate", id: ann.id, affiliateId: ann.id, role: "affiliate" }, clock.now);
      const annRows = await assets.personaliseAssets(db, annCtx, ann.id, await assets.listAssetsForAffiliate(db, annCtx, ann.id), opts);
      const annPost = annRows.find((a) => a.id === asset.id)!;
      const annLinks = await tracking.listTrackingLinks(db, annCtx, ann.id);
      expect(annLinks).toHaveLength(1); // created on first view
      expect(annPost.renderedBody).toBe(`Ann recommends ${ws2.offer.name} by ${ws2.tenant.name}: https://api.test/r/${annLinks[0]!.token} code  (20%) ${ws2.offer.salesUrl} https://web.test/portal`);
      expect(annPost.variablesUsed).toEqual(["affiliate_name", "offer_name", "business_name", "link", "coupon_code", "commission", "offer_url", "portal_url"]);
      expect(annRows.find((a) => a.title === "Plain")!.renderedBody).toBe("No fields here");

      const beaCtx = tenantContext(ws2.tenant.id, { type: "affiliate", id: bea.id, affiliateId: bea.id, role: "affiliate" }, clock.now);
      const beaRows = await assets.personaliseAssets(db, beaCtx, bea.id, await assets.listAssetsForAffiliate(db, beaCtx, bea.id), opts);
      const beaPost = beaRows.find((a) => a.id === asset.id)!;
      expect(beaPost.renderedBody).toContain(`https://api.test/r/${beaLink.token}`); // existing link reused, none created
      expect(beaPost.renderedBody).toContain("code BEA20");
      expect(await tracking.listTrackingLinks(db, beaCtx, bea.id)).toHaveLength(1);
      // one affiliate can never render another's copy
      await expect(assets.personaliseAssets(db, annCtx, bea.id, [], opts)).rejects.toThrow(/scope/);
    });
  });
});

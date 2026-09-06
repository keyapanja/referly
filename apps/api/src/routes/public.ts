import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { tracking, programs, affiliates, auth, tenants, systemContext, notFound, validation, offers } from "@referly/core";
import { setSessionCookie, type AppEnv } from "../lib/auth";
import { publicTenant } from "./auth";

export const CLICK_COOKIE = "referly_clicks";
const MAX_COOKIE_TOKENS = 10;

/**
 * Unauthenticated endpoints. Tenant is always derived from an opaque token in the URL
 * (tracking link, join token, invite token), never from user input.
 */
export function publicRoutes() {
  const r = new Hono<AppEnv>();

  /**
   * TRK-02/03: click redirect. Records the click, appends the click token to a first-party
   * cookie (most recent last, so last-touch is simply the tail), then redirects. Visitors
   * are redirected even when tracking is refused.
   */
  r.get("/r/:token", async (c) => {
    const { db } = c.get("deps");
    const consent = c.req.query("consent") as "granted" | "denied" | undefined;
    const result = await tracking.recordClick(
      db,
      c.req.param("token"),
      {
        referrer: c.req.header("referer") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? null,
        country: c.req.header("cf-ipcountry") ?? c.req.header("x-country") ?? null,
        consentState: consent ?? "unknown",
      },
      c.get("now")(),
    );
    if (!result) throw notFound("link");
    const url = new URL(result.destinationUrl);
    if (result.click) {
      const existing = (getCookie(c, CLICK_COOKIE) ?? "").split(".").filter(Boolean);
      const tokens = [...existing.filter((t) => t !== result.click!.clickToken), result.click.clickToken].slice(-MAX_COOKIE_TOKENS);
      setCookie(c, CLICK_COOKIE, tokens.join("."), { httpOnly: true, sameSite: "Lax", secure: c.get("deps").config.cookieSecure, path: "/", maxAge: result.cookieMaxAgeSeconds });
      // Also expose the token as a query param so merchant checkout pages on other domains can forward it.
      url.searchParams.set("ref", result.click.clickToken);
    }
    return c.redirect(url.toString(), 302);
  });

  /** Journey C: branded application page data. */
  r.get("/join/:token", async (c) => {
    const { db } = c.get("deps");
    const program = await programs.getProgramByJoinToken(db, c.req.param("token"));
    if (!program || program.status !== "active" || program.approvalMode === "invite_only") throw notFound("program");
    const ctx = systemContext(program.tenantId, c.get("now"));
    const tenant = await tenants.getTenant(db, ctx);
    const programOffers = await programs.listProgramOffers(db, ctx, program.id);
    const offerRows = await offers.listOffersForPrograms(db, ctx, [program.id]);
    return c.json({
      tenant: publicTenant(tenant),
      program: {
        id: program.id,
        name: program.name,
        description: program.description,
        commissionModel: program.commissionModel,
        commissionPercent: program.commissionRateBps / 100,
        commissionFixedMinor: program.commissionFixedMinor,
        holdingDays: program.holdingDays,
        attributionWindowDays: program.attributionWindowDays,
        approvalMode: program.approvalMode,
        termsVersion: program.termsVersion,
        termsText: program.termsText,
        offerCount: programOffers.length,
      },
      offers: offerRows.map((o) => ({ id: o.id, name: o.name, shortDescription: o.shortDescription, priceMinor: o.priceMinor, currency: o.currency, imageUrl: o.imageUrl })),
    });
  });

  r.post("/join/:token/apply", async (c) => {
    const { db } = c.get("deps");
    const program = await programs.getProgramByJoinToken(db, c.req.param("token"));
    if (!program) throw notFound("program");
    const ctx = systemContext(program.tenantId, c.get("now"));
    const { affiliate, membership } = await affiliates.applyToProgram(db, ctx, program.id, await c.req.json());
    // Applicants can sign in right away; the portal shows a "pending review" state until approved.
    const user = affiliate.userId ? await auth.resolveUserById(db, affiliate.userId) : null;
    let token: string | null = null;
    if (user && affiliate.status === "active") {
      const session = await auth.createSession(db, user, c.get("now")());
      setSessionCookie(c, session.token, session.expiresAt);
      token = session.token;
    }
    return c.json({ affiliate: { id: affiliate.id, status: affiliate.status }, membership: { status: membership.status }, token }, 201);
  });

  /** Journey B */
  r.get("/invite/:token", async (c) => {
    const { db } = c.get("deps");
    const invite = await affiliates.getInviteByToken(db, c.req.param("token"));
    if (!invite) throw notFound("invite");
    const ctx = systemContext(invite.tenantId, c.get("now"));
    const [tenant, program] = await Promise.all([tenants.getTenant(db, ctx), programs.getProgram(db, ctx, invite.programId)]);
    return c.json({
      invite: { email: invite.email, name: invite.name, status: invite.status, expiresAt: invite.expiresAt },
      tenant: publicTenant(tenant),
      program: { id: program.id, name: program.name, termsVersion: program.termsVersion, termsText: program.termsText, commissionPercent: program.commissionRateBps / 100, commissionModel: program.commissionModel, commissionFixedMinor: program.commissionFixedMinor },
    });
  });

  r.post("/invite/:token/accept", async (c) => {
    const { db } = c.get("deps");
    const invite = await affiliates.getInviteByToken(db, c.req.param("token"));
    if (!invite) throw notFound("invite");
    const ctx = systemContext(invite.tenantId, c.get("now"));
    const { affiliate } = await affiliates.acceptInvite(db, ctx, invite, await c.req.json());
    if (!affiliate.userId) throw validation("affiliate has no login");
    const user = await auth.resolveUserById(db, affiliate.userId);
    const session = await auth.createSession(db, user!, c.get("now")());
    setSessionCookie(c, session.token, session.expiresAt);
    return c.json({ affiliate: { id: affiliate.id, status: affiliate.status }, token: session.token }, 201);
  });

  return r;
}

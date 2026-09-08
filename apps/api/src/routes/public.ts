import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { tracking, programs, affiliates, auth, tenants, systemContext, notFound, validation, offers, integrations, messaging, textProviders } from "@referly/core";
import { setSessionCookie, type AppEnv } from "../lib/auth";
import { scopeRequest } from "../lib/rls";
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
   * Twilio messaging webhooks. The tenant is in the path; the request is trusted only if it
   * carries a valid X-Twilio-Signature for that tenant's auth token (or the platform account).
   */
  async function twilioParams(c: Context<AppEnv, "/hooks/twilio/:tenantId/status" | "/hooks/twilio/:tenantId/inbound">): Promise<{ tenantId: string; params: Record<string, string> }> {
    const tenantId = c.req.param("tenantId");
    const tenant = await tenants.getTenant(c.get("deps").db, systemContext(tenantId, c.get("now")));
    if (!tenant || tenant.status !== "active") throw notFound("tenant", tenantId);
    await scopeRequest(c, tenantId);
    const ctx = systemContext(tenantId, c.get("now"));
    const token = (await integrations.twilioAuthToken(c.get("deps").db, ctx)) ?? process.env.TWILIO_AUTH_TOKEN ?? null;
    if (!token) throw notFound("integration", "twilio");
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(await c.req.parseBody())) if (typeof v === "string") params[k] = v;
    const url = `${c.get("deps").config.baseUrl}${new URL(c.req.url).pathname}`;
    if (!textProviders.verifyTwilioSignature(token, url, params, c.req.header("x-twilio-signature"))) throw validation("invalid Twilio signature");
    return { tenantId, params };
  }

  /** Delivery status: delivered / undelivered / failed are terminal and recorded on the log. */
  r.post("/hooks/twilio/:tenantId/status", async (c) => {
    const { tenantId, params } = await twilioParams(c);
    const status = params.MessageStatus;
    if (params.MessageSid && (status === "delivered" || status === "undelivered" || status === "failed")) {
      await messaging.recordDeliveryStatus(c.get("deps").db, systemContext(tenantId, c.get("now")), params.MessageSid, status, params.ErrorCode ? `twilio error ${params.ErrorCode}` : undefined);
    }
    return c.body(null, 204);
  });

  /** Inbound keywords: STOP/UNSUBSCRIBE opt the sender out, START/UNSTOP/YES opt them back in. */
  r.post("/hooks/twilio/:tenantId/inbound", async (c) => {
    const { tenantId, params } = await twilioParams(c);
    const word = (params.Body ?? "").trim().toUpperCase();
    const from = params.From ?? "";
    if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(word)) await affiliates.setTextOptOutByPhone(c.get("deps").db, systemContext(tenantId, c.get("now")), from, true);
    else if (["START", "UNSTOP", "YES"].includes(word)) await affiliates.setTextOptOutByPhone(c.get("deps").db, systemContext(tenantId, c.get("now")), from, false);
    return c.text('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, { "content-type": "text/xml" });
  });

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
    await scopeRequest(c, program.tenantId);
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
    await scopeRequest(c, program.tenantId);
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
    await scopeRequest(c, invite.tenantId);
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
    await scopeRequest(c, invite.tenantId);
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

import { Hono } from "hono";
import { z } from "zod";
import { campaigns } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/** Campaigns (AST-03..05): time-bound promotions with commission overrides, bonuses, assets and participation. */
export function campaignRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });
  r.get("/", async (c) => {
    const q = c.req.query();
    return c.json({ campaigns: await campaigns.listCampaigns(c.get("deps").db, c.get("ctx"), { programId: q.programId, status: q.status as campaigns.CampaignStatus | undefined }) });
  });
  r.post("/", async (c) => c.json({ campaign: await campaigns.createCampaign(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201));
  r.get("/:id", async (c) => c.json(await campaigns.getCampaignDetail(c.get("deps").db, c.get("ctx"), c.req.param("id"))));
  r.patch("/:id", async (c) => c.json({ campaign: await campaigns.updateCampaign(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  r.post("/:id/status", async (c) => {
    const { status, reason } = z.object({ status: z.enum(campaigns.CAMPAIGN_STATUSES), reason: z.string().optional() }).parse(await c.req.json());
    return c.json({ campaign: await campaigns.setCampaignStatus(c.get("deps").db, c.get("ctx"), c.req.param("id"), status, reason) });
  });
  r.post("/:id/participants", async (c) => c.json({ participants: await campaigns.inviteParticipants(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }, 201));
  r.delete("/:id/participants/:affiliateId", async (c) => {
    await campaigns.removeParticipant(c.get("deps").db, c.get("ctx"), c.req.param("id"), c.req.param("affiliateId"));
    return c.json({ ok: true });
  });
  r.put("/:id/assets", async (c) => {
    const { assetIds } = z.object({ assetIds: z.array(z.string()) }).parse(await c.req.json());
    return c.json({ assetIds: await campaigns.setCampaignAssets(c.get("deps").db, c.get("ctx"), c.req.param("id"), assetIds) });
  });
  return r;
}

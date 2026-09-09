import { Hono } from "hono";
import { z } from "zod";
import { programs, tiers } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

export function programRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => c.json({ programs: await programs.listPrograms(c.get("deps").db, c.get("ctx"), { status: c.req.query("status") as never }) }));
  r.post("/", async (c) => c.json({ program: await programs.createProgram(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201));
  r.get("/:id", async (c) => {
    const { db } = c.get("deps");
    const program = await programs.getProgram(db, c.get("ctx"), c.req.param("id"));
    const offers = await programs.listProgramOffers(db, c.get("ctx"), program.id);
    const { webUrl } = c.get("deps").config;
    const { baseUrl } = c.get("deps").config;
    return c.json({ program, offers, joinUrl: `${webUrl}/join/${program.joinToken}`, captureUrl: program.leadsEnabled && program.leadCaptureToken ? `${baseUrl}/capture/${program.leadCaptureToken}` : null });
  });
  r.patch("/:id", async (c) => {
    const body = await c.req.json();
    return c.json({ program: await programs.updateProgram(c.get("deps").db, c.get("ctx"), c.req.param("id"), body, body.reason) });
  });
  r.post("/:id/status", async (c) => {
    const { status } = z.object({ status: z.enum(["draft", "active", "paused", "archived"]) }).parse(await c.req.json());
    return c.json({ program: await programs.setProgramStatus(c.get("deps").db, c.get("ctx"), c.req.param("id"), status) });
  });
  r.post("/:id/offers", async (c) => {
    const body = z.object({ offerId: z.string(), commissionPercent: z.number().optional(), commissionFixedMinor: z.number().int().optional() }).parse(await c.req.json());
    return c.json({ programOffer: await programs.attachOffer(c.get("deps").db, c.get("ctx"), c.req.param("id"), body.offerId, body) }, 201);
  });
  /** PROG-11: rate tiers. */
  r.get("/:id/tiers", async (c) => c.json({ tiers: await tiers.listTiers(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.post("/:id/tiers", async (c) => c.json({ tier: await tiers.createTier(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }, 201));
  r.patch("/:id/tiers/:tierId", async (c) => c.json({ tier: await tiers.updateTier(c.get("deps").db, c.get("ctx"), c.req.param("id"), c.req.param("tierId"), await c.req.json()) }));
  r.delete("/:id/tiers/:tierId", async (c) => {
    await tiers.deleteTier(c.get("deps").db, c.get("ctx"), c.req.param("id"), c.req.param("tierId"));
    return c.json({ ok: true });
  });
  r.delete("/:id/offers/:offerId", async (c) => {
    await programs.detachOffer(c.get("deps").db, c.get("ctx"), c.req.param("id"), c.req.param("offerId"));
    return c.json({ ok: true });
  });
  return r;
}

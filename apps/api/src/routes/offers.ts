import { Hono } from "hono";
import { z } from "zod";
import { offers, tenants } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

export function offerRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => c.json({ offers: await offers.listOffers(c.get("deps").db, c.get("ctx"), { status: c.req.query("status") as never }) }));
  r.post("/", async (c) => {
    const { db } = c.get("deps");
    const tenant = await tenants.getTenant(db, c.get("ctx"));
    return c.json({ offer: await offers.createOffer(db, c.get("ctx"), await c.req.json(), tenant.currency) }, 201);
  });
  r.get("/:id", async (c) => c.json({ offer: await offers.getOffer(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.patch("/:id", async (c) => c.json({ offer: await offers.updateOffer(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  r.post("/:id/status", async (c) => {
    const { status } = z.object({ status: z.enum(["draft", "active", "paused", "archived"]) }).parse(await c.req.json());
    return c.json({ offer: await offers.setOfferStatus(c.get("deps").db, c.get("ctx"), c.req.param("id"), status) });
  });
  return r;
}

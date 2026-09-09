import { Hono } from "hono";
import { z } from "zod";
import { conversions, webhookDeliveries, newId, disputes, journeys } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

export function conversionRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });

  r.get("/", async (c) => {
    const q = c.req.query();
    return c.json({ conversions: await conversions.listConversions(c.get("deps").db, c.get("ctx"), { affiliateId: q.affiliateId, status: q.status as never, offerId: q.offerId, programId: q.programId, limit: q.limit ? Number(q.limit) : undefined }) });
  });

  /**
   * TRK-04: conversion intake for webhooks, API clients and manual entry. Every call is logged
   * as a webhook delivery so integrations can be debugged; duplicates return 200 with
   * `duplicate: true` and the original record.
   */
  r.post("/", async (c) => {
    const { db } = c.get("deps");
    const ctx = c.get("ctx");
    const body = await c.req.json();
    const principal = c.get("principal");
    const source = body.source ?? (principal.kind === "api_key" ? "webhook" : "manual");
    // Leads go through /v1/leads; this endpoint records sales whatever the body says.
    const input = { ...body, source, kind: "sale" };
    const deliveryId = newId("webhookDelivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      tenantId: ctx.tenantId,
      source,
      idempotencyKey: `${source}:${input.externalOrderId ?? "?"}:${deliveryId}`,
      payload: body,
      receivedAt: ctx.now(),
    });
    try {
      const result = await conversions.recordConversion(db, ctx, input);
      await db.update(webhookDeliveries).set({ status: result.duplicate ? "duplicate" : "processed", resultEntityType: "conversion", resultEntityId: result.conversion.id, processedAt: ctx.now() }).where(eqId(deliveryId));
      return c.json(result, result.duplicate ? 200 : 201);
    } catch (err) {
      await db.update(webhookDeliveries).set({ status: "failed", error: err instanceof Error ? err.message : String(err), processedAt: ctx.now() }).where(eqId(deliveryId));
      throw err;
    }
  });

  r.get("/:id", async (c) => c.json(await conversions.getConversionTimeline(c.get("deps").db, c.get("ctx"), c.req.param("id"))));
  /** What the buyer did on the merchant's site before and after this sale, when the site runs the snippet. */
  r.get("/:id/journey", async (c) => {
    const timeline = await conversions.getConversionTimeline(c.get("deps").db, c.get("ctx"), c.req.param("id"));
    const clickId = timeline.attributions.find((a) => !a.supersededById)?.clickId ?? timeline.attributions[0]?.clickId ?? null;
    return c.json(await journeys.journeyForConversion(c.get("deps").db, c.get("ctx"), timeline.conversion.id, clickId));
  });
  r.post("/:id/refund", async (c) => {
    const body = z.object({ amountMinor: z.number().int().positive().optional(), reason: z.string().min(1) }).parse(await c.req.json());
    return c.json(await conversions.refundConversion(c.get("deps").db, c.get("ctx"), { conversionId: c.req.param("id"), ...body }));
  });
  r.post("/:id/cancel", async (c) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(await c.req.json());
    return c.json({ conversion: await conversions.cancelConversion(c.get("deps").db, c.get("ctx"), c.req.param("id"), reason) });
  });
  r.post("/:id/approve", async (c) => c.json({ conversion: await conversions.approveConversion(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.post("/:id/dispute", async (c) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(await c.req.json());
    // Opens a proper dispute record (Phase 2); the sale is held as before.
    const dispute = await disputes.openDispute(c.get("deps").db, c.get("ctx"), { kind: "other", conversionId: c.req.param("id"), reason });
    return c.json({ conversion: await conversions.getConversion(c.get("deps").db, c.get("ctx"), c.req.param("id")), dispute });
  });
  r.post("/:id/reattribute", async (c) => {
    const body = await c.req.json();
    return c.json(await conversions.reattributeConversion(c.get("deps").db, c.get("ctx"), { ...body, conversionId: c.req.param("id") }));
  });
  return r;
}

import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(webhookDeliveries.id, id);
}

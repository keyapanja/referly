import { Hono } from "hono";
import { z } from "zod";
import { groups } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/** Affiliate groups (AFF-04). */
export function groupRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });
  r.get("/", async (c) => c.json({ groups: await groups.listGroups(c.get("deps").db, c.get("ctx")), kinds: groups.GROUP_KINDS }));
  r.post("/", async (c) => c.json({ group: await groups.createGroup(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201));
  r.patch("/:id", async (c) => c.json({ group: await groups.updateGroup(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  r.delete("/:id", async (c) => {
    await groups.deleteGroup(c.get("deps").db, c.get("ctx"), c.req.param("id"));
    return c.json({ ok: true });
  });
  r.get("/:id/members", async (c) => c.json({ members: await groups.listMembers(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.post("/:id/members", async (c) => {
    const { affiliateIds } = z.object({ affiliateIds: z.array(z.string()).min(1) }).parse(await c.req.json());
    return c.json({ added: await groups.addMembers(c.get("deps").db, c.get("ctx"), c.req.param("id"), affiliateIds) }, 201);
  });
  r.delete("/:id/members/:affiliateId", async (c) => {
    await groups.removeMember(c.get("deps").db, c.get("ctx"), c.req.param("id"), c.req.param("affiliateId"));
    return c.json({ ok: true });
  });
  return r;
}

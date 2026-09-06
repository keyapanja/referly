import { Hono } from "hono";
import { assets } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

export function assetRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });
  r.get("/", async (c) => c.json({ assets: await assets.listAssets(c.get("deps").db, c.get("ctx"), { includeArchived: c.req.query("archived") === "1" }), types: assets.ASSET_TYPES }));
  r.post("/", async (c) => c.json({ asset: await assets.createAsset(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201));
  r.get("/:id", async (c) => c.json({ asset: await assets.getAsset(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.patch("/:id", async (c) => c.json({ asset: await assets.updateAsset(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  r.put("/:id/permissions", async (c) => c.json({ permissions: await assets.setAssetPermissions(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  return r;
}

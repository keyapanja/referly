import { Hono } from "hono";
import { assets, validation } from "@referly/core";
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, assetKey, sniffMatches } from "../storage";
import { require as requirePerm } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

export function assetRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    requireMerchantPrincipal(c);
    await next();
  });
  r.get("/", async (c) => c.json({ assets: await assets.listAssets(c.get("deps").db, c.get("ctx"), { includeArchived: c.req.query("archived") === "1" }), types: assets.ASSET_TYPES, variables: assets.COPY_VARIABLES }));
  r.post("/", async (c) => c.json({ asset: await assets.createAsset(c.get("deps").db, c.get("ctx"), await c.req.json()) }, 201));
  /**
   * AST-01: multipart upload. Returns the stored file's public URL and metadata; the client
   * then creates the asset record with that URL. Type and size are checked server-side.
   */
  r.post("/upload", async (c) => {
    const ctx = c.get("ctx");
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw validation("send a multipart form with a 'file' field");
    requirePerm(ctx, "assets.write");
    const contentType = file.type.toLowerCase();
    if (!ALLOWED_UPLOAD_TYPES[contentType]) throw validation("unsupported file type " + (contentType || "(unknown)"), { allowed: Object.keys(ALLOWED_UPLOAD_TYPES) });
    if (file.size > MAX_UPLOAD_BYTES) throw validation("file is larger than " + MAX_UPLOAD_BYTES / 1024 / 1024 + " MB");
    const data = new Uint8Array(await file.arrayBuffer());
    // The declared type is what the browser will render it as; the bytes must agree.
    if (!sniffMatches(contentType, data)) throw validation(`file content does not look like ${contentType}`);
    const stored = await c.get("deps").storage.put(assetKey(ctx.tenantId, contentType, data), data, contentType);
    return c.json({ file: { ...stored, name: file.name } }, 201);
  });

  r.get("/:id", async (c) => c.json({ asset: await assets.getAsset(c.get("deps").db, c.get("ctx"), c.req.param("id")) }));
  r.patch("/:id", async (c) => c.json({ asset: await assets.updateAsset(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  r.put("/:id/permissions", async (c) => c.json({ permissions: await assets.setAssetPermissions(c.get("deps").db, c.get("ctx"), c.req.param("id"), await c.req.json()) }));
  return r;
}

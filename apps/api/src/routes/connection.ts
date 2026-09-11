import { Hono } from "hono";
import { can, forbidden, tenants } from "@referly/core";
import { requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/**
 * What an integration's key is connected to: the workspace, and the website tracking settings a
 * plugin needs to print the tracking code. Open to any key that can report conversions, so the
 * WordPress plugin never needs the broad read scope. The site key it returns is public anyway: it
 * sits in every page's HTML.
 */
export function connectionRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    requireMerchantPrincipal(c);
    const ctx = c.get("ctx");
    if (!can(ctx, "conversions.write")) throw forbidden("this key cannot report conversions");
    const { db, config } = c.get("deps");
    const tenant = await tenants.getTenant(db, ctx);
    const base = config.baseUrl.replace(/\/$/, "");
    return c.json({
      workspace: { id: tenant.id, name: tenant.name, currency: tenant.currency },
      tracking: {
        enabled: !!tenant.siteKey,
        siteKey: tenant.siteKey,
        scriptUrl: `${base}/referly.js`,
        apiUrl: base,
        consentMode: tenant.tracking?.consentMode ?? "off",
      },
    });
  });

  return r;
}

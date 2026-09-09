import { Hono, type Context } from "hono";
import { z } from "zod";
import { notifications, forbidden } from "@referly/core";
import { requireAffiliatePrincipal, requireMerchantPrincipal, type AppEnv } from "../lib/auth";

/**
 * Notification centre endpoints, mounted once for the merchant app (/v1/notifications, the
 * signed-in team member) and once for the portal (/portal/notifications, the signed-in
 * affiliate). API keys have no inbox.
 */
export function notificationRoutes(audience: "merchant" | "portal") {
  const r = new Hono<AppEnv>();
  const recipient = (c: Context<AppEnv>): notifications.Recipient => {
    if (audience === "portal") return { type: "affiliate", id: requireAffiliatePrincipal(c) };
    requireMerchantPrincipal(c);
    const p = c.get("principal");
    if (p.kind !== "user") throw forbidden("sign in to see notifications");
    return { type: "user", id: p.userId };
  };

  r.get("/", async (c) => {
    const unreadOnly = c.req.query("unread") === "1";
    const limit = Number(c.req.query("limit") ?? 50);
    const rec = recipient(c);
    const [items, unread] = await Promise.all([notifications.listNotifications(c.get("deps").db, c.get("ctx"), rec, { unreadOnly, limit }), notifications.unreadCount(c.get("deps").db, c.get("ctx"), rec)]);
    return c.json({ notifications: items, unread });
  });
  r.get("/unread-count", async (c) => c.json({ unread: await notifications.unreadCount(c.get("deps").db, c.get("ctx"), recipient(c)) }));
  r.post("/read", async (c) => {
    const body = z.object({ ids: z.array(z.string()).max(200).optional(), all: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const rec = recipient(c);
    const marked = await notifications.markRead(c.get("deps").db, c.get("ctx"), rec, body);
    return c.json({ marked, unread: await notifications.unreadCount(c.get("deps").db, c.get("ctx"), rec) });
  });
  r.get("/preferences", async (c) => c.json(await notifications.getPrefs(c.get("deps").db, c.get("ctx"), recipient(c))));
  r.patch("/preferences", async (c) => {
    const rec = recipient(c);
    await notifications.updatePrefs(c.get("deps").db, c.get("ctx"), rec, await c.req.json());
    return c.json(await notifications.getPrefs(c.get("deps").db, c.get("ctx"), rec));
  });
  return r;
}

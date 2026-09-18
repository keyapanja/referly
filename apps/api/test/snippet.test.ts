import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { SNIPPET_JS } from "../src/snippet";

/**
 * The website snippet, run as a browser would run it: the exact JavaScript the API serves,
 * evaluated in a sandbox with a fake window, document, cookies, storage and fetch. Proves the
 * rule merchants rely on: a visitor nobody sent is left alone (no cookie, no request), and a
 * visitor who arrived through an affiliate link is tracked.
 */
const SITE = "site_abcdefghijklmnopqrstuvwx";

function browser(url: string, opts: { cookie?: string; attrs?: Record<string, string>; shopify?: boolean; links?: { href: string }[] } = {}) {
  const requests: { url: string; body: any }[] = [];
  const timers: (() => void)[] = [];
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  let jar = opts.cookie ?? "";
  const u = new URL(url);
  const attrs: Record<string, string> = { "data-site": SITE, ...(opts.attrs ?? {}) };
  const script = { src: "https://api.test/referly.js", getAttribute: (n: string) => attrs[n] ?? null };
  const noop = () => {};
  const anchor = (href: string) => {
    const el: any = { tagName: "A", attrs: { href } as Record<string, string>, parentNode: null };
    el.getAttribute = (n: string) => el.attrs[n] ?? null;
    el.setAttribute = (n: string, v: string) => void (el.attrs[n] = v);
    return el;
  };
  const links = (opts.links ?? []).map((l) => anchor(l.href));
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const document = {
    currentScript: script,
    title: "Course",
    referrer: "",
    readyState: "complete",
    visibilityState: "visible",
    getElementsByTagName: () => [script],
    querySelectorAll: (selector: string) => (selector.indexOf("buy.stripe.com") !== -1 ? links : []),
    addEventListener: (name: string, fn: (e: any) => void) => void (listeners[name] = [...(listeners[name] ?? []), fn]),
    get cookie() {
      return jar;
    },
    set cookie(value: string) {
      const pair = value.split(";")[0]!;
      const name = pair.split("=")[0]!;
      const rest = jar ? jar.split("; ").filter((c) => !c.startsWith(`${name}=`)) : [];
      if (!/max-age=0(;|$)/.test(value)) rest.push(pair);
      jar = rest.join("; ");
    },
  };
  const storage = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) });
  const window: any = {
    Shopify: opts.shopify ? { shop: "acme.myshopify.com" } : undefined,
    document,
    location: { href: u.href, search: u.search, protocol: u.protocol },
    history: { pushState: noop, replaceState: noop },
    navigator: {},
    crypto: { getRandomValues: (a: Uint8Array) => a.map((_, i) => (i * 37 + 11) & 255) },
    addEventListener: noop,
    fetch: (to: string, init: { body: string; credentials?: string }) => {
      requests.push({ url: to, body: JSON.parse(init.body), credentials: init.credentials });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, ref: null }) });
    },
  };
  window.window = window;
  vm.runInNewContext(SNIPPET_JS, {
    window,
    document,
    location: window.location,
    history: window.history,
    navigator: window.navigator,
    fetch: window.fetch,
    localStorage: storage(local),
    sessionStorage: storage(session),
    setTimeout: (f: () => void) => timers.push(f),
  });
  return {
    referly: (...args: unknown[]) => window.referly(...args),
    requests,
    cookies: () => jar,
    local,
    links,
    /** Click something inside an element, as the browser would dispatch it to the document's capture listeners. */
    click: (target: any) => (listeners.click ?? []).forEach((fn) => fn({ target })),
    anchor,
    /** Run the batching timer, as the browser would a moment later. */
    flush: () => {
      while (timers.length) timers.shift()!();
    },
  };
}

describe("website snippet in a browser", () => {
  it("leaves a visitor nobody sent alone: no cookie, nothing stored, no request, and no order sent", async () => {
    const b = browser("https://shop.example.com/pricing");
    b.referly("track", "add_to_cart", { sku: "A" });
    b.flush();
    expect(b.requests).toEqual([]);
    expect(b.cookies()).toBe("");
    expect(b.local.size).toBe(0);
    expect(b.referly("visitor")).toBeNull();
    expect(await b.referly("convert", { orderId: "1001", amount: 49 })).toEqual({ ok: true, recorded: false, reason: "no_affiliate" });
    expect(b.requests).toEqual([]);
  });

  it("tracks a visitor who arrived through an affiliate link, and keeps the click for later pages", async () => {
    const b = browser("https://shop.example.com/course?ref=clickTOKEN1234");
    b.flush();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.url).toBe(`https://api.test/t/${SITE}/events`);
    expect(b.requests[0]!.body).toMatchObject({ ref: "clickTOKEN1234", events: [{ type: "page_view", url: "https://shop.example.com/course?ref=clickTOKEN1234" }] });
    expect(b.cookies()).toContain("referly_ref=clickTOKEN1234");
    expect(b.cookies()).toMatch(/referly_vid=v[A-Za-z0-9]{20}/);
    expect(b.referly("visitor")).toMatch(/^v[A-Za-z0-9]{20}$/);

    // the next page has no ref in its address, but the cookie carries the click
    const next = browser("https://shop.example.com/checkout", { cookie: b.cookies() });
    next.flush();
    expect(next.requests[0]!.body.ref).toBe("clickTOKEN1234");
    await next.referly("convert", { orderId: "1002", amount: 129, currency: "USD" });
    expect(next.requests.at(-1)!).toMatchObject({ url: `https://api.test/t/${SITE}/convert`, body: { orderId: "1002", ref: "clickTOKEN1234" } });
  });

  it("still sends an order with a coupon code from a visitor without a click, since the code may be an affiliate's", async () => {
    const b = browser("https://shop.example.com/thanks");
    await b.referly("convert", { orderId: "1003", amount: 20, couponCode: "SAM20" });
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.body).toMatchObject({ orderId: "1003", couponCode: "SAM20" });
    expect(b.requests[0]!.body.visitorId).toBeUndefined();
    expect(b.cookies()).toBe("");
  });

  it("on a Shopify storefront, puts the click token and visitor id on the cart once, so the order webhook carries them", async () => {
    const b = browser("https://acme.myshopify.com/products/course?ref=clickTOKEN1234", { shopify: true });
    b.flush();
    const cart = b.requests.find((r) => r.url === "/cart/update.js");
    expect(cart).toBeDefined();
    expect(cart!.credentials).toBe("same-origin");
    expect(cart!.body).toEqual({ attributes: { referly_ref: "clickTOKEN1234", referly_vid: b.referly("visitor") } });
    // events still go to the API as before
    expect(b.requests.find((r) => r.url.endsWith("/events"))!.body.ref).toBe("clickTOKEN1234");
    // the next page in the same session does not repeat the cart call
    await Promise.resolve();
    expect(b.requests.filter((r) => r.url === "/cart/update.js")).toHaveLength(1);

    const nobody = browser("https://acme.myshopify.com/products/course", { shopify: true });
    nobody.flush();
    expect(nobody.requests).toEqual([]);
  });

  it("appends the click token to Stripe Payment Links as client_reference_id, on the page and on links rendered later", () => {
    const links = [{ href: "https://buy.stripe.com/abc123" }, { href: "https://buy.stripe.com/def456?locale=en" }, { href: "https://buy.stripe.com/ghi?client_reference_id=mine" }, { href: "https://example.com/pricing" }];
    const b = browser("https://example.com/pricing?ref=clickTOKEN1234", { links });
    expect(b.links.map((l: any) => l.getAttribute("href"))).toEqual([
      "https://buy.stripe.com/abc123?client_reference_id=clickTOKEN1234",
      "https://buy.stripe.com/def456?locale=en&client_reference_id=clickTOKEN1234",
      "https://buy.stripe.com/ghi?client_reference_id=mine",
      "https://example.com/pricing",
    ]);
    const late = b.anchor("https://buy.stripe.com/late999");
    const inner = { tagName: "SPAN", parentNode: late };
    b.click(inner);
    expect(late.getAttribute("href")).toBe("https://buy.stripe.com/late999?client_reference_id=clickTOKEN1234");

    const nobody = browser("https://example.com/pricing", { links: [{ href: "https://buy.stripe.com/abc123" }] });
    expect(nobody.links[0].getAttribute("href")).toBe("https://buy.stripe.com/abc123");
  });

  it("in consent mode, waits for the banner before storing or sending anything, even for an affiliate's visitor", () => {
    const b = browser("https://shop.example.com/course?ref=clickTOKEN1234", { attrs: { "data-consent": "wait" } });
    b.flush();
    expect(b.requests).toEqual([]);
    expect(b.cookies()).toBe("");
    b.referly("consent", "granted");
    b.flush();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.body).toMatchObject({ consent: "granted", ref: "clickTOKEN1234" });
    expect(b.cookies()).toContain("referly_ref=clickTOKEN1234");
    expect(b.cookies()).toContain("referly_consent=granted");
  });
});

import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { SNIPPET_JS, installSnippet, snippetAttributes } from "../src/snippet";

/**
 * The website snippet, run as a browser would run it: the exact JavaScript the API serves,
 * evaluated in a sandbox with a fake window, document, cookies, storage, scrolling and fetch.
 * Proves the rules merchants rely on: a visitor nobody sent is left alone (no cookie, no request),
 * a visitor who arrived through an affiliate link is counted once a day per stage, per site and
 * per page, with the memory of that kept in their own browser, and nothing sent identifies what
 * any one person did beyond the stage itself.
 */
const SITE = "site_abcdefghijklmnopqrstuvwx";

interface BrowserOptions {
  cookie?: string;
  attrs?: Record<string, string>;
  shopify?: boolean;
  links?: { href: string }[];
  /** localStorage carried over from an earlier page of the same browser. */
  storage?: Map<string, string>;
  /** Page height in pixels; the viewport is 800 tall. */
  height?: number;
  readyState?: "loading" | "complete";
}

function browser(url: string, opts: BrowserOptions = {}) {
  const requests: { url: string; body: any; credentials?: string }[] = [];
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const local = opts.storage ?? new Map<string, string>();
  const session = new Map<string, string>();
  let jar = opts.cookie ?? "";
  const u = new URL(url);
  const attrs: Record<string, string> = { "data-site": SITE, ...(opts.attrs ?? {}) };
  const script = { src: "https://api.test/referly.js", getAttribute: (n: string) => attrs[n] ?? null };
  const anchor = (href: string) => {
    const el: any = { tagName: "A", attrs: { href } as Record<string, string>, parentNode: null };
    el.getAttribute = (n: string) => el.attrs[n] ?? null;
    el.setAttribute = (n: string, v: string) => void (el.attrs[n] = v);
    return el;
  };
  const links = (opts.links ?? []).map((l) => anchor(l.href));
  const docListeners: Record<string, ((e: any) => void)[]> = {};
  const winListeners: Record<string, ((e: any) => void)[]> = {};
  const page = { height: opts.height ?? 3000, top: 0 };
  const documentElement = { get scrollHeight() { return page.height; }, clientHeight: 800, get scrollTop() { return page.top; } };
  const document = {
    currentScript: script,
    title: "Course",
    referrer: "",
    readyState: opts.readyState ?? "complete",
    visibilityState: "visible",
    documentElement,
    body: { get scrollHeight() { return page.height; }, get scrollTop() { return page.top; } },
    getElementsByTagName: () => [script],
    querySelectorAll: (selector: string) => (selector.indexOf("buy.stripe.com") !== -1 ? links : []),
    addEventListener: (name: string, fn: (e: any) => void) => void (docListeners[name] = [...(docListeners[name] ?? []), fn]),
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
  const location = { href: u.href, search: u.search, protocol: u.protocol, host: u.host, pathname: u.pathname };
  const history: any = { pushState: () => {}, replaceState: () => {} };
  const window: any = {
    Shopify: opts.shopify ? { shop: "acme.myshopify.com" } : undefined,
    document,
    location,
    history,
    navigator: {},
    innerHeight: 800,
    get pageYOffset() {
      return page.top;
    },
    crypto: { getRandomValues: (a: Uint8Array) => a.map((_, i) => (i * 37 + 11) & 255) },
    addEventListener: (name: string, fn: (e: any) => void) => void (winListeners[name] = [...(winListeners[name] ?? []), fn]),
    fetch: (to: string, init: { body: string; credentials?: string }) => {
      requests.push({ url: to, body: JSON.parse(init.body), credentials: init.credentials });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, ref: null }) });
    },
  };
  window.window = window;
  vm.runInNewContext(SNIPPET_JS, {
    window,
    document,
    location,
    history,
    navigator: window.navigator,
    fetch: window.fetch,
    localStorage: storage(local),
    sessionStorage: storage(session),
    setTimeout: (fn: () => void) => {
      timers.set(nextTimer, fn);
      return nextTimer++;
    },
    clearTimeout: (id: number) => void timers.delete(id),
  });
  /** Run every pending timer, and the ones those start, as the browser would once their delays pass. */
  const flush = () => {
    for (let guard = 0; guard < 20 && timers.size; guard++) {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    }
  };
  return {
    referly: (...args: unknown[]) => window.referly(...args),
    requests,
    /** Every hit sent so far, in order, as "stage[:name] page|site" for reading at a glance. */
    hits: () => requests.filter((r) => r.url.endsWith("/events")).flatMap((r) => r.body.hits as any[]),
    cookies: () => jar,
    local,
    links,
    flush,
    /** Scroll so the bottom of the viewport is at this fraction of the page, and let the throttle fire. */
    scrollTo: (fraction: number) => {
      page.top = Math.max(0, fraction * page.height - 800);
      for (const fn of winListeners.scroll ?? []) fn({});
      flush();
    },
    /** A single-page app moves to another address. */
    navigate: (to: string) => {
      const next = new URL(to);
      Object.assign(location, { href: next.href, search: next.search, host: next.host, pathname: next.pathname });
      page.top = 0;
      history.pushState({}, "", to);
      flush();
    },
    click: (target: any) => (docListeners.click ?? []).forEach((fn) => fn({ target })),
    anchor,
  };
}

const brief = (h: any) => `${h.s}${h.n ? `:${h.n}` : ""}${h.site ? " site" : ""}${h.page ? " page" : ""}`;

describe("website snippet in a browser", () => {
  it("leaves a visitor nobody sent alone: no cookie, nothing stored, no request, and no order sent", async () => {
    const b = browser("https://shop.example.com/pricing");
    b.referly("track", "add_to_cart");
    b.scrollTo(1);
    b.flush();
    expect(b.requests).toEqual([]);
    expect(b.cookies()).toBe("");
    expect(b.local.size).toBe(0);
    expect(b.referly("visitor")).toBeNull();
    expect(await b.referly("convert", { orderId: "1001", amount: 49 })).toEqual({ ok: true, recorded: false, reason: "no_affiliate" });
    expect(b.requests).toEqual([]);
  });

  it("counts a visitor who arrived through an affiliate link once: the arrival, and nothing that says who they are beyond the stage", async () => {
    const b = browser("https://shop.example.com/course?ref=clickTOKEN1234&email=buyer%40example.com");
    b.flush();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.url).toBe(`https://api.test/t/${SITE}/events`);
    expect(b.requests[0]!.body).toMatchObject({ v: 5, ref: "clickTOKEN1234", consent: "not_required" });
    expect(b.hits().map(brief)).toEqual(["visit site page"]);
    // the address is sent without its query string: that is where emails, order keys and click tokens ride
    expect(b.hits()[0].url).toBe("https://shop.example.com/course");
    expect(JSON.stringify(b.requests[0]!.body)).not.toContain("buyer");
    expect(b.requests[0]!.body.sessionId).toBeUndefined();
    expect(b.cookies()).toContain("referly_ref=clickTOKEN1234");
    expect(b.cookies()).toMatch(/referly_vid=v[A-Za-z0-9]{20}/);
    expect(b.referly("visitor")).toMatch(/^v[A-Za-z0-9]{20}$/);

    // the next page has no ref in its address, but the cookie carries the click
    const next = browser("https://shop.example.com/thanks", { cookie: b.cookies(), storage: b.local });
    next.flush();
    expect(next.requests[0]!.body.ref).toBe("clickTOKEN1234");
    await next.referly("convert", { orderId: "1002", amount: 129, currency: "USD" });
    const order = next.requests.at(-1)!;
    expect(order).toMatchObject({ url: `https://api.test/t/${SITE}/convert`, body: { orderId: "1002", ref: "clickTOKEN1234", url: "https://shop.example.com/thanks" } });
    expect(order.body.sessionId).toBeUndefined();
  });

  it("reports reading depth as the visitor scrolls: half the page, then the bottom, each once", () => {
    const b = browser("https://shop.example.com/course?ref=clickTOKEN1234", { height: 4000 });
    b.flush();
    b.scrollTo(0.3);
    expect(b.hits().map(brief)).toEqual(["visit site page"]);
    b.scrollTo(0.55);
    expect(b.hits().map(brief)).toEqual(["visit site page", "half site page"]);
    b.scrollTo(0.7);
    b.scrollTo(0.95);
    b.scrollTo(0.4);
    b.scrollTo(1);
    expect(b.hits().map(brief)).toEqual(["visit site page", "half site page", "bottom site page"]);
  });

  it("a page too short to scroll counts as read once it has been open for a moment, and only after it has loaded", () => {
    const loading = browser("https://shop.example.com/thanks?ref=clickTOKEN1234", { height: 600, readyState: "loading" });
    loading.flush();
    // the script ran before the page was there: a tiny document is not a page that was read
    expect(loading.hits().map(brief)).toEqual(["visit site page"]);
    const b = browser("https://shop.example.com/thanks?ref=clickTOKEN1234", { height: 600 });
    b.flush();
    expect(b.hits().map(brief)).toEqual(["visit site page", "half site page", "bottom site page"]);
  });

  it("remembers in the visitor's own browser what it already reported today: a second page adds only what is new, and a reload adds nothing", () => {
    const first = browser("https://shop.example.com/course?ref=clickTOKEN1234", { height: 4000 });
    first.flush();
    first.scrollTo(0.6);
    const memory = JSON.parse(first.local.get("referly_day")!);
    expect(memory).toMatchObject({ s: "vh", p: { "shop.example.com/course": "vh" }, e: [] });

    const second = browser("https://shop.example.com/pricing", { cookie: first.cookies(), storage: first.local, height: 4000 });
    second.flush();
    second.scrollTo(1);
    // new on this page; on the site only the bottom is new
    expect(second.hits().map(brief)).toEqual(["visit page", "half page", "bottom site page"]);

    const reload = browser("https://shop.example.com/pricing", { cookie: first.cookies(), storage: first.local, height: 4000 });
    reload.flush();
    reload.scrollTo(1);
    expect(reload.requests).toEqual([]);

    // tomorrow everything counts again
    const stale = new Map(first.local);
    stale.set("referly_day", JSON.stringify({ ...JSON.parse(first.local.get("referly_day")!), d: "2001-1-1" }));
    const tomorrow = browser("https://shop.example.com/pricing", { cookie: first.cookies(), storage: stale, height: 4000 });
    tomorrow.flush();
    expect(tomorrow.hits().map(brief)).toEqual(["visit site page"]);
  });

  it("recognises the checkout by its address, by what the merchant listed, and by the WordPress plugin's word, never the thank-you page", () => {
    const stages = (url: string, attrs: Record<string, string> = {}) => {
      const b = browser(url, { attrs, height: 4000 });
      b.flush();
      return b.hits().map(brief);
    };
    expect(stages("https://shop.example.com/checkout/?ref=clickTOKEN1234")).toEqual(["visit site page", "checkout site page"]);
    expect(stages("https://shop.example.com/checkouts/standing-desk/?ref=clickTOKEN1234")).toEqual(["visit site page", "checkout site page"]);
    expect(stages("https://shop.example.com/checkout/order-received/1042/?key=wc_order_x&ref=clickTOKEN1234")).toEqual(["visit site page"]);
    expect(stages("https://shop.example.com/blog/checkout-page-tips?ref=clickTOKEN1234")).toEqual(["visit site page"]);
    // a checkout at an address of the merchant's own
    expect(stages("https://shop.example.com/enroll-now?ref=clickTOKEN1234")).toEqual(["visit site page"]);
    expect(stages("https://shop.example.com/enroll-now?ref=clickTOKEN1234", { "data-checkout": "/buy, /enroll" })).toEqual(["visit site page", "checkout site page"]);
    // the WordPress plugin knows: a FunnelKit checkout at any address is one, and a page it says is not one is not
    expect(stages("https://shop.example.com/get-the-course/?ref=clickTOKEN1234", { "data-page": "checkout" })).toEqual(["visit site page", "checkout site page"]);
    expect(stages("https://shop.example.com/checkout/?ref=clickTOKEN1234", { "data-page": "page" })).toEqual(["visit site page"]);
  });

  it("counts the site's own events by name once a day, takes 'checkout' as reaching the checkout, and follows a single-page app", () => {
    const b = browser("https://app.example.com/?ref=clickTOKEN1234", { height: 4000 });
    b.referly("track", "add_to_cart", { sku: "A", email: "buyer@example.com" });
    b.referly("track", "add_to_cart");
    b.referly("track", "checkout");
    b.flush();
    expect(b.hits().map(brief)).toEqual(["visit site page", "event:add_to_cart site", "checkout site page"]);
    // properties are not sent at all
    expect(JSON.stringify(b.requests)).not.toContain("buyer@example.com");
    b.navigate("https://app.example.com/plans");
    expect(b.hits().map(brief).slice(3)).toEqual(["visit page"]);
    b.navigate("https://app.example.com/checkout");
    expect(b.hits().map(brief).slice(4)).toEqual(["visit page", "checkout page"]);
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
    expect(b.requests.find((r) => r.url.endsWith("/events"))!.body.ref).toBe("clickTOKEN1234");
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
    b.click({ tagName: "SPAN", parentNode: late });
    expect(late.getAttribute("href")).toBe("https://buy.stripe.com/late999?client_reference_id=clickTOKEN1234");

    const nobody = browser("https://example.com/pricing", { links: [{ href: "https://buy.stripe.com/abc123" }] });
    expect(nobody.links[0].getAttribute("href")).toBe("https://buy.stripe.com/abc123");
  });

  it("in consent mode, waits for the banner before storing or sending anything, even for an affiliate's visitor; a refusal forgets everything", () => {
    const b = browser("https://shop.example.com/course?ref=clickTOKEN1234", { attrs: { "data-consent": "wait" }, height: 4000 });
    b.flush();
    b.scrollTo(0.6);
    expect(b.requests).toEqual([]);
    expect(b.cookies()).toBe("");
    expect(b.local.size).toBe(0);
    b.referly("consent", "granted");
    b.flush();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.body).toMatchObject({ consent: "granted", ref: "clickTOKEN1234" });
    // what happened while the banner was open is sent once, not lost and not doubled
    expect(b.hits().map(brief)).toEqual(["visit site page", "half site page"]);
    expect(b.cookies()).toContain("referly_ref=clickTOKEN1234");
    expect(b.cookies()).toContain("referly_consent=granted");
    expect(JSON.parse(b.local.get("referly_day")!).s).toBe("vh");

    const no = browser("https://shop.example.com/course?ref=clickTOKEN1234", { attrs: { "data-consent": "wait" }, height: 4000 });
    no.flush();
    no.referly("consent", "denied");
    no.scrollTo(1);
    no.flush();
    expect(no.requests).toEqual([]);
    expect(no.local.has("referly_day")).toBe(false);
    expect(no.cookies()).toBe("referly_consent=denied");
  });
});

describe("install code", () => {
  it("carries the consent attribute and the checkout addresses the workspace set, and nothing unsafe", () => {
    expect(installSnippet("https://api.test/", SITE)).toBe(`<script>window.referly=window.referly||function(){(window.referly.q=window.referly.q||[]).push(arguments)};</script>\n<script async src="https://api.test/referly.js" data-site="${SITE}"></script>`);
    expect(snippetAttributes({ consentMode: "wait", checkoutPaths: ["/buy", "/enroll"] })).toBe(' data-consent="wait" data-checkout="/buy,/enroll"');
    expect(snippetAttributes({ checkoutPaths: ['/x" onload="alert(1)', "/ok"] })).toBe(' data-checkout="/ok"');
    expect(snippetAttributes({ consentMode: "off", checkoutPaths: [] })).toBe("");
  });
});

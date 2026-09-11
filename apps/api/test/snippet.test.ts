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

function browser(url: string, opts: { cookie?: string; attrs?: Record<string, string> } = {}) {
  const requests: { url: string; body: any }[] = [];
  const timers: (() => void)[] = [];
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  let jar = opts.cookie ?? "";
  const u = new URL(url);
  const attrs: Record<string, string> = { "data-site": SITE, ...(opts.attrs ?? {}) };
  const script = { src: "https://api.test/referly.js", getAttribute: (n: string) => attrs[n] ?? null };
  const noop = () => {};
  const document = {
    currentScript: script,
    title: "Course",
    referrer: "",
    readyState: "complete",
    visibilityState: "visible",
    getElementsByTagName: () => [script],
    querySelectorAll: () => [],
    addEventListener: noop,
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
    document,
    location: { href: u.href, search: u.search, protocol: u.protocol },
    history: { pushState: noop, replaceState: noop },
    navigator: {},
    crypto: { getRandomValues: (a: Uint8Array) => a.map((_, i) => (i * 37 + 11) & 255) },
    addEventListener: noop,
    fetch: (to: string, init: { body: string }) => {
      requests.push({ url: to, body: JSON.parse(init.body) });
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

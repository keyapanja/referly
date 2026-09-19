/**
 * The website snippet (TRK-09). Served as-is from GET /referly.js so merchants paste one script
 * tag and what affiliate visitors do on their own site is counted automatically:
 *
 *  - keeps the click token the tracking redirect appended as `?ref=` in a first-party cookie
 *    (and localStorage) for the program's attribution window, so it survives navigation;
 *  - gives the visitor a first-party id (one year), used only so an order can find its click;
 *  - reports the stages a visitor reaches: arrived, read half a page, read a page to the bottom,
 *    reached the checkout, plus any custom events the site calls `referly('track', name)` for.
 *    Each stage is reported once per visitor per day, for the site and for the page: the memory
 *    of what was already reported lives in the visitor's own browser (`referly_day` in
 *    localStorage), so the server keeps counters and nothing about any one visitor;
 *  - recognises a checkout page by `data-page="checkout"` on the script tag (the WordPress
 *    plugin sets it), by the address fragments in `data-checkout`, or by a "checkout" segment in
 *    the address; `referly('track', 'checkout')` does it by hand;
 *  - fills hidden `ref` / `referly_visitor` inputs so lead forms carry the attribution;
 *  - can report an order from the thank-you page with `referly('convert', {...})` when the
 *    workspace has turned that on;
 *  - on a Shopify storefront, puts the click token and visitor id on the cart as attributes, so
 *    the order Shopify sends through its webhook carries them; on any page, appends the click
 *    token to Stripe Payment Links as `client_reference_id`, so Stripe's webhook carries it;
 *  - stays silent for visitors who did not arrive through an affiliate link: no cookie is
 *    written and nothing is sent, because Referly only tracks affiliate traffic;
 *  - with `data-consent="wait"` (EU sites) writes nothing and sends nothing until the page
 *    reports consent: `referly('consent', 'granted' | 'denied')`, a `referly:consent` DOM
 *    event, or Cookiebot / OneTrust callbacks, which are recognised automatically. Stages reached
 *    while the banner is open are held in memory and sent on grant; on denial they are dropped
 *    and anything stored is removed. The decision itself is remembered for 180 days.
 *
 * Plain ES5, no dependencies, ~5 KB. Sends as text/plain so no CORS preflight is needed and
 * sendBeacon can deliver the last batch when the page closes. Never blocks the page: every
 * failure is swallowed.
 */
export const SNIPPET_VERSION = "5";

export const SNIPPET_JS = String.raw`/*! Referly site snippet v${SNIPPET_VERSION}. Counts what affiliate visitors do on this site; keeps nothing per visitor. */
(function (w, d) {
  if (!w || !d || w.__referlyLoaded) return;
  w.__referlyLoaded = true;
  var script = d.currentScript;
  if (!script) {
    var all = d.getElementsByTagName("script");
    for (var i = all.length - 1; i >= 0; i--) if (/referly\.js/.test(all[i].src || "")) { script = all[i]; break; }
  }
  function attr(name) { return (script && script.getAttribute(name)) || ""; }
  var site = attr("data-site");
  var api = attr("data-api") || (script && script.src ? script.src.replace(/\/referly\.js.*$/, "") : "");
  var auto = attr("data-auto") !== "false";
  var consentMode = attr("data-consent") === "wait";
  var pageKind = attr("data-page"), checkoutParts = attr("data-checkout").toLowerCase().split(",");
  var REF = "referly_ref", VID = "referly_vid", CONSENT = "referly_consent", DAYKEY = "referly_day", DAY = 86400;

  function cookie(name) {
    var m = d.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, value, maxAge) {
    var s = name + "=" + encodeURIComponent(value) + "; path=/; max-age=" + maxAge + "; samesite=lax";
    if (location.protocol === "https:") s += "; secure";
    d.cookie = s;
  }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function forget(key) { setCookie(key, "", 0); try { localStorage.removeItem(key); } catch (e) {} }
  function rand(n) {
    var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", out = "", buf = null;
    try { buf = new Uint8Array(n); (w.crypto || w.msCrypto).getRandomValues(buf); } catch (e) {}
    for (var i = 0; i < n; i++) out += chars[(buf ? buf[i] : Math.floor(Math.random() * 256)) % chars.length];
    return out;
  }
  function param(name) {
    var m = location.search.match(new RegExp("[?&]" + name + "=([^&#]*)"));
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
  }

  // Consent: "not_required" outside consent mode; otherwise the remembered decision or "pending".
  var consent = consentMode ? (cookie(CONSENT) || load(CONSENT) || "pending") : "not_required";
  function allowed() { return !consentMode || consent === "granted"; }
  function persist(key, value, maxAge) { if (allowed()) { setCookie(key, value, maxAge); store(key, value); } }

  // Click token: from the landing URL (the tracking redirect adds it) or from an earlier visit.
  var ref = param("ref");
  if (ref && /^[A-Za-z0-9_-]{6,64}$/.test(ref)) persist(REF, ref, 90 * DAY);
  else ref = cookie(REF) || load(REF);
  // Only visitors who arrived through an affiliate link are tracked. Everyone else is left alone:
  // no cookie is written and nothing is sent.
  var active = !!ref;
  // Visitor id: first party, one year. It lets an order find its click; nothing is recorded against it.
  var vid = cookie(VID) || load(VID);
  if (!vid || !/^[A-Za-z0-9_-]{8,64}$/.test(vid)) vid = "v" + rand(20);
  if (active) persist(VID, vid, 365 * DAY);

  // Shopify: the click token and visitor id go on the cart as attributes, so the order Shopify
  // sends to Referly carries them whatever page the customer paid from.
  function shopifyCart() {
    if (!active || !allowed() || !w.Shopify || !w.fetch) return;
    try { if (sessionStorage.getItem("referly_cart") === ref) return; } catch (e) {}
    fetch("/cart/update.js", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ attributes: { referly_ref: ref, referly_vid: vid } }) })
      .then(function (r) { if (r && r.ok) try { sessionStorage.setItem("referly_cart", ref); } catch (e) {} })
      .catch(function () {});
  }
  shopifyCart();
  // Stripe Payment Links: an affiliate visitor's link carries the click token as client_reference_id.
  function stripeLink(a) {
    if (!active || !allowed() || !a || !a.getAttribute) return;
    var href = a.getAttribute("href") || "";
    if (!/buy\.stripe\.com\//.test(href) || href.indexOf("client_reference_id=") !== -1) return;
    a.setAttribute("href", href + (href.indexOf("?") === -1 ? "?" : "&") + "client_reference_id=" + encodeURIComponent(ref));
  }

  // What this visitor has already been counted for today lives here, in their own browser:
  // s = stages reached on the site, p = stages reached per page, e = the site's own events.
  var LETTER = { visit: "v", half: "h", bottom: "b", checkout: "c" }, mem = null;
  function today() { var t = new Date(); return t.getFullYear() + "-" + (t.getMonth() + 1) + "-" + t.getDate(); }
  function memory() {
    var t = today(), raw = null;
    try { raw = JSON.parse(load(DAYKEY) || "null"); } catch (e) {}
    if (raw && raw.d === t && typeof raw.s === "string") mem = { d: t, s: raw.s, e: raw.e || [], p: raw.p || {} };
    else if (!mem || mem.d !== t) mem = { d: t, s: "", e: [], p: {} };
    return mem;
  }
  function remember() {
    var keys = [];
    for (var k in mem.p) if (Object.prototype.hasOwnProperty.call(mem.p, k)) keys.push(k);
    while (keys.length > 40) delete mem.p[keys.shift()];
    if (mem.e.length > 30) mem.e = mem.e.slice(-30);
    if (allowed()) store(DAYKEY, JSON.stringify(mem));
  }
  // The address without its query string: that is where click tokens, order keys and emails ride.
  function here() { return location.protocol + "//" + location.host + location.pathname; }

  var queue = [], timer = null;
  function send(useBeacon) {
    if (!site || !api || !queue.length || !active || !allowed()) return;
    var body = JSON.stringify({ v: 5, visitorId: vid, ref: ref || undefined, consent: consentMode ? "granted" : "not_required", hits: queue.splice(0, 50) });
    var url = api + "/t/" + site + "/events";
    var sent = false;
    if (useBeacon && navigator.sendBeacon) { try { sent = navigator.sendBeacon(url, body); } catch (e) {} }
    if (!sent && w.fetch) {
      fetch(url, { method: "POST", body: body, headers: { "content-type": "text/plain" }, keepalive: true, credentials: "omit", mode: "cors" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (res) { if (res && res.ref && res.ref.ttlSeconds && ref) persist(REF, ref, res.ref.ttlSeconds); })
        .catch(function () {});
    }
    if (queue.length) send(useBeacon);
  }
  function flushSoon() { if (timer) return; timer = setTimeout(function () { timer = null; send(false); }, 250); }
  // A stage is reported the first time today this visitor reaches it on the site, and on this page.
  function reach(stage, name) {
    if (!active || (consentMode && consent === "denied")) return;
    var m = memory(), onSite = false, onPage = false;
    if (stage === "event") {
      name = String(name || "").slice(0, 40);
      if (!name || m.e.indexOf(name) !== -1) return;
      m.e.push(name); onSite = true;
    } else {
      var letter = LETTER[stage], key = location.host + location.pathname, seen = m.p[key] || "";
      if (!letter) return;
      if (m.s.indexOf(letter) === -1) { m.s += letter; onSite = true; }
      if (seen.indexOf(letter) === -1) { m.p[key] = seen + letter; onPage = true; }
      if (!onSite && !onPage) return;
    }
    remember();
    // While the banner is open, hits wait in memory (bounded) and go out on grant.
    if (queue.length >= 50) queue.shift();
    queue.push({ s: stage, n: stage === "event" ? name : undefined, url: here(), page: onPage, site: onSite });
    flushSoon();
  }
  var firstUrl = location.href;
  function isCheckout() {
    var p = location.pathname.toLowerCase();
    for (var i = 0; i < checkoutParts.length; i++) { var part = checkoutParts[i].replace(/^\s+|\s+$/g, ""); if (part && p.indexOf(part) !== -1) return true; }
    // The WordPress plugin knows which page is the checkout; its word is final for the page it printed.
    if (pageKind && location.href === firstUrl) return pageKind === "checkout";
    if (/order-received|thank|success|complete|confirm|receipt/.test(p)) return false;
    return /(^|\/)checkouts?(\/|$)/.test(p);
  }
  function view() { reach("visit"); if (isCheckout()) reach("checkout"); }
  function track(name) {
    if (name === "checkout" || name === "begin_checkout") reach("checkout");
    else reach("event", name);
  }
  // How far down the page the visitor has got, 0 to 1. A page that fits the screen is read in full.
  function depth() {
    var el = d.documentElement, b = d.body;
    var h = Math.max(el ? el.scrollHeight : 0, b ? b.scrollHeight : 0), vh = w.innerHeight || (el && el.clientHeight) || 0;
    if (!h || !vh) return 0;
    if (h <= vh + 8) return 1;
    return ((w.pageYOffset || (el && el.scrollTop) || (b && b.scrollTop) || 0) + vh) / h;
  }
  function measure() { var f = depth(); if (f >= 0.5) reach("half"); if (f >= 0.9) reach("bottom"); }
  // A page too short to scroll counts as read once it has been open, fully loaded, for two seconds.
  var still = null;
  function settle() {
    if (still) clearTimeout(still);
    still = setTimeout(function () { still = null; if (d.readyState === "complete" && d.visibilityState !== "hidden") measure(); }, 2000);
  }
  function convert(order) {
    if (!site || !api || !order || !w.fetch) return Promise.reject(new Error("referly: convert needs an order and a configured snippet"));
    // An order from someone no affiliate sent is not Referly's to record, unless it carries a coupon code that may be an affiliate's.
    if (!active && !order.couponCode) return Promise.resolve({ ok: true, recorded: false, reason: "no_affiliate" });
    // An order is contract data and always goes; the visitor id only travels with consent.
    var body = JSON.stringify({ visitorId: active && allowed() ? vid : undefined, ref: ref || undefined, consent: consentMode ? consent : "not_required", orderId: order.orderId || order.id, amount: order.amount, amountMinor: order.amountMinor, currency: order.currency, email: order.email, couponCode: order.couponCode, offerId: order.offerId, url: here() });
    return fetch(api + "/t/" + site + "/convert", { method: "POST", body: body, headers: { "content-type": "text/plain" }, keepalive: true, credentials: "omit", mode: "cors" }).then(function (r) { return r.json(); });
  }
  function fill(root) {
    var inputs = (root && root.querySelectorAll ? root : d).querySelectorAll('input[name="ref"], input[name="referly_ref"], input[data-referly="ref"], input[name="referly_visitor"], input[data-referly="visitor"]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.name === "referly_visitor" || el.getAttribute("data-referly") === "visitor") el.value = active && allowed() ? vid : "";
      else if (ref && !el.value) el.value = ref;
    }
    var links = (root && root.querySelectorAll ? root : d).querySelectorAll('a[href*="buy.stripe.com/"]');
    for (var k = 0; k < links.length; k++) stripeLink(links[k]);
  }
  function setConsent(state) {
    if (!consentMode || (state !== "granted" && state !== "denied")) return;
    consent = state;
    // The decision itself is remembered so the next page does not wait again.
    setCookie(CONSENT, state, 180 * DAY); store(CONSENT, state);
    if (state === "granted") {
      if (active) { persist(REF, ref, 90 * DAY); persist(VID, vid, 365 * DAY); }
      if (mem) remember();
      shopifyCart(); fill(); send(false);
    } else {
      queue.length = 0; mem = null;
      forget(REF); forget(VID); forget(DAYKEY);
      fill();
    }
  }

  var stub = w.referly, pending = (stub && stub.q) || [];
  function referly(cmd) {
    var a = arguments;
    switch (cmd) {
      case "track": track(a[1]); break;
      case "page": view(); settle(); break;
      case "convert": return convert(a[1]);
      case "consent": if (a[1]) setConsent(a[1]); return consent;
      case "ref": return ref;
      case "visitor": return active && allowed() ? vid : null;
      case "fill": fill(a[1]); break;
      case "flush": send(false); break;
    }
  }
  referly.version = "${SNIPPET_VERSION}";
  w.referly = referly;
  // The landing page goes first, then whatever the page queued before the script loaded.
  if (auto) view();
  for (var p = 0; p < pending.length; p++) { try { referly.apply(null, pending[p]); } catch (e) {} }

  if (consentMode) {
    // Your own banner: document.dispatchEvent(new CustomEvent("referly:consent", { detail: "granted" }))
    d.addEventListener("referly:consent", function (e) { setConsent(e && e.detail); });
    // Cookiebot: statistics or marketing consent counts; both events fire on every page once decided.
    w.addEventListener("CookiebotOnAccept", function () { var c = w.Cookiebot && w.Cookiebot.consent; setConsent(c && (c.statistics || c.marketing) ? "granted" : "denied"); });
    w.addEventListener("CookiebotOnDecline", function () { setConsent("denied"); });
    // OneTrust: performance (C0002) or targeting (C0004) groups count.
    w.addEventListener("OneTrustGroupsUpdated", function () { setConsent(/C0002|C0004/.test(String(w.OnetrustActiveGroups || "")) ? "granted" : "denied"); });
  }
  if (auto) {
    var last = location.href;
    function changed() {
      if (location.href === last) return;
      last = location.href;
      // A single-page app can reach an affiliate link after the first load; tracking starts from there.
      var r = param("ref");
      if (!active && r && /^[A-Za-z0-9_-]{6,64}$/.test(r)) { ref = r; active = true; persist(REF, ref, 90 * DAY); persist(VID, vid, 365 * DAY); shopifyCart(); }
      view();
      settle();
      fill();
    }
    var methods = ["pushState", "replaceState"];
    for (var m = 0; m < methods.length; m++) (function (name) {
      var orig = history[name];
      if (!orig) return;
      history[name] = function () { var r = orig.apply(this, arguments); setTimeout(changed, 0); return r; };
    })(methods[m]);
    w.addEventListener("popstate", changed);
    if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", function () { fill(); }); else fill();
    d.addEventListener("submit", function (e) { if (e.target && e.target.querySelectorAll) fill(e.target); }, true);
    // Links rendered after load (a cart drawer, a React page) are fixed up as they are clicked.
    d.addEventListener("click", function (e) { var t = e.target; while (t && t.tagName !== "A") t = t.parentNode; if (t) stripeLink(t); }, true);
    // Reading depth: measured as the visitor scrolls, at most five times a second.
    var scrolling = null;
    w.addEventListener("scroll", function () { if (scrolling) return; scrolling = setTimeout(function () { scrolling = null; measure(); }, 200); }, { passive: true });
    if (d.readyState === "complete") settle(); else w.addEventListener("load", settle);
  }
  w.addEventListener("pagehide", function () { send(true); });
  d.addEventListener("visibilitychange", function () { if (d.visibilityState === "hidden") send(true); });
})(window, document);
`;

/** What the merchant pastes before </head> (or at the end of <body>) on every page. */
export function installSnippet(baseUrl: string, siteKey: string, opts: { consentMode?: "off" | "wait"; checkoutPaths?: string[] } = {}): string {
  const base = baseUrl.replace(/\/$/, "");
  return [`<script>window.referly=window.referly||function(){(window.referly.q=window.referly.q||[]).push(arguments)};</script>`, `<script async src="${base}/referly.js" data-site="${siteKey}"${snippetAttributes(opts)}></script>`].join("\n");
}

/** The optional attributes of the script tag, from the workspace's tracking settings. */
export function snippetAttributes(opts: { consentMode?: "off" | "wait"; checkoutPaths?: string[] } = {}): string {
  const consent = opts.consentMode === "wait" ? ` data-consent="wait"` : "";
  const paths = (opts.checkoutPaths ?? []).filter((p) => /^[a-z0-9/._~%-]+$/.test(p));
  return `${consent}${paths.length ? ` data-checkout="${paths.join(",")}"` : ""}`;
}

export const SNIPPET_EXAMPLES = {
  event: `referly('track', 'add_to_cart');     // counted once per visitor per day\nreferly('track', 'checkout');        // for a checkout that opens without its own page`,
  convert: `referly('convert', { orderId: 'ORDER-1001', amount: 129.00, currency: 'USD', email: 'buyer@example.com', couponCode: '' });`,
  form: `<input type="hidden" name="ref">\n<input type="hidden" name="referly_visitor">`,
  consent: `referly('consent', 'granted');   // from your cookie banner's accept handler; 'denied' from decline`,
};

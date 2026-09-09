/**
 * The website snippet (TRK-09). Served as-is from GET /referly.js so merchants paste one script
 * tag and the affiliate journey on their own site is recorded automatically:
 *
 *  - keeps the click token the tracking redirect appended as `?ref=` in a first-party cookie
 *    (and localStorage) for the program's attribution window, so it survives navigation;
 *  - gives the visitor a first-party id (one year) and a session id (30 minutes idle);
 *  - reports a page view on load and on every URL change in single-page apps, plus any custom
 *    events the site calls `referly('track', name, props)` for;
 *  - fills hidden `ref` / `referly_visitor` inputs so lead forms carry the attribution;
 *  - can report an order from the thank-you page with `referly('convert', {...})` when the
 *    workspace has turned that on.
 *
 * Plain ES5, no dependencies, ~3 KB. Sends as text/plain so no CORS preflight is needed and
 * sendBeacon can deliver the last batch when the page closes. Never blocks the page: every
 * failure is swallowed.
 */
export const SNIPPET_VERSION = "1";

export const SNIPPET_JS = String.raw`/*! Referly site snippet v${SNIPPET_VERSION}. Records the affiliate journey on this site. */
(function (w, d) {
  if (!w || !d || w.__referlyLoaded) return;
  w.__referlyLoaded = true;
  var script = d.currentScript;
  if (!script) {
    var all = d.getElementsByTagName("script");
    for (var i = all.length - 1; i >= 0; i--) if (/referly\.js/.test(all[i].src || "")) { script = all[i]; break; }
  }
  var site = script && script.getAttribute("data-site");
  var api = (script && script.getAttribute("data-api")) || (script && script.src ? script.src.replace(/\/referly\.js.*$/, "") : "");
  var auto = !script || script.getAttribute("data-auto") !== "false";
  var REF = "referly_ref", VID = "referly_vid", SID = "referly_sid", DAY = 86400;

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

  // Click token: from the landing URL (the tracking redirect adds it) or from an earlier visit.
  var ref = param("ref");
  if (ref && /^[A-Za-z0-9_-]{6,64}$/.test(ref)) { setCookie(REF, ref, 90 * DAY); store(REF, ref); }
  else ref = cookie(REF) || load(REF);
  // Visitor id: first party, one year. Session id: 30 minutes of inactivity.
  var vid = cookie(VID) || load(VID);
  if (!vid || !/^[A-Za-z0-9_-]{8,64}$/.test(vid)) vid = "v" + rand(20);
  setCookie(VID, vid, 365 * DAY); store(VID, vid);
  var sid = null;
  try {
    var raw = sessionStorage.getItem(SID);
    if (raw) { var parts = raw.split("."); if (Date.now() - Number(parts[1]) < 30 * 60000) sid = parts[0]; }
  } catch (e) {}
  if (!sid) sid = "s" + rand(20);
  function touch() { try { sessionStorage.setItem(SID, sid + "." + Date.now()); } catch (e) {} }
  touch();

  var queue = [], timer = null;
  function send(useBeacon) {
    if (!site || !api || !queue.length) return;
    var body = JSON.stringify({ visitorId: vid, sessionId: sid, ref: ref || undefined, events: queue.splice(0, 50) });
    var url = api + "/t/" + site + "/events";
    var sent = false;
    if (useBeacon && navigator.sendBeacon) { try { sent = navigator.sendBeacon(url, body); } catch (e) {} }
    if (!sent && w.fetch) {
      fetch(url, { method: "POST", body: body, headers: { "content-type": "text/plain" }, keepalive: true, credentials: "omit", mode: "cors" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (res) { if (res && res.ref && res.ref.ttlSeconds && ref) setCookie(REF, ref, res.ref.ttlSeconds); })
        .catch(function () {});
    }
    if (queue.length) send(useBeacon);
  }
  function flushSoon() { if (timer) return; timer = setTimeout(function () { timer = null; send(false); }, 250); }
  function track(type, name, props) {
    queue.push({ type: type, name: name || undefined, url: location.href, title: d.title, referrer: d.referrer || undefined, properties: props && typeof props === "object" ? props : undefined, at: Date.now() });
    touch();
    flushSoon();
  }
  function convert(order) {
    if (!site || !api || !order || !w.fetch) return Promise.reject(new Error("referly: convert needs an order and a configured snippet"));
    var body = JSON.stringify({ visitorId: vid, sessionId: sid, ref: ref || undefined, orderId: order.orderId || order.id, amount: order.amount, amountMinor: order.amountMinor, currency: order.currency, email: order.email, couponCode: order.couponCode, offerId: order.offerId, url: location.href });
    return fetch(api + "/t/" + site + "/convert", { method: "POST", body: body, headers: { "content-type": "text/plain" }, keepalive: true, credentials: "omit", mode: "cors" }).then(function (r) { return r.json(); });
  }
  function fill(root) {
    var inputs = (root && root.querySelectorAll ? root : d).querySelectorAll('input[name="ref"], input[name="referly_ref"], input[data-referly="ref"], input[name="referly_visitor"], input[data-referly="visitor"]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.name === "referly_visitor" || el.getAttribute("data-referly") === "visitor") el.value = vid;
      else if (ref && !el.value) el.value = ref;
    }
  }

  var stub = w.referly, pending = (stub && stub.q) || [];
  function referly(cmd) {
    var a = arguments;
    switch (cmd) {
      case "track": track("event", a[1], a[2]); break;
      case "page": track("page_view", undefined, a[1]); break;
      case "convert": return convert(a[1]);
      case "ref": return ref;
      case "visitor": return vid;
      case "session": return sid;
      case "fill": fill(a[1]); break;
      case "flush": send(false); break;
    }
  }
  referly.version = "${SNIPPET_VERSION}";
  w.referly = referly;
  // The landing page view goes first, then whatever the page queued before the script loaded.
  if (auto) track("page_view");
  for (var p = 0; p < pending.length; p++) { try { referly.apply(null, pending[p]); } catch (e) {} }

  if (auto) {
    var last = location.href;
    function changed() { if (location.href !== last) { last = location.href; track("page_view"); fill(); } }
    var methods = ["pushState", "replaceState"];
    for (var m = 0; m < methods.length; m++) (function (name) {
      var orig = history[name];
      if (!orig) return;
      history[name] = function () { var r = orig.apply(this, arguments); setTimeout(changed, 0); return r; };
    })(methods[m]);
    w.addEventListener("popstate", changed);
    if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", function () { fill(); }); else fill();
    d.addEventListener("submit", function (e) { if (e.target && e.target.querySelectorAll) fill(e.target); }, true);
  }
  w.addEventListener("pagehide", function () { send(true); });
  d.addEventListener("visibilitychange", function () { if (d.visibilityState === "hidden") send(true); });
})(window, document);
`;

/** What the merchant pastes before </head> (or at the end of <body>) on every page. */
export function installSnippet(baseUrl: string, siteKey: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return [`<script>window.referly=window.referly||function(){(window.referly.q=window.referly.q||[]).push(arguments)};</script>`, `<script async src="${base}/referly.js" data-site="${siteKey}"></script>`].join("\n");
}

export const SNIPPET_EXAMPLES = {
  event: `referly('track', 'add_to_cart', { sku: 'SKU-123', value: 49 });`,
  convert: `referly('convert', { orderId: 'ORDER-1001', amount: 129.00, currency: 'USD', email: 'buyer@example.com', couponCode: '' });`,
  form: `<input type="hidden" name="ref">\n<input type="hidden" name="referly_visitor">`,
};

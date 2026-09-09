"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Field } from "@/components/ui";
import { Icon } from "@/components/icons";

/** A read-only multi-line snippet with a copy button. */
function SnippetBox({ value, rows = 3 }: { value: string; rows?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      <textarea readOnly value={value} rows={rows} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
      <button
        type="button"
        className="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable */
          }
        }}
      >
        <Icon name={copied ? "check" : "copy"} width={13} height={13} />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Settings → Integrations: the website tracking snippet. One paste on the merchant's site records
 * the affiliate journey automatically (click token, page views, events, optionally orders).
 */
export function WebsiteTrackingCard() {
  const { data, error, reload } = useApi<any>("/v1/tenant/tracking");
  const { busy, error: actionError, success, run } = useAction();
  const [domains, setDomains] = useState<string | null>(null);
  const [pixel, setPixel] = useState(false);
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    if (data && domains === null) {
      setDomains((data.domains ?? []).join(", "));
      setPixel(!!data.pixelConversions);
    }
  }, [data, domains]);

  if (!data) return null;
  const domainList = (domains ?? "")
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter(Boolean);

  return (
    <div className="card">
      <h2>Website tracking</h2>
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      {!data.enabled ? (
        <>
          <p className="muted">
            Paste one script on your site and the affiliate journey is recorded automatically: the click token from the affiliate link is kept in a first-party cookie, every page view and event the visitor makes is tied to the affiliate who sent them, lead forms pick up the attribution, and the thank-you page can report the order without any checkout code. Journeys appear under <Link href="/app/journeys">Journeys</Link> and on each conversion.
          </p>
          <button className="primary" disabled={busy} onClick={() => run(() => api("/v1/tenant/tracking/enable", { method: "POST" }), "Website tracking is on. Paste the snippet on your site.").then(reload)}>
            Turn on website tracking
          </button>
        </>
      ) : (
        <>
          <p className="muted">
            {data.lastEventAt ? (
              <>
                Last event {dateTime(data.lastEventAt)}
                {data.lastEventHost ? ` from ${data.lastEventHost}` : ""} · {data.events7d} events from {data.visitors7d} visitors in the last 7 days.
              </>
            ) : (
              "Waiting for the first event. Paste the snippet on every page of your site, then load a page: it should show here within a few seconds."
            )}
          </p>
          <Field label="Install on every page (before </head>)" help="Works on any site: static, WordPress, Shopify themes, single-page apps. Loads asynchronously and never blocks the page.">
            <SnippetBox value={data.install} rows={2} />
          </Field>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api("/v1/tenant/tracking", { method: "PATCH", json: { domains: domainList, pixelConversions: pixel } }), "Tracking settings saved.");
              if (ok) reload();
            }}
          >
            <Field label="Your website domains" help="Only these hosts (and their subdomains) may report. Leave empty while testing; set it before accepting orders from the snippet.">
              <input value={domains ?? ""} onChange={(e) => setDomains(e.target.value)} placeholder="shop.example.com, example.com" />
            </Field>
            <label className="checkbox">
              <input type="checkbox" checked={pixel} onChange={(e) => setPixel(e.target.checked)} disabled={domainList.length === 0} /> Accept orders reported by the snippet from the thank-you page
              {domainList.length === 0 ? <span className="muted"> (add your domains first)</span> : null}
            </label>
            <p className="muted" style={{ marginTop: 4 }}>
              Orders from the snippet are recorded with source <span className="mono">pixel</span> and go through the same attribution, holding period and approval as every other sale. A server-side post from your checkout stays the most reliable option; use the snippet when you cannot change the checkout.
            </p>
            <div className="actions">
              <button className="primary" disabled={busy}>
                Save
              </button>
              <button type="button" onClick={() => setShowMore(!showMore)}>
                {showMore ? "Hide examples" : "Show examples"}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Rotate the site key? Snippets carrying the old key stop being accepted immediately; update the script tag on your site.")) run(() => api("/v1/tenant/tracking/rotate", { method: "POST" }), "Site key rotated. Update the snippet on your site.").then(reload);
                }}
              >
                Rotate key
              </button>
            </div>
          </form>
          {showMore ? (
            <div style={{ marginTop: 12 }}>
              <Field label="Report an order from the thank-you page" help="Only when the checkbox above is on. Amount in your currency; the order id is the idempotency key.">
                <SnippetBox value={`<script>${data.examples.convert}</script>`} rows={2} />
              </Field>
              <Field label="Track a custom event" help="Anything you want to see on the journey: add to cart, signup started, video watched.">
                <SnippetBox value={data.examples.event} rows={1} />
              </Field>
              <Field label="Lead forms" help="Add these hidden inputs to a form that posts to a program's capture endpoint; the snippet fills them in.">
                <SnippetBox value={data.examples.form} rows={2} />
              </Field>
              <p className="muted">
                Also available: <span className="mono">referly(&apos;ref&apos;)</span> returns the current click token for your own integrations, <span className="mono">referly(&apos;visitor&apos;)</span> the visitor id you can forward as <span className="mono">visitorId</span> when posting to the conversions endpoint.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

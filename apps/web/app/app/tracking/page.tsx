"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Field, Loading, PageHeader, Stat } from "@/components/ui";
import { CodeBlock } from "@/components/code-block";

interface PlatformSnippet {
  title: string;
  steps: string[];
  language: string;
  code: string;
  note?: string;
}
interface PlatformPlugin {
  downloadUrl: string;
  covers: string[];
  steps: string[];
}
interface PlatformGuide {
  id: string;
  name: string;
  summary: string;
  install: PlatformSnippet;
  order?: PlatformSnippet;
  plugin?: PlatformPlugin;
}

function Steps({ snippet }: { snippet: PlatformSnippet }) {
  return (
    <>
      <ol className="install-steps">
        {snippet.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <CodeBlock code={snippet.code} language={snippet.language} />
      {snippet.note ? <p className="muted small">{snippet.note}</p> : null}
    </>
  );
}

/**
 * Platforms with a plugin (WordPress): download it, create a connection key, paste the key in the
 * plugin. The plugin prints the tracking code and reports orders from the server, so nothing is
 * pasted into the site. The manual code stays available for sites that cannot install plugins.
 */
function PluginSetup({ guide }: { guide: PlatformGuide }) {
  const { busy, error, run } = useAction();
  const [key, setKey] = useState<string | null>(null);
  const plugin = guide.plugin!;
  return (
    <>
      <p className="platform-summary">{guide.summary}</p>
      <ul className="plugin-covers">
        {plugin.covers.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
      <h3>Set it up</h3>
      <ol className="install-steps">
        {plugin.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <div className="actions">
        <a className="btn primary" href={plugin.downloadUrl}>
          Download the plugin
        </a>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            const res = await run(() => api<any>("/v1/tenant/tracking/wordpress", { method: "POST" }));
            if (res) setKey(res.connectionKey);
          }}
        >
          Create connection key
        </button>
      </div>
      <Alert kind="error">{error}</Alert>
      {key ? (
        <>
          <CodeBlock code={key} label="connection key" />
          <p className="muted small">Shown once. Paste it in WordPress under Settings, Referly. Each click makes a new key; revoke the ones you no longer use under Settings, Integrations.</p>
        </>
      ) : null}
      <p className="muted small">
        The plugin reports orders itself. Leave &ldquo;Accept orders reported from my thank-you page&rdquo; off, add nothing to your thank-you page, and remove any Referly code you pasted into your theme or a snippets plugin before.
      </p>
      <details className="fallback">
        <summary>Can&apos;t install plugins? Paste the code instead</summary>
        <Steps snippet={guide.install} />
      </details>
    </>
  );
}

/**
 * Website tracking setup. Its own page rather than a settings card, because the useful part is
 * the per-platform instructions: pick where your site is built and copy what is shown.
 */
export default function TrackingPage() {
  const { data, error, reload } = useApi<any>("/v1/tenant/tracking");
  const { busy, error: actionError, success, run } = useAction();
  const [platform, setPlatform] = useState<string>("custom");
  const [domains, setDomains] = useState<string | null>(null);
  const [pixel, setPixel] = useState(false);
  const [consent, setConsent] = useState(false);

  useEffect(() => {
    if (data && domains === null) {
      setDomains((data.domains ?? []).join(", "));
      setPixel(!!data.pixelConversions);
      setConsent(data.consentMode === "wait");
    }
  }, [data, domains]);

  // Remember the merchant's platform between visits; it never changes after setup.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("referly.platform");
      if (saved) setPlatform(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);
  function choosePlatform(id: string) {
    setPlatform(id);
    try {
      window.localStorage.setItem("referly.platform", id);
    } catch {
      /* storage unavailable */
    }
  }

  if (!data) return <Loading error={error} />;

  const platforms: PlatformGuide[] = data.platforms ?? [];
  const current = platforms.find((p) => p.id === platform) ?? platforms[0];
  const domainList = (domains ?? "")
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter(Boolean);

  if (!data.enabled) {
    return (
      <>
        <PageHeader title="Website tracking" subtitle="Record what visitors from affiliate links do on your own website." />
        <Alert kind="error">{error ?? actionError}</Alert>
        <div className="card">
          <h2>What it does</h2>
          <p className="muted">
            One script on your site records the whole journey of every visitor who arrives through an affiliate link: the click is remembered for the program&apos;s attribution window, every page and action is tied to the affiliate who sent them, your lead forms carry the attribution by themselves, and your thank-you page can report the order without any checkout work. You then see it under <Link href="/app/journeys">Journeys</Link> and on each conversion.
          </p>
          <p className="muted">Turning it on creates a public site key. Nothing is recorded until you paste the snippet on your site.</p>
          <button className="primary" disabled={busy} onClick={() => run(() => api("/v1/tenant/tracking/enable", { method: "POST" }), "Website tracking is on. Follow the steps below.").then(reload)}>
            Turn on website tracking
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Website tracking"
        subtitle="Record what visitors from affiliate links do on your own website."
        actions={
          <Link className="btn" href="/app/journeys">
            View journeys
          </Link>
        }
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Status" value={data.lastEventAt ? "Receiving" : "Waiting"} hint={data.lastEventAt ? `last event ${dateTime(data.lastEventAt)}` : "no events yet"} />
        <Stat label="Reporting from" value={data.lastEventHost ?? "—"} hint="the host of the last event" />
        <Stat label="Events" value={data.events7d} hint="last 7 days" />
        <Stat label="Visitors" value={data.visitors7d} hint="last 7 days" />
      </div>

      {!data.lastEventAt ? <Alert kind="info">Nothing has arrived yet. Paste the code below on your site, then load any page of it: this turns to “Receiving” within a few seconds.</Alert> : null}

      <div className="card">
        <h2>1. Install on your site</h2>
        <p className="muted">Pick where your site is built. The code already carries your site key, so copy it as it is.</p>
        <div className="platform-picker" role="tablist" aria-label="Website platform">
          {platforms.map((p) => (
            <button key={p.id} role="tab" aria-selected={current?.id === p.id} className={current?.id === p.id ? "active" : ""} onClick={() => choosePlatform(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        {current?.plugin ? (
          <PluginSetup guide={current} />
        ) : current ? (
          <>
            <p className="platform-summary">{current.summary}</p>
            <h3>{current.install.title}</h3>
            <Steps snippet={current.install} />
          </>
        ) : null}
      </div>

      <div className="card">
        <h2>2. Lock it to your domains</h2>
        <p className="muted">Only these hosts, and their subdomains, may report under your site key. Leave it empty while you test on a staging domain; set it before you go live.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() => api("/v1/tenant/tracking", { method: "PATCH", json: { domains: domainList, pixelConversions: pixel, consentMode: consent ? "wait" : "off" } }), "Saved.");
            if (ok) reload();
          }}
        >
          <Field label="Your website domains">
            <input value={domains ?? ""} onChange={(e) => setDomains(e.target.value)} placeholder="shop.example.com, example.com" />
          </Field>

          <h3>Options</h3>
          <label className="checkbox">
            <input type="checkbox" checked={pixel} onChange={(e) => setPixel(e.target.checked)} disabled={domainList.length === 0} /> Accept orders reported from my thank-you page
            {domainList.length === 0 ? <span className="muted"> (add your domains first)</span> : null}
          </label>
          <p className="muted small">
            Lets step 3 below work. Such sales are recorded with source <span className="mono">pixel</span> and go through the same attribution, holding period and approval as every other sale. A post from your checkout server stays the sturdier option, because a browser call can be tampered with.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Wait for cookie consent before tracking
          </label>
          <p className="muted small">
            For sites with a cookie banner. Nothing is stored or sent until your banner reports consent. Cookiebot and OneTrust are picked up automatically; any other banner calls <span className="mono">referly(&apos;consent&apos;, &apos;granted&apos;)</span>. Save and re-copy the code above: it gains <span className="mono">data-consent=&quot;wait&quot;</span>.
          </p>
          <div className="actions">
            <button className="primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      </div>

      {current?.order ? (
        <div className="card">
          <h2>3. Report orders (optional)</h2>
          <p className="muted">
            {pixel ? "Sends the sale from your confirmation page, so you need no checkout integration at all." : "Switch on “Accept orders reported from my thank-you page” above first, otherwise these calls are refused."}
          </p>
          <h3>
            {current.name}: {current.order.title}
          </h3>
          <Steps snippet={current.order} />
        </div>
      ) : null}

      <div className="card">
        <h2>4. Track your own events</h2>
        <p className="muted">Optional. Anything you want to see on a visitor&apos;s journey: added to cart, started a signup, watched a video, booked a demo.</p>
        <CodeBlock code={data.examples.event} language="js" />
        <h3>Lead forms</h3>
        <p className="muted">Add these hidden inputs to a form that posts to a program&apos;s capture endpoint; the snippet fills them in, so the lead is attributed even when the form is several pages after the landing.</p>
        <CodeBlock code={data.examples.form} language="html" />
        {consent ? (
          <>
            <h3>Cookie consent</h3>
            <p className="muted">Call this from your banner&apos;s accept and decline handlers. Not needed with Cookiebot or OneTrust.</p>
            <CodeBlock code={data.examples.consent} language="js" />
          </>
        ) : null}
        <h3>Your own integrations</h3>
        <p className="muted">
          <span className="mono">referly(&apos;ref&apos;)</span> returns the current click token and <span className="mono">referly(&apos;visitor&apos;)</span> the visitor id. Send either from your server when you post a conversion: the visitor id keeps working after the cookie is gone.
        </p>
      </div>

      <div className="card">
        <h2>Site key</h2>
        <p className="muted">Public, and only identifies this workspace. Rotate it if it ends up somewhere it should not be; the old snippet stops being accepted immediately, so update your site straight after.</p>
        <CodeBlock code={data.siteKey} label="site key" />
        <div className="actions">
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Rotate the site key? Snippets carrying the old key stop being accepted immediately; you will need to update the code on your site.")) run(() => api("/v1/tenant/tracking/rotate", { method: "POST" }), "Site key rotated. Update the code on your site now.").then(reload);
            }}
          >
            Rotate site key
          </button>
        </div>
      </div>
    </>
  );
}

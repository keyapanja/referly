"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { money } from "@/lib/format";
import { Alert, Badge, PageHeader, Table } from "@/components/ui";

const RANGES = [7, 30, 90] as const;

const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
const people = (n: number) => `${n.toLocaleString()} ${n === 1 ? "person" : "people"}`;

interface Step {
  label: string;
  hint: string;
  value: number;
}

/**
 * The funnel as horizontal bars on one scale: how many of the people affiliates sent got this
 * far. Every number is printed beside its bar, so nothing depends on reading a length or a colour.
 */
function Funnel({ steps }: { steps: Step[] }) {
  const top = steps[0]?.value ?? 0;
  const scale = Math.max(...steps.map((s) => s.value), 1);
  return (
    <ol className="funnel viz" aria-label="Journey funnel">
      {steps.map((s, i) => (
        <li key={s.label} title={`${s.label}: ${people(s.value)}${i > 0 ? `, ${share(s.value, top)} of those who arrived` : ""}`}>
          <div className="funnel-label">
            <strong>{s.label}</strong>
            <span className="muted small">{s.hint}</span>
          </div>
          <div className="funnel-track" aria-hidden="true">
            <div className="funnel-bar" style={{ width: `${(s.value / scale) * 100}%` }} />
          </div>
          <div className="funnel-value">{s.value.toLocaleString()}</div>
          <div className="funnel-share muted">{i === 0 ? "" : share(s.value, top)}</div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Journeys, as totals: of the people your affiliates sent, how many arrived, read, reached the
 * checkout and bought, and which pages held them. Nothing here is about any one visitor: the
 * site's tracking code reports each stage once a day and Referly only keeps the counts.
 */
export default function JourneysPage() {
  const [days, setDays] = useState<number>(30);
  const [affiliateId, setAffiliateId] = useState("");
  const query = `/v1/journeys?days=${days}${affiliateId ? `&affiliateId=${affiliateId}` : ""}`;
  const { data, error } = useApi<any>(query, [query]);
  const { data: tracking } = useApi<any>("/v1/tenant/tracking");
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const f = data?.funnel;
  const revenue: string = (f?.revenue ?? []).map((r: any) => money(r.minor, r.currency)).join(" + ");

  const steps: Step[] = f
    ? [
        { label: "Arrived", hint: "through an affiliate link", value: f.visitors },
        { label: "Read half a page", hint: "scrolled at least halfway down", value: f.half },
        { label: "Read to the bottom", hint: "reached the end of a page", value: f.bottom },
        { label: "Reached the checkout", hint: "opened a checkout page", value: f.checkout },
        { label: "Bought", hint: revenue ? `${revenue} in sales` : "sales credited to a link", value: f.purchases },
        ...(f.leads > 0 ? [{ label: "Signed up", hint: "leads credited to a link", value: f.leads }] : []),
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Journeys"
        subtitle="What the people your affiliates send do on your site, in totals. No individual visitor is recorded."
        actions={
          <>
            <select value={affiliateId} onChange={(e) => setAffiliateId(e.target.value)} aria-label="Affiliate">
              <option value="">Every affiliate</option>
              {affiliates?.affiliates?.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
              {RANGES.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </select>
          </>
        }
      />
      <Alert kind="error">{error}</Alert>
      {tracking && !tracking.enabled ? (
        <Alert kind="info">
          Website tracking is off. Turn it on under <Link href="/app/tracking">Website tracking</Link>; numbers show up here as soon as someone arrives through an affiliate link.
        </Alert>
      ) : null}

      <div className="card">
        <h2>From arriving to buying</h2>
        <p className="muted">Of the people who arrived through an affiliate link in the last {days} days, how many got this far. Each person counts once a day.</p>
        {!f ? <div className="empty">Loading…</div> : f.visitors === 0 && f.purchases === 0 ? <div className="empty">No visits from affiliate links in this period yet.</div> : <Funnel steps={steps} />}
        {f && f.visitors > 0 && f.checkout === 0 ? (
          <p className="muted small funnel-note">
            Nobody has been seen at your checkout yet. Referly recognises a checkout by &ldquo;checkout&rdquo; in its address, and the WordPress plugin points it out directly; if yours lives at another address, list it under <Link href="/app/tracking">Website tracking</Link>.
          </p>
        ) : null}
        {data?.couponOnlySales > 0 ? (
          <p className="muted small funnel-note">
            {data.couponOnlySales} more sale{data.couponOnlySales === 1 ? "" : "s"} came through a coupon code without a link click. They are real sales on the <Link href="/app/conversions">Conversions</Link> page, but nobody arrived through a link, so they are not part of this funnel.
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2>Pages</h2>
        <p className="muted">Where they landed, which pages they saw, and how far down each one they read.</p>
        <Table
          rows={data?.pages}
          keyOf={(p: any) => p.page}
          empty="No pages seen in this period yet."
          columns={[
            {
              header: "Page",
              cell: (p: any) => (
                <>
                  <span className="mono page-name">{p.page}</span>
                  {p.checkout > 0 ? (
                    <>
                      {" "}
                      <Badge value="checkout" />
                    </>
                  ) : null}
                </>
              ),
            },
            { header: "Landed here", cell: (p: any) => p.landed.toLocaleString(), num: true },
            { header: "Visitors", cell: (p: any) => p.visitors.toLocaleString(), num: true },
            {
              header: "Read half",
              num: true,
              cell: (p: any) => (
                <>
                  {p.half.toLocaleString()} <span className="muted small">{share(p.half, p.visitors)}</span>
                </>
              ),
            },
            {
              header: "Read to the bottom",
              num: true,
              cell: (p: any) => (
                <>
                  {p.bottom.toLocaleString()} <span className="muted small">{share(p.bottom, p.visitors)}</span>
                </>
              ),
            },
          ]}
        />
      </div>

      {data?.events?.length ? (
        <div className="card">
          <h2>Your own events</h2>
          <p className="muted">
            What your site reports with <span className="mono">referly(&apos;track&apos;, &hellip;)</span>, by how many people did each.
          </p>
          <Table
            rows={data.events}
            keyOf={(e: any) => e.name}
            columns={[
              { header: "Event", cell: (e: any) => <span className="mono">{e.name}</span> },
              { header: "People", cell: (e: any) => e.visitors.toLocaleString(), num: true },
              { header: "Of those who arrived", cell: (e: any) => share(e.visitors, f?.visitors ?? 0), num: true },
            ]}
          />
        </div>
      ) : null}
    </>
  );
}

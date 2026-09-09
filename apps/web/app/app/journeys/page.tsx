"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Badge, PageHeader, Stat, Table } from "@/components/ui";
import { JourneyTimeline } from "@/components/journey";

const VIEWS = [
  ["attributed", "Affiliate traffic"],
  ["converted", "Converted"],
  ["all", "All visitors"],
] as const;

const RANGES = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
] as const;

function shortAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return dateTime(iso);
}

/**
 * Website journeys recorded by the site snippet: one row per visit, with what the visitor did
 * and whether it ended in a sale or lead. Opening a row shows the whole journey of that visitor.
 */
export default function JourneysPage() {
  const [view, setView] = useState<(typeof VIEWS)[number][0]>("attributed");
  const [days, setDays] = useState<number>(30);
  const [affiliateId, setAffiliateId] = useState("");
  const [selected, setSelected] = useState<{ visitorId: string; sessionId: string } | null>(null);
  const query = `/v1/journeys?days=${days}&attributed=${view === "all" ? "0" : "1"}&converted=${view === "converted" ? "1" : "0"}${affiliateId ? `&affiliateId=${affiliateId}` : ""}`;
  const { data, error } = useApi<any>(query, [query]);
  const { data: tracking } = useApi<any>("/v1/tenant/tracking");
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { data: detail } = useApi<any>(selected ? `/v1/journeys/visitors/${selected.visitorId}` : null, [selected?.visitorId]);
  const s = data?.summary;

  return (
    <>
      <PageHeader
        title="Journeys"
        subtitle="What visitors from affiliate links did on your website, recorded by the site snippet."
        actions={
          <>
            <div className="segmented">
              {VIEWS.map(([key, label]) => (
                <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
                  {label}
                </button>
              ))}
            </div>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range">
              {RANGES.map(([d, label]) => (
                <option key={d} value={d}>
                  Last {label}
                </option>
              ))}
            </select>
            <select value={affiliateId} onChange={(e) => setAffiliateId(e.target.value)} aria-label="Affiliate">
              <option value="">Every affiliate</option>
              {affiliates?.affiliates?.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </>
        }
      />
      <Alert kind="error">{error}</Alert>
      {tracking && !tracking.enabled ? (
        <Alert kind="info">
          Website tracking is off. Turn it on under <Link href="/app/settings">Settings → Website tracking</Link> and paste the snippet on your site; journeys start showing here as soon as visitors arrive through affiliate links.
        </Alert>
      ) : tracking && tracking.enabled && !tracking.lastEventAt ? (
        <Alert kind="info">
          The snippet has not reported anything yet. Check it is installed on every page: <Link href="/app/settings">Settings → Website tracking</Link>.
        </Alert>
      ) : null}
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Visits" value={s?.sessions ?? "…"} hint={`all visitors, last ${days} days`} />
        <Stat label="From affiliates" value={s?.attributedSessions ?? "…"} hint={s?.sessions ? `${Math.round((s.attributedSessions / s.sessions) * 100)}% of visits` : "arrived through an affiliate link"} />
        <Stat label="Converted" value={s?.convertedSessions ?? "…"} hint={s?.attributedSessions ? `${Math.round((s.convertedSessions / s.sessions) * 100)}% of visits ended in a sale or lead` : "visits with a sale or lead"} />
        <Stat label="Page views" value={s?.pageViews ?? "…"} hint={s?.sessions ? `${(s.pageViews / s.sessions).toFixed(1)} per visit` : "across all visits"} />
      </div>
      {selected ? (
        <div className="card">
          <div className="page-header" style={{ marginBottom: 8 }}>
            <div>
              <h2 style={{ margin: 0 }}>Visitor journey</h2>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                Visitor <span className="mono">{selected.visitorId}</span> · every visit this person made, oldest first.
              </p>
            </div>
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <JourneyTimeline events={detail?.events} />
        </div>
      ) : null}
      <div className="card">
        <Table
          rows={data?.sessions}
          keyOf={(r: any) => `${r.visitorId}:${r.sessionId}`}
          empty={view === "attributed" ? "No visits from affiliate links in this period." : view === "converted" ? "No visits ended in a sale or lead in this period." : "No visits recorded in this period."}
          columns={[
            { header: "Started", cell: (r: any) => <span title={dateTime(r.startedAt)}>{shortAgo(r.startedAt)}</span> },
            { header: "Affiliate", cell: (r: any) => (r.affiliateId ? <Link href={`/app/affiliates/${r.affiliateId}`}>{r.affiliateName ?? r.affiliateId}</Link> : <span className="muted">direct</span>) },
            { header: "Landing page", cell: (r: any) => <span className="mono">{r.landingPath ?? "—"}</span> },
            { header: "Pages", cell: (r: any) => r.pages, num: true },
            { header: "Events", cell: (r: any) => r.events, num: true },
            { header: "Outcome", cell: (r: any) => <Badge value={r.outcome} /> },
            { header: "Last seen", cell: (r: any) => shortAgo(r.lastAt) },
            {
              header: "",
              cell: (r: any) => (
                <button className="sm" onClick={() => setSelected({ visitorId: r.visitorId, sessionId: r.sessionId })}>
                  View journey
                </button>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}

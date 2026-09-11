"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Alert, PageHeader, Stat, Table } from "@/components/ui";
import { JourneyTimeline } from "@/components/journey";

const RANGES = [7, 30, 90] as const;

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return dateTime(iso);
}

function Result({ visit }: { visit: any }) {
  if (visit.conversions > 0) return <strong>{visit.saleMinor ? `Bought · ${money(visit.saleMinor, visit.currency ?? "USD")}` : "Bought"}</strong>;
  if (visit.leads > 0) return <strong>Signed up</strong>;
  return <span className="muted">No purchase</span>;
}

/**
 * Journeys: the people your affiliates sent to your site, and whether they bought. Only affiliate
 * traffic is recorded, so everything here came through an affiliate link. Opening a visit shows
 * what that person did, as a short list of steps.
 */
export default function JourneysPage() {
  const [days, setDays] = useState<number>(30);
  const [affiliateId, setAffiliateId] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const query = `/v1/journeys?days=${days}${affiliateId ? `&affiliateId=${affiliateId}` : ""}`;
  const { data, error } = useApi<any>(query, [query]);
  const { data: tracking } = useApi<any>("/v1/tenant/tracking");
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { data: detail } = useApi<any>(open ? `/v1/journeys/visitors/${open}` : null, [open]);
  const s = data?.summary;
  const rate = s?.visits ? Math.round((s.sales / s.visits) * 100) : null;

  return (
    <>
      <PageHeader
        title="Journeys"
        subtitle="The people your affiliates sent to your site, and whether they bought."
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
          Website tracking is off. Turn it on under <Link href="/app/tracking">Website tracking</Link>; visits show up here as soon as someone arrives through an affiliate link.
        </Alert>
      ) : null}

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <Stat label="Visits" value={s?.visits ?? "…"} hint={`from affiliate links, last ${days} days`} />
        <Stat label="Sales" value={s?.sales ?? "…"} hint="visits that ended in a purchase" />
        <Stat label="Conversion rate" value={rate === null ? "—" : `${rate}%`} hint="sales out of visits" />
      </div>

      {open ? (
        <div className="card">
          <div className="page-header" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>What they did</h2>
            <button type="button" onClick={() => setOpen(null)}>
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
          empty="No visits from affiliate links in this period yet."
          columns={[
            { header: "When", cell: (r: any) => <span title={dateTime(r.startedAt)}>{ago(r.startedAt)}</span> },
            { header: "Affiliate", cell: (r: any) => <Link href={`/app/affiliates/${r.affiliateId}`}>{r.affiliateName ?? "Affiliate"}</Link> },
            { header: "Result", cell: (r: any) => <Result visit={r} /> },
            {
              header: "",
              cell: (r: any) => (
                <button className="sm" onClick={() => setOpen(r.visitorId)}>
                  View
                </button>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}

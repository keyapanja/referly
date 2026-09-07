"use client";

import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { date, money } from "@/lib/format";
import { Alert, Badge, CopyBox, Loading, PageHeader } from "@/components/ui";

export default function PortalCampaigns() {
  const { data, error, reload } = useApi<any>("/portal/campaigns");
  const { data: me } = useApi<any>("/portal/me");
  const { busy, error: actionError, run } = useAction();
  const cur = me?.tenant?.currency ?? "USD";
  if (!data) return <Loading error={error} />;
  return (
    <>
      <PageHeader title="Campaigns" subtitle="Limited-time promotions you've been invited to. Join to unlock the campaign rate, bonus and creative." />
      <Alert kind="error">{actionError}</Alert>
      {data.campaigns.length === 0 ? <div className="card empty">No campaigns right now.</div> : null}
      {data.campaigns.map((row: any) => {
        const c = row.campaign;
        const pct = row.progress ? Math.min(100, Math.round((row.progress.value / row.progress.threshold) * 100)) : 0;
        return (
          <div className="card" key={c.id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
              <div>
                <h2 style={{ marginBottom: 2 }}>{c.name}</h2>
                <div className="muted">
                  {row.program.name} · {date(c.startAt)} – {date(c.endAt)} {c.live ? <Badge value="active" /> : <span>· starts {date(c.startAt)}</span>}
                </div>
              </div>
              {row.participantStatus === "invited" ? (
                <button className="primary" disabled={busy} onClick={() => run(() => api(`/portal/campaigns/${c.id}/join`, { method: "POST" })).then(reload)}>
                  Join campaign
                </button>
              ) : (
                <Badge value="joined" />
              )}
            </div>
            {c.description ? <p style={{ marginTop: 10 }}>{c.description}</p> : null}
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>You earn</dt>
              <dd>{c.commissionPercent != null ? `${c.commissionPercent}% per sale during the campaign` : c.commissionFixedMinor != null ? `${money(c.commissionFixedMinor, cur)} per sale during the campaign` : "Your usual program rate"}</dd>
              {row.progress ? (
                <>
                  <dt>Bonus</dt>
                  <dd>
                    {money(row.progress.bonusMinor, cur)} after {row.progress.metric === "revenue" ? `${money(row.progress.threshold, cur)} in sales` : `${row.progress.threshold} sales`}
                    {row.participantStatus === "active" ? (
                      <div className="usage" style={{ maxWidth: 360 }}>
                        <div className="usage-row">
                          <span>{row.progress.awarded ? "Bonus awarded" : "Progress"}</span>
                          <span className="muted">
                            {row.progress.metric === "revenue" ? money(row.progress.value, cur) : row.progress.value} / {row.progress.metric === "revenue" ? money(row.progress.threshold, cur) : row.progress.threshold}
                          </span>
                        </div>
                        <div className="bar">
                          <div className="fill" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    ) : null}
                  </dd>
                </>
              ) : null}
            </dl>
            {row.assets.length ? (
              <>
                <h3 style={{ marginTop: 14 }}>Campaign assets</h3>
                <div className="list-inline">
                  {row.assets.map((a: any) => (
                    <span key={a.id} className="actions">
                      {a.url ? (
                        <a className="btn sm" href={a.url} target="_blank" rel="noreferrer">
                          {a.title}
                        </a>
                      ) : (
                        <CopyBox value={a.body ?? ""} />
                      )}
                    </span>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

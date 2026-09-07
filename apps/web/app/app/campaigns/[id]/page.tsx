"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Alert, Badge, Field, Loading, PageHeader, Stat, Table } from "@/components/ui";

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<any>(`/v1/campaigns/${id}`);
  const { data: me } = useApi<any>("/v1/tenant/me");
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { data: assetsData } = useApi<any>("/v1/assets");
  const { data: groupsData } = useApi<any>("/v1/groups");
  const [groupPick, setGroupPick] = useState("");
  const { busy, error: actionError, success, run } = useAction();
  const cur = me?.tenant?.currency ?? "USD";
  const [pick, setPick] = useState<string[]>([]);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  useEffect(() => {
    if (data) setAssetIds(data.assets.map((a: any) => a.id));
  }, [data]);
  if (!data) return <Loading error={error} />;
  const c = data.campaign;
  const perf = data.performance;
  const participantIds = new Set(data.participants.map((p: any) => p.affiliateId));
  const candidates = (affiliates?.affiliates ?? []).filter((a: any) => !participantIds.has(a.id));
  const act = (status: string, label: string) => run(() => api(`/v1/campaigns/${id}/status`, { method: "POST", json: { status } }), label).then(reload);

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={
          <>
            {data.program?.name} · {dateTime(c.startAt)} – {dateTime(c.endAt)} · <Badge value={c.status} /> {c.live ? <span className="muted">live now</span> : null}
          </>
        }
        actions={
          <>
            {c.status === "draft" ? <button className="primary" disabled={busy} onClick={() => act("active", "Campaign activated. Invited affiliates have been notified.")}>Activate</button> : null}
            {c.status === "active" ? <button disabled={busy} onClick={() => act("ended", "Campaign ended.")}>End now</button> : null}
            {c.status === "draft" || c.status === "active" ? <button className="danger" disabled={busy} onClick={() => act("cancelled", "Campaign cancelled.")}>Cancel</button> : null}
          </>
        }
      />
      <Alert kind="error">{actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-4">
        <Stat label="Participants" value={`${perf.participants.active} / ${perf.participants.invited}`} hint="active / invited" />
        <Stat label="Sales" value={perf.conversions} />
        <Stat label="Revenue" value={money(perf.revenueMinor, cur)} />
        <Stat label="Commission + bonuses" value={money(perf.commissionMinor + perf.bonusesMinor, cur)} hint={perf.bonusesMinor ? `${money(perf.bonusesMinor, cur)} in bonuses` : undefined} />
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Terms</h2>
          <dl className="kv">
            <dt>Commission</dt>
            <dd>
              {c.commissionRateBpsOverride != null ? `${c.commissionRateBpsOverride / 100}% of sale` : c.commissionFixedMinorOverride != null ? `${money(c.commissionFixedMinorOverride, cur)} per sale` : `Program rate (${data.program?.commissionModel === "fixed" ? money(data.program.commissionFixedMinor, cur) : `${data.program?.commissionPercent}%`})`}
            </dd>
            <dt>Bonus</dt>
            <dd>{c.bonusRule ? `${money(c.bonusRule.bonusMinor, cur)} after ${c.bonusRule.metric === "revenue" ? money(c.bonusRule.threshold, cur) + " revenue" : c.bonusRule.threshold + " sales"}` : "None"}</dd>
            <dt>Offers</dt>
            <dd>{c.offerIds?.length ? `${c.offerIds.length} selected` : "All offers in the program"}</dd>
            {c.description ? (
              <>
                <dt>Description</dt>
                <dd>{c.description}</dd>
              </>
            ) : null}
          </dl>
        </div>
        <div className="card">
          <h2>Campaign assets</h2>
          <p className="muted">Active participants see these in their portal while the campaign is live, regardless of the asset's usual visibility.</p>
          {assetsData?.assets?.length ? (
            assetsData.assets.map((a: any) => (
              <label key={a.id} className="checkbox" style={{ marginBottom: 6 }}>
                <input type="checkbox" checked={assetIds.includes(a.id)} onChange={(e) => setAssetIds(e.target.checked ? [...assetIds, a.id] : assetIds.filter((x) => x !== a.id))} /> {a.title} <span className="muted">· {a.type}</span>
              </label>
            ))
          ) : (
            <div className="help">No assets in the library yet.</div>
          )}
          <button className="sm" style={{ marginTop: 8 }} disabled={busy} onClick={() => run(() => api(`/v1/campaigns/${id}/assets`, { method: "PUT", json: { assetIds } }), "Assets saved.").then(reload)}>
            Save assets
          </button>
        </div>
      </div>
      <div className="card">
        <h2>Participants</h2>
        {c.status === "draft" || c.status === "active" ? (
          <div className="actions" style={{ marginBottom: 12 }}>
            <select multiple value={pick} onChange={(e) => setPick(Array.from(e.target.selectedOptions).map((o) => o.value))} style={{ minWidth: 260, height: 96 }}>
              {candidates.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.email}
                </option>
              ))}
            </select>
            <button className="sm primary" disabled={busy || !pick.length} onClick={() => run(() => api(`/v1/campaigns/${id}/participants`, { method: "POST", json: { affiliateIds: pick } }), "Invited.").then(() => { setPick([]); reload(); })}>
              Invite selected
            </button>
            <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/campaigns/${id}/participants`, { method: "POST", json: { all: true } }), "Every active affiliate in the program has been invited.").then(reload)}>
              Invite all in program
            </button>
            <select value={groupPick} onChange={(e) => setGroupPick(e.target.value)} style={{ width: 200 }}>
              <option value="">Invite a group…</option>
              {groupsData?.groups?.map((g: any) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <button className="sm" disabled={busy || !groupPick} onClick={() => run(() => api(`/v1/campaigns/${id}/participants`, { method: "POST", json: { groupIds: [groupPick] } }), "Group invited.").then(() => { setGroupPick(""); reload(); })}>
              Invite group
            </button>
          </div>
        ) : null}
        <Table
          rows={data.participants}
          keyOf={(p: any) => p.id}
          empty="Nobody invited yet."
          columns={[
            { header: "Affiliate", cell: (p: any) => <>{p.name}<div className="muted">{p.email}</div></> },
            { header: "Status", cell: (p: any) => <Badge value={p.status} /> },
            { header: "Invited", cell: (p: any) => dateTime(p.invitedAt) },
            { header: "Joined", cell: (p: any) => (p.joinedAt ? dateTime(p.joinedAt) : "—") },
            { header: "Bonus", cell: (p: any) => (p.bonusAwardedAt ? `awarded ${dateTime(p.bonusAwardedAt)}` : "—") },
            { header: "", cell: (p: any) => <button className="sm danger" disabled={busy} onClick={() => run(() => api(`/v1/campaigns/${id}/participants/${p.affiliateId}`, { method: "DELETE" })).then(reload)}>Remove</button> },
          ]}
        />
      </div>
    </>
  );
}

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api, API_URL } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { date, dateTime, money } from "@/lib/format";
import { Alert, Badge, CopyBox, Field, Loading, PageHeader, Stat, Table } from "@/components/ui";

export default function AffiliateDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<any>(`/v1/affiliates/${id}`);
  const { data: conv } = useApi<any>(`/v1/conversions?affiliateId=${id}&limit=50`);
  const { data: ledger, reload: reloadLedger } = useApi<any>(`/v1/affiliates/${id}/ledger`);
  const { data: programs } = useApi<any>("/v1/programs");
  const { data: allGroups } = useApi<any>("/v1/groups");
  const [groupPick, setGroupPick] = useState("");
  const { busy, error: actionError, success, run } = useAction();
  const [reason, setReason] = useState("");
  const [coupon, setCoupon] = useState({ code: "", programId: "" });
  const [override, setOverride] = useState({ programId: "", percent: "", reason: "" });
  const [adjust, setAdjust] = useState({ amount: "", reason: "" });

  if (!data) return <Loading error={error} />;
  const a = data.affiliate;
  const cur = data.balances.currency ?? "USD";
  const programName = (pid: string) => programs?.programs?.find((p: any) => p.id === pid)?.name ?? pid;
  const refresh = () => {
    reload();
    reloadLedger();
  };

  return (
    <>
      <PageHeader
        title={a.name}
        subtitle={
          <>
            {a.email} · <Badge value={a.status} /> · via {a.source}
          </>
        }
        actions={
          <>
            {a.status === "applied" && (
              <button className="primary" disabled={busy} onClick={() => run(() => api(`/v1/affiliates/${id}/approve`, { method: "POST", json: {} })).then(refresh)}>
                Approve
              </button>
            )}
            {a.status === "applied" && (
              <button disabled={busy} onClick={() => run(() => api(`/v1/affiliates/${id}/reject`, { method: "POST", json: {} })).then(refresh)}>
                Reject
              </button>
            )}
            {a.status === "active" && (
              <button
                className="danger"
                disabled={busy}
                onClick={() => {
                  const r = window.prompt("Reason for suspension (required):");
                  if (r) run(() => api(`/v1/affiliates/${id}/suspend`, { method: "POST", json: { reason: r } })).then(refresh);
                }}
              >
                Suspend
              </button>
            )}
            {(a.status === "suspended" || a.status === "rejected") && (
              <button disabled={busy} onClick={() => run(() => api(`/v1/affiliates/${id}/reactivate`, { method: "POST", json: { reason: reason || undefined } })).then(refresh)}>
                Reactivate
              </button>
            )}
          </>
        }
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Pending" value={money(data.balances.pendingMinor, cur)} hint="in holding period" />
        <Stat label="Available" value={money(data.balances.availableMinor, cur)} hint="payable now" />
        <Stat label="Reserved" value={money(data.balances.reservedMinor, cur)} hint="in payout batches" />
        <Stat label="Paid" value={money(data.balances.paidMinor, cur)} />
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Programs</h2>
          <Table
            rows={data.memberships}
            keyOf={(m: any) => m.programId}
            empty="Not in any program."
            columns={[
              { header: "Program", cell: (m: any) => <Link href={`/app/programs/${m.programId}`}>{programName(m.programId)}</Link> },
              { header: "Status", cell: (m: any) => <Badge value={m.status} /> },
              { header: "Terms", cell: (m: any) => `v${m.termsVersion} · ${date(m.termsAcceptedAt)}` },
              { header: "Override", cell: (m: any) => (m.customCommissionRateBps != null ? `${m.customCommissionRateBps / 100}%` : m.customCommissionFixedMinor != null ? money(m.customCommissionFixedMinor, cur) : "—") },
            ]}
          />
          <form
            style={{ marginTop: 12 }}
            onSubmit={async (e) => {
              e.preventDefault();
              await run(() => api(`/v1/affiliates/${id}/programs/${override.programId}/override`, { method: "POST", json: { commissionPercent: override.percent === "" ? null : Number(override.percent), reason: override.reason } }), "Override saved.");
              refresh();
            }}
          >
            <h3>Commission override</h3>
            <div className="row">
              <Field label="Program">
                <select value={override.programId} onChange={(e) => setOverride({ ...override, programId: e.target.value })} required>
                  <option value="">Choose…</option>
                  {data.memberships.map((m: any) => (
                    <option key={m.programId} value={m.programId}>
                      {programName(m.programId)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Custom % (blank to clear)">
                <input value={override.percent} onChange={(e) => setOverride({ ...override, percent: e.target.value })} />
              </Field>
            </div>
            <Field label="Reason">
              <input value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} required />
            </Field>
            <button className="sm" disabled={busy}>
              Save override
            </button>
          </form>
        </div>
        <div className="card">
          <h2>Groups</h2>
          {data.groups?.length ? (
            <div className="list-inline" style={{ marginBottom: 10 }}>
              {data.groups.map((g: any) => (
                <span key={g.id} className="badge active" style={{ gap: 8 }}>
                  {g.name}
                  <button type="button" className="sm" style={{ height: 20, padding: "0 6px", fontSize: 11 }} disabled={busy} onClick={() => run(() => api(`/v1/groups/${g.id}/members/${id}`, { method: "DELETE" })).then(refresh)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">Not in any group.</p>
          )}
          <div className="actions">
            <select value={groupPick} onChange={(e) => setGroupPick(e.target.value)} style={{ width: 220 }}>
              <option value="">Add to group…</option>
              {(allGroups?.groups ?? []).filter((g: any) => !data.groups?.some((x: any) => x.id === g.id)).map((g: any) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <button className="sm" disabled={busy || !groupPick} onClick={() => run(() => api(`/v1/groups/${groupPick}/members`, { method: "POST", json: { affiliateIds: [id] } })).then(() => { setGroupPick(""); refresh(); })}>
              Add
            </button>
          </div>
        </div>
        <div className="card">
          <h2>Links and codes</h2>
          {data.links.map((l: any) => (
            <div key={l.id} style={{ marginBottom: 6 }}>
              <CopyBox value={`${API_URL}/r/${l.token}`} /> <span className="muted">{l.clickCount} clicks</span>
            </div>
          ))}
          {data.codes.map((c: any) => (
            <div key={c.id} style={{ marginBottom: 6 }}>
              <code>{c.code}</code> <span className="muted">{programName(c.programId)}</span> <Badge value={c.status} />
            </div>
          ))}
          <form
            style={{ marginTop: 12 }}
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api(`/v1/affiliates/${id}/coupons`, { method: "POST", json: { code: coupon.code, programId: coupon.programId } }), "Coupon created.");
              if (ok) {
                setCoupon({ code: "", programId: "" });
                refresh();
              }
            }}
          >
            <h3>New coupon code</h3>
            <div className="row">
              <Field label="Code">
                <input value={coupon.code} onChange={(e) => setCoupon({ ...coupon, code: e.target.value.toUpperCase() })} required minLength={3} />
              </Field>
              <Field label="Program">
                <select value={coupon.programId} onChange={(e) => setCoupon({ ...coupon, programId: e.target.value })} required>
                  <option value="">Choose…</option>
                  {data.memberships.map((m: any) => (
                    <option key={m.programId} value={m.programId}>
                      {programName(m.programId)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button className="sm" disabled={busy}>
              Create code
            </button>
          </form>
        </div>
      </div>
      <div className="card">
        <h2>Conversions</h2>
        <Table
          rows={conv?.conversions}
          keyOf={(c: any) => c.id}
          empty="No conversions yet."
          columns={[
            { header: "When", cell: (c: any) => <Link href={`/app/conversions/${c.id}`}>{dateTime(c.occurredAt)}</Link> },
            { header: "Order", cell: (c: any) => <span className="mono">{c.externalOrderId}</span> },
            { header: "Amount", cell: (c: any) => money(c.amountMinor - c.refundedAmountMinor, c.currency), num: true },
            { header: "Source", cell: (c: any) => c.attributionSource },
            { header: "Status", cell: (c: any) => <Badge value={c.status} /> },
          ]}
        />
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Ledger</h2>
          <Table
            rows={ledger?.entries}
            keyOf={(e: any) => e.id}
            empty="No ledger entries."
            columns={[
              { header: "When", cell: (e: any) => dateTime(e.createdAt) },
              { header: "Type", cell: (e: any) => e.type },
              { header: "Amount", cell: (e: any) => money(e.amountMinor, e.currency), num: true },
              { header: "Reason", cell: (e: any) => e.reason },
            ]}
          />
        </div>
        <div className="card">
          <h2>Manual adjustment</h2>
          <p className="muted">Positive credits, negative debits. Applied to the next payout. Reason is required and audited.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const minor = Math.round(Number(adjust.amount) * 100);
              const ok = await run(() => api("/v1/commissions/adjustments", { method: "POST", json: { affiliateId: id, amountMinor: minor, currency: cur, reason: adjust.reason } }), "Adjustment recorded.");
              if (ok) {
                setAdjust({ amount: "", reason: "" });
                refresh();
              }
            }}
          >
            <Field label={`Amount (${cur})`}>
              <input value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} required />
            </Field>
            <Field label="Reason">
              <input value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} required />
            </Field>
            <button disabled={busy}>Record adjustment</button>
          </form>
          <h3 style={{ marginTop: 16 }}>Profile</h3>
          <dl className="kv">
            <dt>Phone</dt>
            <dd>{a.phone ?? "—"}</dd>
            <dt>Text messages</dt>
            <dd>{a.textChannel ? (a.textConsentAt && !(a.textOptOutAt && a.textOptOutAt >= a.textConsentAt) ? `${a.textChannel === "whatsapp" ? "WhatsApp" : "SMS"} · consented ${a.textConsentAt.slice(0, 10)}` : `${a.textChannel === "whatsapp" ? "WhatsApp" : "SMS"} · opted out`) : "email only"}</dd>
            <dt>Company</dt>
            <dd>{a.company ?? "—"}</dd>
            <dt>Channels</dt>
            <dd>{Object.entries(a.channels ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "—"}</dd>
            <dt>Payout method</dt>
            <dd>{a.payoutMethod ? `${a.payoutMethod} · ${a.payoutDetailsMasked ?? ""}` : "not set"}</dd>
            <dt>Tags</dt>
            <dd>{a.tags?.join(", ") || "—"}</dd>
          </dl>
        </div>
      </div>
    </>
  );
}

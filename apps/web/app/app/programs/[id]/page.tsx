"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Alert, Badge, CopyBox, Field, Loading, PageHeader } from "@/components/ui";
import { TiersCard } from "@/components/tiers-card";

const NEXT: Record<string, string[]> = { draft: ["active", "archived"], active: ["paused", "archived"], paused: ["active", "archived"], archived: [] };

export default function ProgramDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<any>(`/v1/programs/${id}`);
  const { data: offers } = useApi<any>("/v1/offers");
  const { data: me } = useApi<any>("/v1/tenant/me");
  const { busy, error: actionError, success, run } = useAction();
  const [form, setForm] = useState<any>(null);
  const [leadForm, setLeadForm] = useState<any>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (data && !form) {
      const p = data.program;
      setForm({ name: p.name, commissionPercent: String(p.commissionRateBps / 100), commissionFixed: String(p.commissionFixedMinor / 100), commissionModel: p.commissionModel, commissionBasis: p.commissionBasis, holdingDays: String(p.holdingDays), attributionWindowDays: String(p.attributionWindowDays), approvalMode: p.approvalMode, refundPolicy: p.refundPolicy, precedence: p.precedence, attributionModel: p.attributionModel, termsText: p.termsText, testMode: p.testMode });
      setLeadForm({ leadsEnabled: p.leadsEnabled, leadCommission: String(p.leadCommissionMinor / 100), leadApproval: p.leadApproval, leadDedupeDays: String(p.leadDedupeDays) });
    }
  }, [data, form]);

  if (!data || !form) return <Loading error={error} />;
  const p = data.program;
  const attached = new Set(data.offers.map((o: any) => o.offerId));

  return (
    <>
      <PageHeader
        title={p.name}
        subtitle={<Badge value={p.status} />}
        actions={NEXT[p.status]?.map((s) => (
          <button key={s} disabled={busy} onClick={() => run(() => api(`/v1/programs/${id}/status`, { method: "POST", json: { status: s } })).then(reload)}>
            {s === "active" ? "Activate" : s === "paused" ? "Pause" : "Archive"}
          </button>
        ))}
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>Application page</h2>
          <p className="muted">Share this link anywhere. Applicants accept terms version {p.termsVersion}.</p>
          <CopyBox value={data.joinUrl} />
        </div>
        <div className="card">
          <h2>Offers</h2>
          {offers?.offers?.map((o: any) => (
            <label key={o.id} className="checkbox" style={{ marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={attached.has(o.id)}
                disabled={busy}
                onChange={(e) =>
                  run(() => (e.target.checked ? api(`/v1/programs/${id}/offers`, { method: "POST", json: { offerId: o.id } }) : api(`/v1/programs/${id}/offers/${o.id}`, { method: "DELETE" }))).then(reload)
                }
              />
              {o.name} <Badge value={o.status} />
            </label>
          ))}
        </div>
      </div>
      <TiersCard programId={id} currency={me?.tenant?.currency ?? "USD"} />
      <div className="card">
        <h2>Leads</h2>
        <p className="muted">Pay affiliates a fixed amount per qualified signup, booking or enquiry. Leads arrive through the API, the Leads page, or the capture endpoint below from a form on your own site. A second lead with the same email inside the dedupe window is recorded as a duplicate and earns nothing.</p>
        {leadForm ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await run(
                () =>
                  api(`/v1/programs/${id}`, {
                    method: "PATCH",
                    json: { leadsEnabled: leadForm.leadsEnabled, leadCommissionMinor: Math.round(Number(leadForm.leadCommission || 0) * 100), leadApproval: leadForm.leadApproval, leadDedupeDays: Number(leadForm.leadDedupeDays || 0), reason: reason || undefined },
                  }),
                "Lead settings saved.",
              );
              reload();
            }}
          >
            <label className="checkbox" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={leadForm.leadsEnabled} onChange={(e) => setLeadForm({ ...leadForm, leadsEnabled: e.target.checked })} />
              Accept leads for this program
            </label>
            <div className="row">
              <Field label={`Commission per qualified lead (${me?.tenant?.currency ?? "USD"})`}>
                <input value={leadForm.leadCommission} onChange={(e) => setLeadForm({ ...leadForm, leadCommission: e.target.value })} />
              </Field>
              <Field label="Qualification" help="Manual: review each lead on the Leads page. Auto: every attributed lead is qualified on arrival.">
                <select value={leadForm.leadApproval} onChange={(e) => setLeadForm({ ...leadForm, leadApproval: e.target.value })}>
                  <option value="manual">Manual review</option>
                  <option value="auto">Automatic</option>
                </select>
              </Field>
              <Field label="Dedupe window (days)" help="0 turns duplicate detection off.">
                <input value={leadForm.leadDedupeDays} onChange={(e) => setLeadForm({ ...leadForm, leadDedupeDays: e.target.value })} />
              </Field>
            </div>
            <button className="primary" disabled={busy}>
              Save lead settings
            </button>
          </form>
        ) : null}
        {data.captureUrl ? (
          <div style={{ marginTop: 16 }}>
            <h3>Capture endpoint</h3>
            <p className="muted">Point a form on your site at this URL (POST, JSON or form fields: name, email, phone, company, plus any extra fields). Forward the click token from the <span className="mono">ref</span> query parameter on your landing page so the lead is attributed. Add a <span className="mono">redirect</span> field to send the browser to a thank-you page.</p>
            <CopyBox value={data.captureUrl} />
            <pre className="mono" style={{ fontSize: 12, whiteSpace: "pre-wrap", marginTop: 8 }}>{`<form method="post" action="${data.captureUrl}">
  <input name="name" placeholder="Your name" required>
  <input name="email" type="email" placeholder="Email" required>
  <input name="ref" type="hidden" value="">  <!-- fill from ?ref= on your landing page -->
  <input name="redirect" type="hidden" value="https://yourdomain.com/thanks">
  <button>Get in touch</button>
</form>`}</pre>
          </div>
        ) : null}
      </div>
      <div className="card">
        <h2>Rules</h2>
        <p className="muted">Changes apply to future conversions only. Existing commissions keep the rate they were created with. Editing the terms bumps the version and affiliates must re-accept.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await run(
              () =>
                api(`/v1/programs/${id}`, {
                  method: "PATCH",
                  json: {
                    name: form.name,
                    commissionModel: form.commissionModel,
                    commissionPercent: form.commissionModel === "percentage" ? Number(form.commissionPercent) : undefined,
                    commissionFixedMinor: form.commissionModel === "fixed" ? Math.round(Number(form.commissionFixed) * 100) : undefined,
                    commissionBasis: form.commissionBasis,
                    holdingDays: Number(form.holdingDays),
                    attributionWindowDays: Number(form.attributionWindowDays),
                    approvalMode: form.approvalMode,
                    refundPolicy: form.refundPolicy,
                    precedence: form.precedence,
                    attributionModel: form.attributionModel,
                    termsText: form.termsText,
                    testMode: form.testMode,
                    reason: reason || undefined,
                  },
                }),
              "Rules saved.",
            );
            reload();
          }}
        >
          <div className="row">
            <Field label="Name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Commission model">
              <select value={form.commissionModel} onChange={(e) => setForm({ ...form, commissionModel: e.target.value })}>
                <option value="percentage">Percentage</option>
                <option value="fixed">Fixed</option>
              </select>
            </Field>
            {form.commissionModel === "percentage" ? (
              <Field label="Commission %">
                <input value={form.commissionPercent} onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })} />
              </Field>
            ) : (
              <Field label="Fixed amount">
                <input value={form.commissionFixed} onChange={(e) => setForm({ ...form, commissionFixed: e.target.value })} />
              </Field>
            )}
            <Field label="Commission basis">
              <select value={form.commissionBasis} onChange={(e) => setForm({ ...form, commissionBasis: e.target.value })}>
                <option value="gross">Gross sale</option>
                <option value="net">Net sale</option>
                <option value="eligible">Merchant-defined eligible amount</option>
              </select>
            </Field>
            <Field label="Holding period (days)">
              <input value={form.holdingDays} onChange={(e) => setForm({ ...form, holdingDays: e.target.value })} />
            </Field>
            <Field label="Attribution window (days)">
              <input value={form.attributionWindowDays} onChange={(e) => setForm({ ...form, attributionWindowDays: e.target.value })} />
            </Field>
            <Field label="Attribution model">
              <select value={form.attributionModel} onChange={(e) => setForm({ ...form, attributionModel: e.target.value })}>
                <option value="last_touch">Last eligible touch</option>
                <option value="first_touch">First eligible touch</option>
              </select>
            </Field>
            <Field label="Link vs coupon">
              <select value={form.precedence} onChange={(e) => setForm({ ...form, precedence: e.target.value })}>
                <option value="coupon_wins">Coupon wins</option>
                <option value="link_wins">Link wins</option>
              </select>
            </Field>
            <Field label="Approval">
              <select value={form.approvalMode} onChange={(e) => setForm({ ...form, approvalMode: e.target.value })}>
                <option value="manual">Manual</option>
                <option value="auto">Automatic</option>
                <option value="invite_only">Invite only</option>
              </select>
            </Field>
            <Field label="Refund policy">
              <select value={form.refundPolicy} onChange={(e) => setForm({ ...form, refundPolicy: e.target.value })}>
                <option value="full">Reverse fully</option>
                <option value="partial">Reduce proportionally</option>
                <option value="none">Keep commission</option>
              </select>
            </Field>
          </div>
          <Field label="Terms">
            <textarea value={form.termsText} onChange={(e) => setForm({ ...form, termsText: e.target.value })} />
          </Field>
          <label className="checkbox" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={form.testMode} onChange={(e) => setForm({ ...form, testMode: e.target.checked })} />
            Test mode: track clicks and conversions without creating payable commissions
          </label>
          <Field label="Reason for change (recorded in the audit log)">
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <button className="primary" disabled={busy}>
            Save rules
          </button>
        </form>
      </div>
    </>
  );
}

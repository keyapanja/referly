"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Stat, Table } from "@/components/ui";

const FILTERS = [
  ["pending", "To review"],
  ["qualified", "Qualified"],
  ["disqualified", "Disqualified"],
  ["duplicate", "Duplicates"],
  ["", "All"],
] as const;

export default function LeadsPage() {
  const [filter, setFilter] = useState<string>("pending");
  const { data, error, reload } = useApi<any>(`/v1/leads${filter ? `?disposition=${filter}` : ""}`, [filter]);
  const { data: programs } = useApi<any>("/v1/programs");
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { busy, error: actionError, success, run } = useAction();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", programId: "", affiliateId: "", couponCode: "", reason: "" });
  const leadPrograms = (programs?.programs ?? []).filter((p: any) => p.leadsEnabled);
  const s = data?.summary;

  return (
    <>
      <PageHeader
        title="Leads"
        subtitle="Signups, bookings and enquiries your affiliates sent. Qualify the real ones; their commission then goes into the holding period."
        actions={
          <>
            <div className="segmented">
              {FILTERS.map(([key, label]) => (
                <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
            <button className="primary" onClick={() => setShow(!show)}>
              Record manually
            </button>
          </>
        }
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="To review" value={s?.pending ?? "…"} hint="waiting for a decision" />
        <Stat label="Qualified" value={s?.qualified ?? "…"} hint="commission approved" />
        <Stat label="Disqualified" value={s?.disqualified ?? "…"} hint="spam, wrong number, existing customer" />
        <Stat label="Duplicates" value={s?.duplicate ?? "…"} hint="same email inside the dedupe window" />
      </div>
      {leadPrograms.length === 0 && programs ? (
        <Alert kind="info">
          No program accepts leads yet. Turn on <strong>Leads</strong> on a program to set the commission per qualified lead and get its capture endpoint. <Link href="/app/programs">Programs</Link>
        </Alert>
      ) : null}
      {show && (
        <div className="card">
          <h2>Record a lead</h2>
          <p className="muted">For leads that arrived outside your forms (a phone call, a DM). Attribute by coupon code, or pick the affiliate with a reason (audited).</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(
                () =>
                  api("/v1/leads", {
                    method: "POST",
                    json: {
                      source: "manual",
                      name: form.name || undefined,
                      email: form.email || undefined,
                      phone: form.phone || undefined,
                      company: form.company || undefined,
                      programId: form.programId || undefined,
                      couponCode: form.couponCode || undefined,
                      affiliateId: form.affiliateId || undefined,
                      reason: form.reason || undefined,
                    },
                  }),
                "Lead recorded.",
              );
              if (ok) {
                setShow(false);
                setForm({ name: "", email: "", phone: "", company: "", programId: "", affiliateId: "", couponCode: "", reason: "" });
                reload();
              }
            }}
          >
            <div className="row">
              <Field label="Name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Email">
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label="Phone">
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
              <Field label="Company">
                <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              </Field>
            </div>
            <div className="row">
              <Field label="Program">
                <select value={form.programId} onChange={(e) => setForm({ ...form, programId: e.target.value })}>
                  <option value="">Choose…</option>
                  {leadPrograms.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Coupon code" help="Attributes to the code's affiliate.">
                <input value={form.couponCode} onChange={(e) => setForm({ ...form, couponCode: e.target.value })} />
              </Field>
              <Field label="Or affiliate" help="Manual attribution; needs a reason.">
                <select value={form.affiliateId} onChange={(e) => setForm({ ...form, affiliateId: e.target.value })}>
                  <option value="">None</option>
                  {affiliates?.affiliates?.map((a: any) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason">
                <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required={!!form.affiliateId} />
              </Field>
            </div>
            <button className="primary" disabled={busy}>
              Record lead
            </button>
          </form>
        </div>
      )}
      <div className="card">
        <Table
          rows={data?.leads}
          keyOf={(r: any) => r.lead.id}
          empty={filter === "pending" ? "Nothing to review." : "No leads here."}
          columns={[
            { header: "When", cell: (r: any) => dateTime(r.lead.createdAt) },
            {
              header: "Contact",
              cell: (r: any) =>
                r.lead.erasedAt ? (
                  <span className="muted">details removed by retention</span>
                ) : (
                  <>
                    <strong>{r.lead.name ?? "—"}</strong>
                    <div className="muted">{[r.lead.email, r.lead.phone, r.lead.company].filter(Boolean).join(" · ")}</div>
                    {Object.keys(r.lead.fields ?? {}).length ? <div className="help">{Object.entries(r.lead.fields).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div> : null}
                  </>
                ),
            },
            { header: "Program", cell: (r: any) => r.programName ?? "—" },
            { header: "Affiliate", cell: (r: any) => (r.lead.affiliateId ? <Link href={`/app/affiliates/${r.lead.affiliateId}`}>{r.affiliateName}</Link> : <span className="muted">unattributed</span>) },
            { header: "Commission", cell: (r: any) => (r.commissionMinor != null ? <>{money(r.commissionMinor, r.currency)} <Badge value={r.commissionStatus} /></> : "—") },
            {
              header: "Status",
              cell: (r: any) => (
                <>
                  <Badge value={r.lead.disposition ?? "pending"} />
                  {r.lead.dispositionNote ? <div className="help">{r.lead.dispositionNote}</div> : null}
                </>
              ),
            },
            {
              header: "",
              cell: (r: any) =>
                r.lead.disposition ? null : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="sm primary" disabled={busy} onClick={() => run(() => api(`/v1/leads/${r.lead.id}/qualify`, { method: "POST", json: {} }), "Lead qualified.").then(reload)}>
                      Qualify
                    </button>
                    <button
                      className="sm danger"
                      disabled={busy}
                      onClick={() => {
                        const note = window.prompt("Why is this lead disqualified? (recorded, and the commission is voided)");
                        if (note) run(() => api(`/v1/leads/${r.lead.id}/disqualify`, { method: "POST", json: { note } }), "Lead disqualified.").then(reload);
                      }}
                    >
                      Disqualify
                    </button>
                  </div>
                ),
            },
          ]}
        />
      </div>
    </>
  );
}

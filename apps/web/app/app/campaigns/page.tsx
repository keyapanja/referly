"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { date, money, toMinor } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CampaignsPage() {
  const { data, error, reload } = useApi<any>("/v1/campaigns");
  const { data: programs } = useApi<any>("/v1/programs");
  const { data: me } = useApi<any>("/v1/tenant/me");
  const { busy, error: actionError, run } = useAction();
  const cur = me?.tenant?.currency ?? "USD";
  const [show, setShow] = useState(false);
  const now = new Date();
  const [form, setForm] = useState({
    programId: "",
    name: "",
    description: "",
    startAt: localInput(now),
    endAt: localInput(new Date(now.getTime() + 14 * 86_400_000)),
    overrideType: "none",
    commissionPercent: "",
    commissionFixed: "",
    bonusMetric: "none",
    bonusThreshold: "",
    bonusAmount: "",
  });
  const programId = form.programId || programs?.programs?.[0]?.id || "";

  return (
    <>
      <PageHeader title="Campaigns" subtitle="Time-bound promotions with their own commission, bonus and creative." actions={<button className="primary" onClick={() => setShow(!show)}>New campaign</button>} />
      <Alert kind="error">{error ?? actionError}</Alert>
      {show && (
        <div className="card">
          <h2>New campaign</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() =>
                api("/v1/campaigns", {
                  method: "POST",
                  json: {
                    programId,
                    name: form.name,
                    description: form.description || undefined,
                    startAt: new Date(form.startAt).toISOString(),
                    endAt: new Date(form.endAt).toISOString(),
                    commissionPercent: form.overrideType === "percent" ? Number(form.commissionPercent) : undefined,
                    commissionFixedMinor: form.overrideType === "fixed" ? toMinor(form.commissionFixed) : undefined,
                    bonusRule:
                      form.bonusMetric === "none"
                        ? undefined
                        : { metric: form.bonusMetric, threshold: form.bonusMetric === "revenue" ? toMinor(form.bonusThreshold) : Number(form.bonusThreshold), bonusMinor: toMinor(form.bonusAmount) },
                  },
                }),
              );
              if (ok) {
                setShow(false);
                reload();
              }
            }}
          >
            <div className="row">
              <Field label="Program">
                <select value={programId} onChange={(e) => setForm({ ...form, programId: e.target.value })}>
                  {programs?.programs?.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Spring launch" />
              </Field>
            </div>
            <Field label="Description (shown to affiliates)">
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ minHeight: 60 }} />
            </Field>
            <div className="row">
              <Field label="Starts">
                <input type="datetime-local" value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })} required />
              </Field>
              <Field label="Ends">
                <input type="datetime-local" value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })} required />
              </Field>
            </div>
            <div className="row">
              <Field label="Commission during the campaign" help="Overrides the program rate for participating affiliates while the campaign is live.">
                <select value={form.overrideType} onChange={(e) => setForm({ ...form, overrideType: e.target.value })}>
                  <option value="none">Use program rate</option>
                  <option value="percent">Percentage of sale</option>
                  <option value="fixed">Fixed amount per sale</option>
                </select>
              </Field>
              {form.overrideType === "percent" ? (
                <Field label="Percent">
                  <input type="number" min={0} max={100} step="0.5" value={form.commissionPercent} onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })} required />
                </Field>
              ) : form.overrideType === "fixed" ? (
                <Field label={`Amount (${cur})`}>
                  <input type="number" min={0} step="0.01" value={form.commissionFixed} onChange={(e) => setForm({ ...form, commissionFixed: e.target.value })} required />
                </Field>
              ) : (
                <div />
              )}
            </div>
            <div className="row">
              <Field label="Bonus" help="Paid once per affiliate when they reach the threshold during the campaign.">
                <select value={form.bonusMetric} onChange={(e) => setForm({ ...form, bonusMetric: e.target.value })}>
                  <option value="none">No bonus</option>
                  <option value="conversions">After a number of sales</option>
                  <option value="revenue">After an amount of revenue</option>
                </select>
              </Field>
              {form.bonusMetric !== "none" ? (
                <div className="row">
                  <Field label={form.bonusMetric === "revenue" ? `Revenue threshold (${cur})` : "Sales threshold"}>
                    <input type="number" min={1} value={form.bonusThreshold} onChange={(e) => setForm({ ...form, bonusThreshold: e.target.value })} required />
                  </Field>
                  <Field label={`Bonus (${cur})`}>
                    <input type="number" min={0.01} step="0.01" value={form.bonusAmount} onChange={(e) => setForm({ ...form, bonusAmount: e.target.value })} required />
                  </Field>
                </div>
              ) : (
                <div />
              )}
            </div>
            <button className="primary" disabled={busy || !programId}>
              Create draft
            </button>
          </form>
        </div>
      )}
      <div className="card">
        <Table
          rows={data?.campaigns}
          keyOf={(c: any) => c.id}
          empty="No campaigns yet. Create one to run a launch, a seasonal push or a partner contest."
          columns={[
            { header: "Campaign", cell: (c: any) => <><Link href={`/app/campaigns/${c.id}`}><strong>{c.name}</strong></Link><div className="muted">{c.programName}</div></> },
            { header: "Window", cell: (c: any) => `${date(c.startAt)} – ${date(c.endAt)}` },
            { header: "Status", cell: (c: any) => <><Badge value={c.status} />{c.live ? <span className="muted"> live</span> : null}</> },
            { header: "Participants", cell: (c: any) => `${c.performance.participants.active} / ${c.performance.participants.invited}`, num: true },
            { header: "Sales", cell: (c: any) => c.performance.conversions, num: true },
            { header: "Revenue", cell: (c: any) => money(c.performance.revenueMinor, cur), num: true },
          ]}
        />
      </div>
    </>
  );
}

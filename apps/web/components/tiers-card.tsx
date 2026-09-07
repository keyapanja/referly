"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { money, toMinor } from "@/lib/format";
import { Alert, Field, Table } from "./ui";

/** Program rate tiers (PROG-11): by group or by performance. */
export function TiersCard({ programId, currency }: { programId: string; currency: string }) {
  const { data, error, reload } = useApi<any>(`/v1/programs/${programId}/tiers`);
  const { data: groups } = useApi<any>("/v1/groups");
  const { busy, error: actionError, success, run } = useAction();
  const [form, setForm] = useState({ name: "", kind: "performance", groupId: "", metric: "conversions", threshold: "", windowDays: "", commissionModel: "percentage", commissionPercent: "", commissionFixed: "", priority: "0" });

  const describe = (t: any) => (t.kind === "group" ? `Members of ${t.groupName ?? t.groupId}` : `${t.metric === "revenue" ? money(t.threshold, currency) + " revenue" : t.threshold + " sales"}${t.windowDays ? ` in the last ${t.windowDays} days` : " lifetime"}`);
  const rate = (t: any) => (t.commissionModel === "percentage" ? `${t.commissionRateBps / 100}%` : money(t.commissionFixedMinor, currency));

  return (
    <div className="card">
      <h2>Rate tiers</h2>
      <p className="muted">Group tiers beat performance tiers; an affiliate-specific override beats both; a live campaign beats everything. The tier used is recorded on each commission.</p>
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <Table
        rows={data?.tiers}
        keyOf={(t: any) => t.id}
        empty="No tiers. Everyone gets the program rate."
        columns={[
          { header: "Tier", cell: (t: any) => <strong>{t.name}</strong> },
          { header: "Applies to", cell: (t: any) => describe(t) },
          { header: "Rate", cell: (t: any) => rate(t), num: true },
          { header: "Priority", cell: (t: any) => t.priority, num: true },
          { header: "", cell: (t: any) => <button className="sm danger" disabled={busy} onClick={() => run(() => api(`/v1/programs/${programId}/tiers/${t.id}`, { method: "DELETE" })).then(reload)}>Delete</button> },
        ]}
      />
      <form
        style={{ marginTop: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run(
            () =>
              api(`/v1/programs/${programId}/tiers`, {
                method: "POST",
                json: {
                  name: form.name,
                  kind: form.kind,
                  groupId: form.kind === "group" ? form.groupId : undefined,
                  metric: form.kind === "performance" ? form.metric : undefined,
                  threshold: form.kind === "performance" ? (form.metric === "revenue" ? toMinor(form.threshold) : Number(form.threshold)) : undefined,
                  windowDays: form.kind === "performance" && form.windowDays ? Number(form.windowDays) : undefined,
                  commissionModel: form.commissionModel,
                  commissionPercent: form.commissionModel === "percentage" ? Number(form.commissionPercent) : undefined,
                  commissionFixedMinor: form.commissionModel === "fixed" ? toMinor(form.commissionFixed) : undefined,
                  priority: Number(form.priority || 0),
                },
              }),
            "Tier added.",
          );
          if (ok) {
            setForm({ ...form, name: "", threshold: "", commissionPercent: "", commissionFixed: "" });
            reload();
          }
        }}
      >
        <h3>Add tier</h3>
        <div className="row">
          <Field label="Name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Gold" />
          </Field>
          <Field label="Kind">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="performance">Performance (sales or revenue reached)</option>
              <option value="group">Group membership</option>
            </select>
          </Field>
        </div>
        {form.kind === "group" ? (
          <Field label="Group">
            <select value={form.groupId} onChange={(e) => setForm({ ...form, groupId: e.target.value })} required>
              <option value="">Choose…</option>
              {groups?.groups?.map((g: any) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="row">
            <Field label="Metric">
              <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })}>
                <option value="conversions">Number of sales</option>
                <option value="revenue">Revenue</option>
              </select>
            </Field>
            <Field label={form.metric === "revenue" ? `Threshold (${currency})` : "Threshold (sales)"}>
              <input type="number" min={form.metric === "revenue" ? 0.01 : 1} step={form.metric === "revenue" ? "0.01" : "1"} value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} required />
            </Field>
            <Field label="Rolling window (days, blank = lifetime)">
              <input type="number" min={1} value={form.windowDays} onChange={(e) => setForm({ ...form, windowDays: e.target.value })} />
            </Field>
          </div>
        )}
        <div className="row">
          <Field label="Rate model">
            <select value={form.commissionModel} onChange={(e) => setForm({ ...form, commissionModel: e.target.value })}>
              <option value="percentage">Percentage of sale</option>
              <option value="fixed">Fixed per sale</option>
            </select>
          </Field>
          {form.commissionModel === "percentage" ? (
            <Field label="Percent">
              <input type="number" min={0} max={100} step="0.5" value={form.commissionPercent} onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })} required />
            </Field>
          ) : (
            <Field label={`Amount (${currency})`}>
              <input type="number" min={0} step="0.01" value={form.commissionFixed} onChange={(e) => setForm({ ...form, commissionFixed: e.target.value })} required />
            </Field>
          )}
          <Field label="Priority (group tiers)">
            <input type="number" min={0} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
          </Field>
        </div>
        <button className="sm primary" disabled={busy}>
          Add tier
        </button>
      </form>
    </div>
  );
}

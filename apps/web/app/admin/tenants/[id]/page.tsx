"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Badge, Field, Loading, PageHeader, Table } from "@/components/ui";

const LIMIT_KEYS = ["activeAffiliates", "programs", "teamMembers", "monthlyConversions"] as const;
const LABELS: Record<string, string> = { activeAffiliates: "Active affiliates", programs: "Programs", teamMembers: "Team members", monthlyConversions: "Conversions / month" };

export default function AdminTenantDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<any>(`/admin/tenants/${id}`);
  const { busy, error: actionError, success, run } = useAction();
  const [planId, setPlanId] = useState("starter");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!data) return;
    setPlanId(data.tenant.planId);
    const o: Record<string, string> = {};
    for (const k of LIMIT_KEYS) {
      const v = data.tenant.planLimits?.[k];
      o[k] = v === undefined ? "" : v === null ? "unlimited" : String(v);
    }
    setOverrides(o);
  }, [data]);

  if (!data) return <Loading error={error} />;
  const t = data.tenant;

  async function save() {
    const planLimits: Record<string, number | null> = {};
    for (const k of LIMIT_KEYS) {
      const v = overrides[k]?.trim();
      if (!v) continue;
      planLimits[k] = v === "unlimited" ? null : Number(v);
    }
    const ok = await run(() => api(`/admin/tenants/${id}`, { method: "PATCH", json: { planId, planLimits: Object.keys(planLimits).length ? planLimits : null, reason: reason || undefined } }), "Saved.");
    if (ok) reload();
  }

  return (
    <>
      <PageHeader
        title={t.name}
        subtitle={
          <>
            <span className="mono">{t.slug}</span> · <Badge value={t.status} /> · created {dateTime(t.createdAt)}
          </>
        }
        actions={
          t.status === "active" ? (
            <button className="danger" disabled={busy} onClick={() => run(() => api(`/admin/tenants/${id}`, { method: "PATCH", json: { status: "suspended", reason: "suspended by platform admin" } }), "Workspace suspended.").then(reload)}>
              Suspend workspace
            </button>
          ) : (
            <button className="primary" disabled={busy} onClick={() => run(() => api(`/admin/tenants/${id}`, { method: "PATCH", json: { status: "active", reason: "reactivated by platform admin" } }), "Workspace reactivated.").then(reload)}>
              Reactivate workspace
            </button>
          )
        }
      />
      <Alert kind="error">{actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>Plan and limits</h2>
          <Field label="Plan">
            <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {["starter", "growth", "pro", "enterprise"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <h3>Custom limits</h3>
          <p className="help" style={{ marginBottom: 10 }}>Leave blank to use the plan default. Type “unlimited” to remove a limit.</p>
          {LIMIT_KEYS.map((k) => (
            <Field key={k} label={`${LABELS[k]} (plan default: ${data.plan.limits[k] ?? "unlimited"})`}>
              <input value={overrides[k] ?? ""} onChange={(e) => setOverrides({ ...overrides, [k]: e.target.value })} placeholder="plan default" />
            </Field>
          ))}
          <Field label="Reason (audit)">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. custom enterprise deal" />
          </Field>
          <button className="primary" disabled={busy} onClick={save}>
            Save plan
          </button>
        </div>
        <div>
          <div className="card">
            <h2>Usage</h2>
            <dl className="kv">
              {LIMIT_KEYS.map((k) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{LABELS[k]}</dt>
                  <dd>
                    {data.usage[k]} / {data.limits[k] ?? "unlimited"}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="card">
            <h2>Team</h2>
            <Table
              rows={data.team}
              keyOf={(u: any) => u.id}
              columns={[
                { header: "Name", cell: (u: any) => <>{u.name}<div className="muted">{u.email}</div></> },
                { header: "Role", cell: (u: any) => u.role },
                { header: "Status", cell: (u: any) => <Badge value={u.status} /> },
                { header: "Last login", cell: (u: any) => (u.lastLoginAt ? dateTime(u.lastLoginAt) : "never") },
              ]}
            />
          </div>
        </div>
      </div>
    </>
  );
}

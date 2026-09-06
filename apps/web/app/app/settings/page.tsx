"use client";

import { useEffect, useState } from "react";
import { api, API_URL } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, CopyBox, Field, Loading, PageHeader, Table } from "@/components/ui";

export default function SettingsPage() {
  const { data, error, reload } = useApi<any>("/v1/tenant");
  const { data: team, reload: reloadTeam } = useApi<any>("/v1/tenant/team");
  const { data: audit } = useApi<any>("/v1/tenant/audit?limit=30");
  const { busy, error: actionError, success, run } = useAction();
  const [form, setForm] = useState<any>(null);
  const [member, setMember] = useState({ name: "", email: "", password: "", role: "admin" });
  const [keyName, setKeyName] = useState("Checkout webhook");
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    if (data && !form) {
      const t = data.tenant;
      setForm({ name: t.name, legalName: t.legalName ?? "", website: t.website ?? "", supportEmail: t.supportEmail ?? "", description: t.description ?? "", logoUrl: t.logoUrl ?? "", currency: t.currency, timezone: t.timezone, tone: t.tone, primaryColor: t.branding?.primaryColor ?? "#2f5bea", attributionWindowDays: String(t.defaults?.attributionWindowDays ?? 30), holdingDays: String(t.defaults?.holdingDays ?? 30), payoutThreshold: String((t.defaults?.payoutThresholdMinor ?? 0) / 100), payoutCadence: t.defaults?.payoutCadence ?? "manual" });
    }
  }, [data, form]);

  if (!data || !form) return <Loading error={error} />;

  return (
    <>
      <PageHeader title="Settings" />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>Business and branding</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await run(
                () =>
                  api("/v1/tenant", {
                    method: "PATCH",
                    json: {
                      name: form.name,
                      legalName: form.legalName || null,
                      website: form.website || null,
                      supportEmail: form.supportEmail || null,
                      description: form.description || null,
                      logoUrl: form.logoUrl || null,
                      currency: form.currency,
                      timezone: form.timezone,
                      tone: form.tone,
                      branding: { primaryColor: form.primaryColor },
                      defaults: { attributionWindowDays: Number(form.attributionWindowDays), holdingDays: Number(form.holdingDays), payoutThresholdMinor: Math.round(Number(form.payoutThreshold) * 100), payoutCadence: form.payoutCadence },
                    },
                  }),
                "Settings saved.",
              );
              reload();
            }}
          >
            <div className="row">
              <Field label="Display name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Legal name">
                <input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
              </Field>
              <Field label="Website">
                <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://" />
              </Field>
              <Field label="Support email">
                <input value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} />
              </Field>
              <Field label="Logo URL">
                <input value={form.logoUrl} onChange={(e) => setForm({ ...form, logoUrl: e.target.value })} placeholder="https://" />
              </Field>
              <Field label="Primary colour">
                <input type="color" value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })} />
              </Field>
              <Field label="Currency">
                <input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} maxLength={3} />
              </Field>
              <Field label="Timezone">
                <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
              </Field>
              <Field label="Communication tone" help="Selects default templates. Never generates text.">
                <select value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
                  {["friendly", "professional", "concise", "warm", "formal"].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Field label="Payout cadence">
                <select value={form.payoutCadence} onChange={(e) => setForm({ ...form, payoutCadence: e.target.value })}>
                  {["manual", "weekly", "biweekly", "monthly"].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Field label="Default attribution window (days)">
                <input value={form.attributionWindowDays} onChange={(e) => setForm({ ...form, attributionWindowDays: e.target.value })} />
              </Field>
              <Field label="Default holding period (days)">
                <input value={form.holdingDays} onChange={(e) => setForm({ ...form, holdingDays: e.target.value })} />
              </Field>
              <Field label={`Minimum payout (${form.currency})`}>
                <input value={form.payoutThreshold} onChange={(e) => setForm({ ...form, payoutThreshold: e.target.value })} />
              </Field>
            </div>
            <Field label="Description">
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <button className="primary" disabled={busy}>
              Save
            </button>
          </form>
        </div>
        <div>
          <div className="card">
            <h2>Integrations</h2>
            <p className="muted">Your checkout posts orders to the conversions endpoint with an API key. Repeated posts with the same order id are ignored.</p>
            <CopyBox value={`POST ${API_URL}/v1/conversions`} />
            {secret ? (
              <Alert kind="success">
                Copy this key now, it will not be shown again: <CopyBox value={secret} />
              </Alert>
            ) : null}
            <form
              style={{ marginTop: 12 }}
              onSubmit={async (e) => {
                e.preventDefault();
                const res = await run(() => api<any>("/v1/tenant/api-keys", { method: "POST", json: { name: keyName } }));
                if (res) setSecret(res.secret);
              }}
            >
              <Field label="New API key name">
                <input value={keyName} onChange={(e) => setKeyName(e.target.value)} required />
              </Field>
              <button disabled={busy}>Create API key</button>
            </form>
          </div>
          <div className="card">
            <h2>Team</h2>
            <Table
              rows={team?.users}
              keyOf={(u: any) => u.id}
              columns={[
                { header: "Name", cell: (u: any) => u.name },
                { header: "Email", cell: (u: any) => u.email },
                { header: "Role", cell: (u: any) => u.role },
              ]}
            />
            <form
              style={{ marginTop: 12 }}
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await run(() => api("/v1/tenant/team", { method: "POST", json: member }), "Team member added.");
                if (ok) {
                  setMember({ name: "", email: "", password: "", role: "admin" });
                  reloadTeam();
                }
              }}
            >
              <div className="row">
                <Field label="Name">
                  <input value={member.name} onChange={(e) => setMember({ ...member, name: e.target.value })} required />
                </Field>
                <Field label="Email">
                  <input type="email" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} required />
                </Field>
                <Field label="Temporary password">
                  <input value={member.password} onChange={(e) => setMember({ ...member, password: e.target.value })} minLength={8} required />
                </Field>
                <Field label="Role">
                  <select value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value })}>
                    {["owner", "admin", "marketing", "readonly"].map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <button disabled={busy}>Add member</button>
            </form>
          </div>
        </div>
      </div>
      <div className="card">
        <h2>Recent audit activity</h2>
        <Table
          rows={audit?.entries}
          keyOf={(e: any) => e.id}
          columns={[
            { header: "When", cell: (e: any) => dateTime(e.createdAt) },
            { header: "Entity", cell: (e: any) => `${e.entityType} ${e.entityId.slice(0, 12)}…` },
            { header: "Action", cell: (e: any) => e.action },
            { header: "Actor", cell: (e: any) => e.actorType },
            { header: "Reason", cell: (e: any) => e.reason ?? "—" },
          ]}
        />
      </div>
    </>
  );
}

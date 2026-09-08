"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, API_URL } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Badge, CopyBox, Field, Loading, PageHeader, Table } from "@/components/ui";

export default function SettingsPage() {
  const { data, error, reload } = useApi<any>("/v1/tenant");
  const { data: team, reload: reloadTeam } = useApi<any>("/v1/tenant/team");
  const { data: audit } = useApi<any>("/v1/tenant/audit?limit=30");
  const { data: billing } = useApi<any>("/v1/tenant/billing");
  const { data: integ, reload: reloadInteg } = useApi<any>("/v1/tenant/integrations");
  const [stripeKey, setStripeKey] = useState("");
  const [paypal, setPaypal] = useState({ clientId: "", clientSecret: "", sandbox: true });
  const { data: twilioUrls } = useApi<any>("/v1/tenant/integrations/twilio/webhooks");
  const [twilio, setTwilio] = useState({ accountSid: "", authToken: "", fromSms: "", fromWhatsApp: "" });
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
          <h2>Plan and usage</h2>
          {billing ? (
            <>
              <p className="muted">
                <strong style={{ color: "var(--text)" }}>{billing.plan.name}</strong> · {billing.plan.description}
              </p>
              {(["activeAffiliates", "programs", "teamMembers", "monthlyConversions"] as const).map((key) => {
                const limit = billing.limits[key];
                const used = billing.usage[key];
                const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
                const label = { activeAffiliates: "Active affiliates", programs: "Programs", teamMembers: "Team members", monthlyConversions: "Tracked conversions this month" }[key];
                return (
                  <div key={key} className="usage">
                    <div className="usage-row">
                      <span>{label}</span>
                      <span className="muted">
                        {used} / {limit ?? "unlimited"}
                      </span>
                    </div>
                    <div className="bar">
                      <div className={`fill ${pct >= 100 ? "over" : pct >= 90 ? "near" : ""}`} style={{ width: `${limit ? pct : 5}%` }} />
                    </div>
                  </div>
                );
              })}
              <p className="help" style={{ marginTop: 12 }}>
                Affiliates, programs and team members are hard limits. Tracked conversions are never rejected; going over is flagged here and on Home.
                {billing.supportEmail ? (
                  <>
                    {" "}
                    To change your plan, email <a href={`mailto:${billing.supportEmail}`}>{billing.supportEmail}</a>.
                  </>
                ) : (
                  " To change your plan, contact your platform administrator."
                )}
              </p>
            </>
          ) : (
            <div className="empty">Loading…</div>
          )}
        </div>
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
            <p className="muted">Your checkout posts orders to the conversions endpoint with an API key. Repeated posts with the same order id are ignored. To push events out to Zapier, Make or your own systems, see <Link href="/app/webhooks">Webhooks</Link>.</p>
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
            <h2>Payout providers</h2>
            <p className="muted">Pay affiliates automatically. Credentials are verified with the provider and stored encrypted; only a hint is shown afterwards. Manual payouts keep working alongside.</p>
            {(["stripe_connect", "paypal"] as const).map((provider) => {
              const row = integ?.integrations?.find((i: any) => i.provider === provider);
              const label = provider === "stripe_connect" ? "Stripe Connect" : "PayPal Payouts";
              return (
                <div key={provider} style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div>
                      <strong>{label}</strong> {row ? <Badge value="connected" /> : <Badge value="disabled" />}
                      {row ? <div className="muted mono">{row.hint}</div> : <div className="muted">{provider === "stripe_connect" ? "Transfers to affiliates' connected Stripe accounts." : "Sends payouts to affiliates' PayPal email addresses."}</div>}
                    </div>
                    {row ? (
                      <button className="sm danger" disabled={busy} onClick={() => run(() => api(`/v1/tenant/integrations/${provider}`, { method: "DELETE" }), "Disconnected.").then(reloadInteg)}>
                        Disconnect
                      </button>
                    ) : null}
                  </div>
                  {!row ? (
                    <form
                      style={{ marginTop: 10 }}
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const credentials = provider === "stripe_connect" ? { secretKey: stripeKey } : paypal;
                        const ok = await run(() => api(`/v1/tenant/integrations/${provider}`, { method: "POST", json: { credentials } }), `${label} connected.`);
                        if (ok) {
                          setStripeKey("");
                          setPaypal({ clientId: "", clientSecret: "", sandbox: true });
                          reloadInteg();
                        }
                      }}
                    >
                      {provider === "stripe_connect" ? (
                        <Field label="Stripe secret key" help="From the Stripe dashboard (Developers → API keys). Restricted keys with transfer and account permissions also work.">
                          <input type="password" value={stripeKey} onChange={(e) => setStripeKey(e.target.value)} placeholder="sk_live_…" required />
                        </Field>
                      ) : (
                        <>
                          <div className="row">
                            <Field label="Client ID">
                              <input value={paypal.clientId} onChange={(e) => setPaypal({ ...paypal, clientId: e.target.value })} required />
                            </Field>
                            <Field label="Client secret">
                              <input type="password" value={paypal.clientSecret} onChange={(e) => setPaypal({ ...paypal, clientSecret: e.target.value })} required />
                            </Field>
                          </div>
                          <label className="checkbox" style={{ marginBottom: 10 }}>
                            <input type="checkbox" checked={paypal.sandbox} onChange={(e) => setPaypal({ ...paypal, sandbox: e.target.checked })} /> Sandbox account
                          </label>
                        </>
                      )}
                      <button className="sm" disabled={busy}>
                        Connect {label}
                      </button>
                    </form>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="card">
            <h2>SMS and WhatsApp</h2>
            <p className="muted">Affiliates who opt in from their portal get a short text alongside each notification email. Connect your own Twilio account; WhatsApp needs a WhatsApp-enabled sender, and messages sent outside a 24-hour conversation must match a template approved by Meta.</p>
            {(() => {
              const row = integ?.integrations?.find((i: any) => i.provider === "twilio");
              return (
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div>
                      <strong>Twilio</strong> {row ? <Badge value="connected" /> : <Badge value="disabled" />}
                      {row ? <div className="muted mono">{row.hint}</div> : <div className="muted">Sends SMS and WhatsApp through your Twilio account.</div>}
                    </div>
                    {row ? (
                      <button className="sm danger" disabled={busy} onClick={() => run(() => api("/v1/tenant/integrations/twilio", { method: "DELETE" }), "Disconnected.").then(reloadInteg)}>
                        Disconnect
                      </button>
                    ) : null}
                  </div>
                  {row ? (
                    <div style={{ marginTop: 10 }}>
                      <p className="muted" style={{ marginBottom: 6 }}>In the Twilio console, point your sender's messaging webhook at the inbound URL (so STOP and START are honoured) and use the status URL as the status callback.</p>
                      <Field label="Inbound message URL">
                        <CopyBox value={twilioUrls?.inboundUrl ?? ""} />
                      </Field>
                      <Field label="Status callback URL">
                        <CopyBox value={twilioUrls?.statusUrl ?? ""} />
                      </Field>
                    </div>
                  ) : (
                    <form
                      style={{ marginTop: 10 }}
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const credentials: Record<string, string> = { accountSid: twilio.accountSid.trim(), authToken: twilio.authToken.trim() };
                        if (twilio.fromSms.trim()) credentials.fromSms = twilio.fromSms.trim();
                        if (twilio.fromWhatsApp.trim()) credentials.fromWhatsApp = twilio.fromWhatsApp.trim();
                        const ok = await run(() => api("/v1/tenant/integrations/twilio", { method: "POST", json: { credentials } }), "Twilio connected.");
                        if (ok) {
                          setTwilio({ accountSid: "", authToken: "", fromSms: "", fromWhatsApp: "" });
                          reloadInteg();
                        }
                      }}
                    >
                      <div className="row">
                        <Field label="Account SID">
                          <input value={twilio.accountSid} onChange={(e) => setTwilio({ ...twilio, accountSid: e.target.value })} placeholder="AC…" required />
                        </Field>
                        <Field label="Auth token">
                          <input type="password" value={twilio.authToken} onChange={(e) => setTwilio({ ...twilio, authToken: e.target.value })} required />
                        </Field>
                      </div>
                      <div className="row">
                        <Field label="SMS sender" help="An E.164 number (+14155550100) or a Messaging Service SID (MG…).">
                          <input value={twilio.fromSms} onChange={(e) => setTwilio({ ...twilio, fromSms: e.target.value })} placeholder="+1…" />
                        </Field>
                        <Field label="WhatsApp sender" help="Your WhatsApp-enabled number, E.164.">
                          <input value={twilio.fromWhatsApp} onChange={(e) => setTwilio({ ...twilio, fromWhatsApp: e.target.value })} placeholder="+1…" />
                        </Field>
                      </div>
                      <button className="sm" disabled={busy}>
                        Connect Twilio
                      </button>
                    </form>
                  )}
                </div>
              );
            })()}
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

"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Alert, Field, Loading, PageHeader } from "@/components/ui";

export default function PortalProfile() {
  const { data, error, reload } = useApi<any>("/portal/me");
  const { busy, error: actionError, success, run } = useAction();
  const [form, setForm] = useState<any>(null);
  const [payout, setPayout] = useState({ method: "bank_transfer", profileRef: "", masked: "" });
  const [texts, setTexts] = useState<{ channel: string; consent: boolean } | null>(null);

  useEffect(() => {
    if (data && !form) setForm({ name: data.affiliate.name, phone: data.affiliate.phone ?? "", company: data.affiliate.company ?? "", website: data.affiliate.channels?.website ?? "", social: data.affiliate.channels?.social ?? "" });
    if (data && !texts) setTexts({ channel: data.affiliate.textChannel ?? "", consent: false });
  }, [data, form, texts]);
  const optedOut = !!data?.affiliate?.textOptOutAt && (!data?.affiliate?.textConsentAt || data.affiliate.textOptOutAt >= data.affiliate.textConsentAt);
  const textsOn = !!data?.affiliate?.textChannel && !!data?.affiliate?.textConsentAt && !optedOut;
  if (!data || !form) return <Loading error={error} />;

  return (
    <>
      <PageHeader title="Profile" />
      <Alert kind="error">{actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>Your details</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await run(() => api("/portal/profile", { method: "PATCH", json: { name: form.name, phone: form.phone || null, company: form.company || null, channels: { website: form.website, social: form.social } } }), "Profile saved.");
              reload();
            }}
          >
            <Field label="Name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label="Email">
              <input value={data.affiliate.email} disabled />
            </Field>
            <div className="row">
              <Field label="Phone">
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
              <Field label="Company">
                <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              </Field>
              <Field label="Website">
                <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
              </Field>
              <Field label="Main social profile">
                <input value={form.social} onChange={(e) => setForm({ ...form, social: e.target.value })} />
              </Field>
            </div>
            <button className="primary" disabled={busy}>
              Save
            </button>
          </form>
        </div>
        <div className="card">
          <h2>Payout details</h2>
          <p className="muted">
            {data.affiliate.payoutMethod ? `Current: ${data.affiliate.payoutMethod.replace("_", " ")} · ${data.affiliate.payoutDetailsMasked ?? ""}` : "Not set yet."} We store a reference from your payment provider, never full account numbers.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api("/portal/payout-profile", { method: "PUT", json: payout }), "Payout details saved.");
              if (ok) reload();
            }}
          >
            <Field label="Method">
              <select value={payout.method} onChange={(e) => setPayout({ ...payout, method: e.target.value })}>
                <option value="bank_transfer">Bank transfer</option>
                <option value="paypal">PayPal</option>
                <option value="stripe_connect">Stripe Connect</option>
                <option value="upi">UPI</option>
                <option value="other">Other</option>
              </select>
            </Field>
            <Field label="Provider reference" help="e.g. PayPal email, UPI ID, or the reference your merchant gave you.">
              <input value={payout.profileRef} onChange={(e) => setPayout({ ...payout, profileRef: e.target.value })} required />
            </Field>
            <Field label="Display label" help="Shown on statements, e.g. 'HDFC ••••1234'.">
              <input value={payout.masked} onChange={(e) => setPayout({ ...payout, masked: e.target.value })} required maxLength={60} />
            </Field>
            <button className="primary" disabled={busy}>
              Save payout details
            </button>
          </form>
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Text notifications</h2>
          <p className="muted">
            {textsOn
              ? `You get ${data.affiliate.textChannel === "whatsapp" ? "WhatsApp" : "SMS"} messages at ${data.affiliate.phone} for approvals, sales, commissions and payouts, as well as email.`
              : optedOut
                ? "You opted out of text messages. You can opt back in below."
                : "Email is always sent. Optionally get a short SMS or WhatsApp message too."}
          </p>
          {texts ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const json: Record<string, unknown> = texts.channel ? { phone: form.phone || null, textChannel: texts.channel, textConsent: true } : { textChannel: null };
                const ok = await run(() => api("/portal/profile", { method: "PATCH", json }), texts.channel ? "Text notifications on." : "Text notifications off.");
                if (ok) {
                  setTexts(null);
                  reload();
                }
              }}
            >
              <div className="row">
                <Field label="Channel">
                  <select value={texts.channel} onChange={(e) => setTexts({ ...texts, channel: e.target.value, consent: false })}>
                    <option value="">Email only</option>
                    <option value="sms">SMS</option>
                    <option value="whatsapp">WhatsApp</option>
                  </select>
                </Field>
                <Field label="Phone (international format)" help="e.g. +1 415 555 0100">
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+…" disabled={!texts.channel} />
                </Field>
              </div>
              {texts.channel ? (
                <label className="checkbox" style={{ marginBottom: 12 }}>
                  <input type="checkbox" checked={texts.consent} onChange={(e) => setTexts({ ...texts, consent: e.target.checked })} required /> I agree to receive {texts.channel === "whatsapp" ? "WhatsApp" : "SMS"} messages from {data.tenant?.name ?? "this business"} about my affiliate account. Reply STOP at any time to opt out.
                </label>
              ) : null}
              <button className="primary" disabled={busy || (!!texts.channel && !texts.consent)}>
                {texts.channel ? "Turn on text notifications" : "Save"}
              </button>
            </form>
          ) : null}
        </div>
      </div>
      <div className="card">
        <h2>Programs and terms</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {data.memberships.map((m: any) => (
            <li key={m.programId}>
              {m.programId} · {m.status} · accepted terms v{m.termsVersion}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

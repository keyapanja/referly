"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { api, setSignedInHint } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { money } from "@/lib/format";
import { Alert, Field, Loading } from "@/components/ui";
import { AuthBrand } from "@/components/shell";
import { brandStyle } from "@/lib/brand";

/** Branded application page (journey C). */
export default function JoinPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { data, error } = useApi<any>(`/join/${token}`);
  const { busy, error: actionError, run } = useAction();
  const [form, setForm] = useState({ name: "", email: "", password: "", website: "", audience: "", acceptTerms: false });
  const [done, setDone] = useState<any>(null);
  if (!data) return <Loading error={error ? "This application page is not available." : null} />;
  const p = data.program;

  return (
    <div className="center wide branded" style={brandStyle(data.tenant.branding?.primaryColor)}>
      <div className="card">
        {data.tenant.logoUrl ? <img src={data.tenant.logoUrl} alt="" style={{ maxHeight: 48, marginBottom: 16 }} /> : <AuthBrand name={data.tenant.name} subtitle="Partner program" />}
        <h1>Become a {data.tenant.name} partner</h1>
        <p className="muted">{p.description ?? `Promote ${data.tenant.name} and earn commission on every sale you refer.`}</p>
        <div className="grid cols-3" style={{ margin: "16px 0" }}>
          <div className="stat">
            <div className="label">You earn</div>
            <div className="value">{p.commissionModel === "percentage" ? `${p.commissionPercent}%` : money(p.commissionFixedMinor, data.tenant.currency)}</div>
            <div className="hint">per sale</div>
          </div>
          <div className="stat">
            <div className="label">Tracking window</div>
            <div className="value">{p.attributionWindowDays} days</div>
            <div className="hint">after a click</div>
          </div>
          <div className="stat">
            <div className="label">Paid after</div>
            <div className="value">{p.holdingDays} days</div>
            <div className="hint">holding period</div>
          </div>
        </div>
        {data.offers.length ? (
          <>
            <h2>What you'll promote</h2>
            <ul>
              {data.offers.map((o: any) => (
                <li key={o.id}>
                  <strong>{o.name}</strong> · {money(o.priceMinor, o.currency)} {o.shortDescription ? <span className="muted">— {o.shortDescription}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {done ? (
          <Alert kind="success">
            {done.affiliate.status === "active" ? (
              <>
                You're in! <Link href="/portal">Open your portal</Link>.
              </>
            ) : (
              <>Thanks, your application is in review. You'll get an email when it's approved, then sign in at <Link href="/login?portal=1">the partner portal</Link>.</>
            )}
          </Alert>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const res = await run(() =>
                api<any>(`/join/${token}/apply`, { method: "POST", token: null, json: { name: form.name, email: form.email, password: form.password, channels: { website: form.website }, answers: { audience: form.audience }, acceptTerms: form.acceptTerms } }),
              );
              if (!res) return;
              setDone(res);
              if (res.token) {
                setSignedInHint(true);
                router.push("/portal");
              }
            }}
          >
            <h2>Apply</h2>
            <Alert kind="error">{actionError}</Alert>
            <div className="row">
              <Field label="Your name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </Field>
              <Field label="Email">
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </Field>
              <Field label="Choose a password">
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={8} required />
              </Field>
              <Field label="Website or main channel">
                <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
              </Field>
            </div>
            <Field label="Tell us about your audience">
              <textarea value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} />
            </Field>
            <details style={{ marginBottom: 12 }}>
              <summary>Program terms (v{p.termsVersion})</summary>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{p.termsText || "No additional terms."}</pre>
            </details>
            <label className="checkbox" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={form.acceptTerms} onChange={(e) => setForm({ ...form, acceptTerms: e.target.checked })} required /> I accept the program terms
            </label>
            <button className="primary" disabled={busy || !form.acceptTerms}>
              {p.approvalMode === "auto" ? "Join now" : "Submit application"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

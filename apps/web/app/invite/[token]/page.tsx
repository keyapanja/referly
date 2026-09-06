"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { api, setToken } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { money } from "@/lib/format";
import { Alert, Field, Loading } from "@/components/ui";
import { AuthBrand } from "@/components/shell";

/** Invitation acceptance (journey B). */
export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { data, error } = useApi<any>(`/invite/${token}`);
  const { busy, error: actionError, run } = useAction();
  const [form, setForm] = useState({ name: "", password: "", acceptTerms: false });
  if (!data) return <Loading error={error ? "This invitation is not valid." : null} />;
  const p = data.program;
  const expired = data.invite.status !== "sent" || new Date(data.invite.expiresAt) < new Date();

  return (
    <div className="center" style={{ ["--primary" as string]: data.tenant.branding?.primaryColor ?? "#2f5bea" }}>
      <div className="card">
        {data.tenant.logoUrl ? <img src={data.tenant.logoUrl} alt="" style={{ maxHeight: 48, marginBottom: 16 }} /> : <AuthBrand name={data.tenant.name} subtitle="Invitation" />}
        <h1>{data.tenant.name} invited you to {p.name}</h1>
        <p className="muted">
          Earn {p.commissionModel === "percentage" ? `${p.commissionPercent}%` : money(p.commissionFixedMinor, data.tenant.currency)} on every sale you refer.
        </p>
        {expired ? (
          <Alert kind="error">This invitation has already been used or has expired. Ask {data.tenant.name} for a new one.</Alert>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const res = await run(() => api<any>(`/invite/${token}/accept`, { method: "POST", token: null, json: { name: form.name || data.invite.name || "", password: form.password, acceptTerms: form.acceptTerms } }));
              if (!res) return;
              setToken(res.token);
              router.push("/portal");
            }}
          >
            <Alert kind="error">{actionError}</Alert>
            <Field label="Email">
              <input value={data.invite.email} disabled />
            </Field>
            <Field label="Your name">
              <input value={form.name || data.invite.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label="Choose a password">
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={8} required />
            </Field>
            <details style={{ marginBottom: 12 }}>
              <summary>Program terms (v{p.termsVersion})</summary>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{p.termsText || "No additional terms."}</pre>
            </details>
            <label className="checkbox" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={form.acceptTerms} onChange={(e) => setForm({ ...form, acceptTerms: e.target.checked })} required /> I accept the program terms
            </label>
            <button className="primary" disabled={busy || !form.acceptTerms}>
              Accept and open my portal
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

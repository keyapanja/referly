"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { Alert, Field } from "@/components/ui";
import { AuthBrand } from "@/components/shell";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <div className="center">
      <div className="card">
        <AuthBrand subtitle="Account recovery" />
        <h1>Reset your password</h1>
        <p className="muted">Enter your email and we'll send a link to choose a new password.</p>
        <Alert kind="error">{error}</Alert>
        {sent ? (
          <Alert kind="success">If an account exists for {email}, a reset link is on its way. It expires in one hour.</Alert>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api("/v1/auth/forgot-password", { method: "POST", token: null, json: { email } }));
              if (ok) setSent(true);
            }}
          >
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <button className="primary" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
        <p className="footnote">
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, setToken } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { Alert, Field } from "@/components/ui";
import { AuthBrand } from "@/components/shell";

function ResetInner() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, run, setError } = useAction();
  return (
    <div className="center">
      <div className="card">
        <AuthBrand subtitle="Account recovery" />
        <h1>Choose a new password</h1>
        <Alert kind="error">{error}</Alert>
        {done ? (
          <>
            <Alert kind="success">Password updated. Sign in with your new password.</Alert>
            <Link className="btn primary" href="/login">
              Sign in
            </Link>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (password !== confirm) return setError("Passwords do not match.");
              const ok = await run(() => api("/v1/auth/reset-password", { method: "POST", token: null, json: { token, password } }));
              if (ok) {
                setToken(null);
                setDone(true);
                setTimeout(() => router.push("/login"), 1500);
              }
            }}
          >
            <Field label="New password" help="At least 8 characters.">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus />
            </Field>
            <Field label="Confirm password">
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
            </Field>
            <button className="primary" disabled={busy || !token}>
              {busy ? "Saving…" : "Set password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetInner />
    </Suspense>
  );
}

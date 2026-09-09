"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, setSignedInHint } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { Alert, Field, PasswordInput } from "@/components/ui";
import { AuthBrand } from "@/components/shell";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const portal = params.get("portal") === "1";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();

  return (
    <div className="center">
      <div className="card">
        <AuthBrand subtitle={portal ? "Partner portal" : "Merchant workspace"} />
        <h1>{portal ? "Welcome back" : "Sign in"}</h1>
        <p className="muted">{portal ? "Access your links, earnings and payouts." : "Manage your affiliate program."}</p>
        <Alert kind="error">{error}</Alert>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await run(() => api<any>("/v1/auth/login", { method: "POST", json: { email, password }, token: null }));
            if (!res) return;
            setSignedInHint(true);
            router.replace(res.user.role === "affiliate" ? "/portal" : res.user.role === "platform_admin" ? "/admin" : "/app");
          }}
        >
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password">
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required />
            <div className="help" style={{ textAlign: "right" }}>
              <Link href="/forgot-password">Forgot password?</Link>
            </div>
          </Field>
          <button className="primary" disabled={busy} type="submit">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {!portal ? (
          <p className="footnote">
            New business? <Link href="/signup">Create your workspace</Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

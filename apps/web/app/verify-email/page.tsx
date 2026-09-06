"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Alert } from "@/components/ui";
import { AuthBrand } from "@/components/shell";

function VerifyInner() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!token) {
      setState("error");
      setMessage("This link is missing its token.");
      return;
    }
    api("/v1/auth/verify-email", { method: "POST", token: null, json: { token } })
      .then(() => setState("ok"))
      .catch((e: Error) => {
        setState("error");
        setMessage(e.message);
      });
  }, [token]);
  return (
    <div className="center">
      <div className="card">
        <AuthBrand subtitle="Email verification" />
        {state === "working" ? <p className="muted">Verifying…</p> : null}
        {state === "ok" ? (
          <>
            <h1>Email verified</h1>
            <p className="muted">Thanks, your address is confirmed.</p>
            <Link className="btn primary" href="/app">
              Continue to your workspace
            </Link>
          </>
        ) : null}
        {state === "error" ? (
          <>
            <h1>Link not valid</h1>
            <Alert kind="error">{message}</Alert>
            <p className="muted">Sign in and use “Resend verification” from the banner to get a fresh link.</p>
            <Link className="btn" href="/login">
              Sign in
            </Link>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyInner />
    </Suspense>
  );
}

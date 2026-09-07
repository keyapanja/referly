"use client";

import Link from "next/link";
import { useAction, useApi } from "@/lib/hooks";
import { api } from "@/lib/api";
import { dateTime, money } from "@/lib/format";
import { Alert, Badge, PageHeader, Table } from "@/components/ui";

export default function PortalPayouts() {
  const { data } = useApi<any>("/portal/payouts");
  const { data: me, reload: reloadMe } = useApi<any>("/portal/me");
  const { busy, error, run } = useAction();
  const stripeAvailable = data?.automatedMethods?.includes("stripe_connect");
  const paypalAvailable = data?.automatedMethods?.includes("paypal");
  return (
    <>
      <Alert kind="error">{error}</Alert>
      {stripeAvailable || paypalAvailable ? (
        <div className="card">
          <h2>Get paid automatically</h2>
          <p className="muted">
            {stripeAvailable ? "Connect a Stripe account and payouts land there as soon as the merchant sends them." : ""} {paypalAvailable ? "Or set PayPal as your payout method in your profile to be paid to your PayPal email." : ""}
          </p>
          {stripeAvailable ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await api<any>("/portal/payouts/connect/stripe", { method: "POST" });
                  window.location.href = r.url;
                  return r;
                }).then(reloadMe)
              }
            >
              {me?.affiliate?.payoutMethod === "stripe_connect" ? "Update Stripe account" : "Connect with Stripe"}
            </button>
          ) : null}
        </div>
      ) : null}
      <PageHeader title="Payouts" subtitle={me?.affiliate?.payoutMethod ? `Paid via ${me.affiliate.payoutMethod.replace("_", " ")} · ${me.affiliate.payoutDetailsMasked ?? ""}` : <>No payout method yet. <Link href="/portal/profile">Add one</Link>.</>} />
      <div className="card">
        <Table
          rows={data?.payouts}
          keyOf={(p: any) => p.id}
          empty="No payouts yet."
          columns={[
            { header: "Created", cell: (p: any) => dateTime(p.createdAt) },
            { header: "Amount", cell: (p: any) => money(p.amountMinor, p.currency), num: true },
            { header: "Method", cell: (p: any) => p.method ?? "—" },
            { header: "Reference", cell: (p: any) => <span className="mono">{p.externalReference ?? p.providerRef ?? "—"}</span> },
            { header: "Paid", cell: (p: any) => dateTime(p.paidAt) },
            { header: "Status", cell: (p: any) => <Badge value={p.status} /> },
          ]}
        />
      </div>
    </>
  );
}

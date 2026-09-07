"use client";

import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { money } from "@/lib/format";
import { Alert, CopyBox, Loading, PageHeader } from "@/components/ui";

export default function PortalOffers() {
  const { data, error } = useApi<any>("/portal/offers");
  const { data: links, reload } = useApi<any>("/portal/links");
  const { busy, error: actionError, run } = useAction();
  if (!data) return <Loading error={error} />;
  const linkFor = (offerId: string, programId: string) => links?.links?.find((l: any) => l.offerId === offerId && l.programId === programId && !l.label);

  return (
    <>
      <PageHeader title="Offers" subtitle="Everything you're eligible to promote, with your commission." />
      <Alert kind="error">{actionError}</Alert>
      {data.offers.length === 0 ? <div className="card empty">No active offers yet.</div> : null}
      <div className="grid cols-2">
        {data.offers.map((o: any) => {
          const program = data.programs.find((p: any) => p.id === o.programId);
          const link = linkFor(o.id, o.programId);
          return (
            <div className="card" key={`${o.id}:${o.programId}`}>
              {o.imageUrl ? <img src={o.imageUrl} alt="" style={{ maxHeight: 140, borderRadius: 8, marginBottom: 10 }} /> : null}
              <h2>{o.name}</h2>
              <p className="muted">{o.shortDescription}</p>
              <dl className="kv" style={{ marginBottom: 12 }}>
                <dt>Price</dt>
                <dd>{money(o.priceMinor, o.currency)}</dd>
                <dt>You earn</dt>
                <dd>
                  {program?.effective ? (program.effective.model === "percentage" ? `${program.effective.percent}% per sale` : `${money(program.effective.fixedMinor ?? 0, o.currency)} per sale`) : program?.commissionModel === "percentage" ? `${program.commissionPercent}% per sale` : `${money(program?.commissionFixedMinor ?? 0, o.currency)} per sale`}
                  {program?.effective?.tierName ? <span className="muted"> · {program.effective.tierName} tier</span> : program?.effective?.source === "affiliate_program" ? <span className="muted"> · your negotiated rate</span> : null}
                  {program?.tier?.next ? (
                    <div className="help">
                      {program.tier.next.metric === "revenue" ? money(program.tier.next.remaining, o.currency) + " more in sales" : `${program.tier.next.remaining} more sale${program.tier.next.remaining === 1 ? "" : "s"}`} to reach {program.tier.next.name}
                      {program.tier.next.windowDays ? ` (rolling ${program.tier.next.windowDays} days)` : ""}
                    </div>
                  ) : null}
                </dd>
                <dt>Paid after</dt>
                <dd>{program?.holdingDays} days</dd>
                <dt>Program</dt>
                <dd>{program?.name}</dd>
              </dl>
              {link ? (
                <CopyBox value={link.url} />
              ) : (
                <button className="primary" disabled={busy} onClick={() => run(() => api("/portal/links", { method: "POST", json: { programId: o.programId, offerId: o.id } })).then(reload)}>
                  Get my link
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

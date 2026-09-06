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
                <dd>{program?.commissionModel === "percentage" ? `${program.commissionPercent}% per sale` : `${money(program?.commissionFixedMinor ?? 0, o.currency)} per sale`}</dd>
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

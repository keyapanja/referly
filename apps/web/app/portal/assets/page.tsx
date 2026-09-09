"use client";

import { useApi } from "@/lib/hooks";
import { Badge, CopyBox, Loading, PageHeader } from "@/components/ui";

const IMAGE_TYPES = new Set(["image", "banner"]);

export default function PortalAssets() {
  const { data, error } = useApi<any>("/portal/assets");
  if (!data) return <Loading error={error} />;
  return (
    <>
      <PageHeader title="Assets" subtitle="Approved creative, copy and guidelines. Use these as-is so your promotion stays on-brand." />
      {data.assets.length === 0 ? <div className="card empty">Nothing shared with you yet.</div> : null}
      <div className="grid cols-2">
        {data.assets.map((a: any) => (
          <div className="card" key={a.id}>
            {IMAGE_TYPES.has(a.type) && a.url ? <img src={a.url} alt={a.title} style={{ width: "100%", borderRadius: 8, marginBottom: 12, border: "1px solid var(--border)" }} /> : null}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>{a.title}</h2>
              <Badge value={a.type} />
            </div>
            {a.body ? (
              <>
                <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: "0 0 10px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>{a.renderedBody ?? a.body}</pre>
                {a.variablesUsed?.length ? <p className="help" style={{ margin: "0 0 8px" }}>Personalised for you: it already carries your {a.variablesUsed.includes("link") ? "tracking link" : "details"}{a.variablesUsed.includes("coupon_code") ? " and coupon code" : ""}. Paste it as-is.</p> : null}
                <CopyBox value={a.renderedBody ?? a.body} />
              </>
            ) : null}
            {a.url ? (
              <div className="actions" style={{ marginTop: 4 }}>
                <a className="btn" href={a.url} target="_blank" rel="noreferrer">
                  Open / download
                </a>
                <CopyBox value={a.url} />
              </div>
            ) : null}
            {a.usageInstructions ? (
              <p className="help" style={{ marginTop: 12 }}>
                <strong>How to use:</strong> {a.usageInstructions}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { api, API_URL } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Badge, Field, Table } from "@/components/ui";

const CATEGORIES = ["clicksDays", "messageLogsDays", "auditLogsDays", "webhookDeliveriesDays", "automationRunsDays", "notificationsDays"] as const;

/**
 * Settings → Data: how long operational records are kept (per category, within platform
 * bounds), what the next nightly prune would delete, and a full workspace export for data
 * portability. Financial records are never pruned.
 */
export function DataRetentionCard() {
  const { data, error, reload } = useApi<any>("/v1/tenant/retention");
  const { data: exportsData, reload: reloadExports } = useApi<any>("/v1/analytics/exports");
  const { busy, error: actionError, success, run } = useAction();
  const [form, setForm] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (data && !form) {
      const f: Record<string, string> = {};
      for (const c of CATEGORIES) f[c] = data.overrides[c] === undefined ? "" : String(data.overrides[c]);
      setForm(f);
    }
  }, [data, form]);

  const workspaceExports = (exportsData?.exports ?? []).filter((e: any) => e.entity === "workspace");
  const pending = workspaceExports.some((e: any) => e.status === "queued" || e.status === "running");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(reloadExports, 2000);
    return () => clearInterval(t);
  }, [pending, reloadExports]);

  async function download(exp: any) {
    const res = await fetch(`${API_URL}/v1/analytics/exports/${exp.id}/download`, { credentials: "include" });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `workspace-${String(exp.createdAt).slice(0, 10)}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!data || !form) return null;

  return (
    <div className="card">
      <h2>Data retention and requests</h2>
      <p className="muted">
        Operational records are deleted once they age out, per category, every night. Leave a field blank to use the platform default. Conversions, commissions, ledger entries and payouts are never deleted; clicks that an attribution points at are kept with it.
      </p>
      {error || actionError ? <p className="error">{error ?? actionError}</p> : null}
      {success ? <p className="success">{success}</p> : null}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const json: Record<string, number | null> = {};
          for (const c of CATEGORIES) json[c] = form[c]?.trim() === "" ? null : Number(form[c]);
          const ok = await run(() => api("/v1/tenant/retention", { method: "PATCH", json }), "Retention policy saved.");
          if (ok) {
            setForm(null);
            reload();
          }
        }}
      >
        <div className="grid cols-2">
          {CATEGORIES.map((c) => (
            <Field key={c} label={data.labels[c]} help={`Default ${data.defaults[c]} days · allowed ${data.bounds[c][0]}–${data.bounds[c][1]} · ${data.eligible[c]} row${data.eligible[c] === 1 ? "" : "s"} due for deletion at the next run`}>
              <input type="number" min={data.bounds[c][0]} max={data.bounds[c][1]} value={form[c]} placeholder={`${data.defaults[c]} days`} onChange={(e) => setForm({ ...form, [c]: e.target.value })} />
            </Field>
          ))}
        </div>
        <button disabled={busy}>Save retention policy</button>
      </form>
      <h3 style={{ marginTop: 20 }}>Export everything</h3>
      <p className="muted">One JSON Lines file with every record in this workspace (team, affiliates, programs, sales, commissions, payouts, messages, audit trail). Credentials and hashes are left out. Built in the background; downloadable for 7 days. Owners only.</p>
      <button className="sm" disabled={busy || pending} onClick={() => run(() => api("/v1/analytics/exports", { method: "POST", json: { entity: "workspace" } }), "Export started.").then(reloadExports)}>
        {pending ? "Building…" : "Export workspace data"}
      </button>
      {workspaceExports.length ? (
        <Table
          rows={workspaceExports.slice(0, 5)}
          keyOf={(e: any) => e.id}
          columns={[
            { header: "Requested", cell: (e: any) => dateTime(e.createdAt) },
            { header: "Status", cell: (e: any) => <Badge value={e.status} /> },
            { header: "Rows", cell: (e: any) => e.rowCount ?? "—", num: true },
            { header: "", cell: (e: any) => (e.status === "done" ? <button className="sm" onClick={() => download(e)}>Download</button> : e.error ? <span className="muted">{e.error}</span> : null) },
          ]}
        />
      ) : null}
      <p className="muted" style={{ marginTop: 12 }}>Affiliates can ask for their personal data to be erased from their portal profile; the request lands in your tasks, and “Erase personal data” on their page carries it out once nothing is owed to them.</p>
    </div>
  );
}

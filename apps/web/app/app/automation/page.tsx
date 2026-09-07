"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";
import { RuleBuilder, emptyRule, type RuleDraft } from "@/components/rule-builder";

export default function AutomationPage() {
  const { data, error, reload } = useApi<any>("/v1/automation/rules");
  const { data: catalog } = useApi<any>("/v1/automation/catalog");
  const { busy, error: actionError, success, run } = useAction();
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const label = (t: string) => catalog?.triggers?.find((x: any) => x.type === t)?.label ?? t;

  return (
    <>
      <PageHeader
        title="Automation"
        subtitle="Deterministic rules: when an event happens and the conditions hold, run the actions. Every run is logged."
        actions={<button className="primary" onClick={() => setDraft(draft ? null : emptyRule())}>{draft ? "Close" : "New rule"}</button>}
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      {draft && catalog ? (
        <div className="card">
          <h2>New rule</h2>
          <RuleBuilder catalog={catalog} value={draft} onChange={setDraft} />
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                const ok = await run(() => api("/v1/automation/rules", { method: "POST", json: draft }), "Rule created.");
                if (ok) {
                  setDraft(null);
                  reload();
                }
              }}
            >
              Create rule
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div className="card">
        <Table
          rows={data?.rules}
          keyOf={(r: any) => r.id}
          empty="No rules yet. Example: when a conversion is recorded over a threshold, tag the affiliate and create a task to send a thank-you."
          columns={[
            { header: "Rule", cell: (r: any) => <><Link href={`/app/automation/${r.id}`}><strong>{r.name}</strong></Link><div className="muted">When {label(r.trigger).toLowerCase()}{r.conditions.length ? ` · ${r.conditions.length} condition${r.conditions.length > 1 ? "s" : ""}` : ""} · {r.actions.length} action{r.actions.length > 1 ? "s" : ""}</div></> },
            { header: "Status", cell: (r: any) => <Badge value={r.enabled ? "active" : "paused"} /> },
            { header: "Runs", cell: (r: any) => `${r.stats.succeeded} ok · ${r.stats.failed} failed · ${r.stats.runs} total`, num: true },
            { header: "Last run", cell: (r: any) => (r.stats.lastRunAt ? dateTime(r.stats.lastRunAt) : "never") },
            { header: "", cell: (r: any) => <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/automation/rules/${r.id}/enabled`, { method: "POST", json: { enabled: !r.enabled } })).then(reload)}>{r.enabled ? "Pause" : "Resume"}</button> },
          ]}
        />
      </div>
    </>
  );
}

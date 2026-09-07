"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Badge, Loading, PageHeader, Table } from "@/components/ui";
import { RuleBuilder, toDraft, toPayload, type RuleDraft } from "@/components/rule-builder";

export default function AutomationRulePage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<any>(`/v1/automation/rules/${id}`);
  const { data: runs, reload: reloadRuns } = useApi<any>(`/v1/automation/rules/${id}/runs`);
  const { data: catalog } = useApi<any>("/v1/automation/catalog");
  const { busy, error: actionError, success, run } = useAction();
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (data) setDraft(toDraft(data.rule));
  }, [data]);
  if (!data || !catalog) return <Loading error={error} />;
  const rule = data.rule;
  const label = (t: string) => catalog.triggers.find((x: any) => x.type === t)?.label ?? t;

  return (
    <>
      <PageHeader
        title={rule.name}
        subtitle={
          <>
            When {label(rule.trigger).toLowerCase()} · <Badge value={rule.enabled ? "active" : "paused"} />
          </>
        }
        actions={
          <>
            <button onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Edit rule"}</button>
            <button disabled={busy} onClick={() => run(() => api(`/v1/automation/rules/${id}/enabled`, { method: "POST", json: { enabled: !rule.enabled } }), rule.enabled ? "Rule paused. History is kept." : "Rule resumed.").then(reload)}>
              {rule.enabled ? "Pause" : "Resume"}
            </button>
          </>
        }
      />
      <Alert kind="error">{actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      {editing && draft ? (
        <div className="card">
          <h2>Edit rule</h2>
          <RuleBuilder catalog={catalog} value={draft} onChange={setDraft} />
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                const ok = await run(() => api(`/v1/automation/rules/${id}`, { method: "PATCH", json: toPayload(draft, catalog) }), "Rule saved.");
                if (ok) {
                  setEditing(false);
                  reload();
                }
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="grid cols-2">
          <div className="card">
            <h2>Conditions</h2>
            {rule.conditions.length ? (
              <ul>
                {rule.conditions.map((c: any, i: number) => (
                  <li key={i}>
                    <code>{c.field}</code> {c.op} <code>{Array.isArray(c.value) ? c.value.join(", ") : String(c.value)}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Runs for every matching event.</p>
            )}
            <h3 style={{ marginTop: 14 }}>Stop conditions</h3>
            <ul>
              {rule.stop.oncePerEntity !== false ? <li>Once per entity</li> : null}
              {rule.stop.oncePerAffiliate ? <li>Once per affiliate</li> : null}
              <li>Skipped when affiliate is {(rule.stop.skipIfAffiliateStatusIn ?? ["suspended", "rejected"]).join(" or ")}</li>
              {rule.stop.activeFrom || rule.stop.activeUntil ? <li>Active {rule.stop.activeFrom ? `from ${dateTime(rule.stop.activeFrom)}` : ""} {rule.stop.activeUntil ? `until ${dateTime(rule.stop.activeUntil)}` : ""}</li> : null}
            </ul>
          </div>
          <div className="card">
            <h2>Actions</h2>
            <ol>
              {rule.actions.map((a: any, i: number) => (
                <li key={i}>
                  <strong>{catalog.actions.find((d: any) => d.type === a.type)?.label ?? a.type}</strong>
                  <span className="muted">
                    {" "}
                    {Object.entries(a)
                      .filter(([k]) => k !== "type")
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
      <div className="card">
        <h2>Execution log</h2>
        <p className="muted">What ran, why, what it did and whether it succeeded.</p>
        <Table
          rows={runs?.runs}
          keyOf={(r: any) => r.id}
          empty="This rule has not run yet."
          columns={[
            { header: "When", cell: (r: any) => dateTime(r.createdAt) },
            { header: "Event", cell: (r: any) => <><span>{r.entityType}</span><div className="muted mono">{r.entityId}</div></> },
            { header: "Outcome", cell: (r: any) => <><Badge value={r.status} />{r.error && r.status !== "success" ? <div className="muted">{r.error}</div> : null}</> },
            {
              header: "Actions taken",
              cell: (r: any) =>
                r.actionsTaken?.length ? (
                  <ul style={{ paddingLeft: 16 }}>
                    {r.actionsTaken.map((a: any, i: number) => (
                      <li key={i}>
                        {a.ok ? "✓" : "✕"} {a.type} <span className="muted">{a.detail ?? a.error ?? ""}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">—</span>
                ),
            },
          ]}
        />
        <button className="sm" style={{ marginTop: 10 }} onClick={reloadRuns}>
          Refresh log
        </button>
      </div>
    </>
  );
}

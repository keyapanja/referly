"use client";

import Link from "next/link";
import { useApi } from "@/lib/hooks";
import { money } from "@/lib/format";
import { Loading, PageHeader, Stat, Table, Badge } from "@/components/ui";

export default function AdminOverview() {
  const { data, error } = useApi<any>("/admin/overview");
  const { data: tenants } = useApi<any>("/admin/tenants?limit=10");
  const { data: ops } = useApi<any>("/admin/ops");
  if (!data) return <Loading error={error} />;
  const q = ops?.queue;
  const lag = q ? (q.lagSeconds < 60 ? `${q.lagSeconds}s` : q.lagSeconds < 3600 ? `${Math.round(q.lagSeconds / 60)}m` : `${(q.lagSeconds / 3600).toFixed(1)}h`) : "…";
  const healthy = q && q.dead === 0 && q.stuck === 0 && q.lagSeconds < 120 && (ops?.webhooks?.deadDeliveries24h ?? 0) === 0;
  return (
    <>
      <PageHeader title="Platform overview" subtitle="All workspaces, last 30 days" />
      <div className="grid cols-4">
        <Stat label="Workspaces" value={data.tenants.total} hint={`${data.tenants.new30d} new · ${data.tenants.byStatus.suspended ?? 0} suspended`} />
        <Stat label="Conversions tracked" value={data.conversions30d} hint="all tenants, 30 days" />
        <Stat label="Revenue tracked" value={money(data.revenue30dMinor, "USD")} hint="mixed currencies, shown as-is" />
        <Stat label="Needs attention" value={data.deadJobs + data.failedEmails24h} hint={`${data.deadJobs} dead jobs · ${data.failedEmails24h} failed emails (24h)`} />
      </div>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div>
            <h2 style={{ marginBottom: 0 }}>Operations</h2>
            <div className="muted" style={{ fontSize: 12.5 }}>Queue and delivery health across every workspace. The same numbers are exported at <span className="mono">/metrics</span>.</div>
          </div>
          {q ? <Badge value={healthy ? "healthy" : "attention"} /> : null}
        </div>
        <div className="grid cols-4" style={{ marginTop: 12 }}>
          <Stat label="Queued" value={q?.queued ?? "…"} hint={`${q?.retrying ?? 0} retrying · ${q?.running ?? 0} running`} />
          <Stat label="Queue lag" value={lag} hint="oldest due job waiting" />
          <Stat label="Dead jobs" value={q?.dead ?? "…"} hint={<Link href="/admin/jobs">{q?.deadLastHour ?? 0} in the last hour · review</Link>} />
          <Stat label="Stuck" value={q?.stuck ?? "…"} hint="running for over 10 minutes" />
          <Stat label="Processed" value={q?.doneLastHour ?? "…"} hint="jobs done in the last hour" />
          <Stat label="Webhooks" value={ops?.webhooks?.deadDeliveries24h ?? "…"} hint={`dead deliveries (24h) · ${ops?.webhooks?.pausedSubscriptions ?? 0} paused endpoints`} />
          <Stat label="Messages" value={ops?.messages?.failed24h ?? "…"} hint="failed sends (24h)" />
          <Stat label="By type" value={q?.byType?.filter((r: any) => r.status !== "done").length ?? "…"} hint={q?.byType?.map((r: any) => `${r.type}:${r.status}=${r.n}`).join(" ") || "queue is empty"} />
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Plans</h2>
          <dl className="kv">
            {["starter", "growth", "pro", "enterprise"].map((p) => (
              <div key={p} style={{ display: "contents" }}>
                <dt style={{ textTransform: "capitalize" }}>{p}</dt>
                <dd>{data.tenants.byPlan[p] ?? 0}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="card">
          <h2>Newest workspaces</h2>
          <Table
            rows={tenants?.tenants}
            keyOf={(r: any) => r.tenant.id}
            columns={[
              { header: "Workspace", cell: (r: any) => <Link href={`/admin/tenants/${r.tenant.id}`}>{r.tenant.name}</Link> },
              { header: "Plan", cell: (r: any) => r.tenant.planId },
              { header: "Status", cell: (r: any) => <Badge value={r.tenant.status} /> },
              { header: "Affiliates", cell: (r: any) => r.activeAffiliates, num: true },
            ]}
          />
        </div>
      </div>
    </>
  );
}

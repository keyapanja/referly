"use client";

import Link from "next/link";
import { useApi } from "@/lib/hooks";
import { money } from "@/lib/format";
import { Loading, PageHeader, Stat, Table, Badge } from "@/components/ui";

export default function AdminOverview() {
  const { data, error } = useApi<any>("/admin/overview");
  const { data: tenants } = useApi<any>("/admin/tenants?limit=10");
  if (!data) return <Loading error={error} />;
  return (
    <>
      <PageHeader title="Platform overview" subtitle="All workspaces, last 30 days" />
      <div className="grid cols-4">
        <Stat label="Workspaces" value={data.tenants.total} hint={`${data.tenants.new30d} new · ${data.tenants.byStatus.suspended ?? 0} suspended`} />
        <Stat label="Conversions tracked" value={data.conversions30d} hint="all tenants, 30 days" />
        <Stat label="Revenue tracked" value={money(data.revenue30dMinor, "USD")} hint="mixed currencies, shown as-is" />
        <Stat label="Needs attention" value={data.deadJobs + data.failedEmails24h} hint={`${data.deadJobs} dead jobs · ${data.failedEmails24h} failed emails (24h)`} />
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

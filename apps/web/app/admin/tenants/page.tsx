"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { date, money } from "@/lib/format";
import { Badge, PageHeader, Table } from "@/components/ui";

export default function AdminTenants() {
  const [q, setQ] = useState("");
  const { data, error } = useApi<any>(`/admin/tenants?q=${encodeURIComponent(q)}`);
  return (
    <>
      <PageHeader title="Workspaces" subtitle="Every merchant tenant on the platform." actions={<input placeholder="Search name or slug" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />} />
      {error ? <div className="alert error">{error}</div> : null}
      <div className="card">
        <Table
          rows={data?.tenants}
          keyOf={(r: any) => r.tenant.id}
          empty="No workspaces match."
          columns={[
            {
              header: "Workspace",
              cell: (r: any) => (
                <>
                  <Link href={`/admin/tenants/${r.tenant.id}`}>
                    <strong>{r.tenant.name}</strong>
                  </Link>
                  <div className="muted mono">{r.tenant.slug}</div>
                </>
              ),
            },
            { header: "Owner", cell: (r: any) => (r.owners[0] ? <>{r.owners[0].name}<div className="muted">{r.owners[0].email}</div></> : "—") },
            { header: "Plan", cell: (r: any) => <span style={{ textTransform: "capitalize" }}>{r.tenant.planId}</span> },
            { header: "Status", cell: (r: any) => <Badge value={r.tenant.status} /> },
            { header: "Affiliates", cell: (r: any) => r.activeAffiliates, num: true },
            { header: "Conv. 30d", cell: (r: any) => r.conversions30d, num: true },
            { header: "Revenue 30d", cell: (r: any) => money(r.revenue30dMinor, r.tenant.currency), num: true },
            { header: "Created", cell: (r: any) => date(r.tenant.createdAt) },
          ]}
        />
      </div>
    </>
  );
}

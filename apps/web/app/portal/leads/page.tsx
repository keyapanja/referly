"use client";

import { useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Badge, Loading, PageHeader, Table } from "@/components/ui";

const EXPLAIN: Record<string, string> = {
  pending: "Waiting for the merchant to qualify it.",
  qualified: "Confirmed. The commission settles after the holding period.",
  disqualified: "Not a valid lead; no commission.",
  duplicate: "Same person already counted inside the dedupe window.",
};

export default function PortalLeads() {
  const { data, error } = useApi<any>("/portal/leads");
  if (!data) return <Loading error={error} />;
  return (
    <>
      <PageHeader title="Leads" subtitle="Signups and enquiries that came through your links, and what each one earns once qualified." />
      <div className="card">
        <Table
          rows={data.leads}
          keyOf={(l: any) => l.id}
          empty="No leads yet."
          columns={[
            { header: "When", cell: (l: any) => dateTime(l.createdAt) },
            { header: "Program", cell: (l: any) => l.programName ?? "—" },
            { header: "Lead", cell: (l: any) => (l.emailDomain ? <span className="muted">someone @{l.emailDomain}</span> : <span className="muted">contact held by the merchant</span>) },
            {
              header: "Status",
              cell: (l: any) => (
                <>
                  <Badge value={l.status} />
                  <div className="help">{EXPLAIN[l.status]}</div>
                </>
              ),
            },
            { header: "Commission", cell: (l: any) => (l.commissionMinor != null ? <>{money(l.commissionMinor, l.currency)} <Badge value={l.commissionStatus} /></> : "—") },
          ]}
        />
      </div>
    </>
  );
}

"use client";

import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Badge, PageHeader, Table } from "@/components/ui";

export default function AdminJobs() {
  const { data, error, reload } = useApi<any>("/admin/jobs");
  const { busy, error: actionError, run } = useAction();
  return (
    <>
      <PageHeader title="Background jobs" subtitle="Dead jobs exhausted their retries; retrying jobs failed at least once." />
      <Alert kind="error">{error ?? actionError}</Alert>
      <div className="card">
        <Table
          rows={data?.jobs}
          keyOf={(j: any) => j.id}
          empty="No failing jobs. The queue is healthy."
          columns={[
            { header: "Job", cell: (j: any) => <><strong>{j.type}</strong><div className="muted mono">{j.id}</div></> },
            { header: "Tenant", cell: (j: any) => <span className="mono">{j.tenantId ?? "platform"}</span> },
            { header: "Status", cell: (j: any) => <Badge value={j.status} /> },
            { header: "Attempts", cell: (j: any) => `${j.attempts} / ${j.maxAttempts}`, num: true },
            { header: "Last error", cell: (j: any) => <span className="muted" style={{ maxWidth: 360, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={j.lastError}>{j.lastError}</span> },
            { header: "Runs at", cell: (j: any) => dateTime(j.runAt) },
            { header: "", cell: (j: any) => <button className="sm" disabled={busy} onClick={() => run(() => api(`/admin/jobs/${j.id}/retry`, { method: "POST" })).then(reload)}>Retry</button> },
          ]}
        />
      </div>
    </>
  );
}

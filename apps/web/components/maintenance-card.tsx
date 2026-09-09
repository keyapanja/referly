"use client";

import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Badge, Stat, Table } from "@/components/ui";

function age(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "never";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h ago`;
  return `${(seconds / 86_400).toFixed(1)}d ago`;
}

function size(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Admin overview → Maintenance: last backup, last retention prune, workspace purges, manual triggers and recent history. */
export function MaintenanceCard({ ops }: { ops: any }) {
  const { data, reload } = useApi<any>("/admin/maintenance?limit=12");
  const { busy, error, success, run } = useAction();
  const m = ops?.maintenance;
  const backupCfg = data?.config?.backups;
  const backupOk = m?.backup?.status === "done" && (m.backup.ageSeconds ?? Infinity) < (backupCfg?.everyHours ? backupCfg.everyHours * 3600 * 1.5 : 36 * 3600);
  const trigger = (kind: "backup" | "retention") => run(() => api(`/admin/maintenance/${kind}`, { method: "POST", json: {} }), `${kind === "backup" ? "Backup" : "Retention run"} queued; the worker will pick it up in a moment.`).then(() => setTimeout(reload, 1500));

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginBottom: 0 }}>Backups and retention</h2>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {backupCfg
              ? backupCfg.enabled
                ? `Encrypted backups every ${backupCfg.everyHours}h${backupCfg.includeFiles ? " with uploaded files" : ""}; kept daily for ${backupCfg.keepDays} days, then weekly for ${backupCfg.keepWeeks} weeks.`
                : "Scheduled backups are off (BACKUP_EVERY_HOURS=0); manual and CLI backups still work."
              : data
                ? "Backups are not configured in this process."
                : "…"}{" "}
            Retention prunes every workspace nightly under its own policy; closed workspaces are purged after {data?.config?.retention?.platform?.closedTenantPurgeDays ?? "…"} days.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="sm" disabled={busy || !backupCfg} onClick={() => trigger("backup")}>
            Back up now
          </button>
          <button className="sm" disabled={busy} onClick={() => trigger("retention")}>
            Run retention now
          </button>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {success ? <p className="success">{success}</p> : null}
      <div className="grid cols-4" style={{ marginTop: 12 }}>
        <Stat label="Last backup" value={m ? age(m.backup?.ageSeconds) : "…"} hint={m?.backup ? <>{size(m.backup.sizeBytes)} · <Badge value={backupOk ? "ok" : m.backup.status === "running" ? "running" : "attention"} /></> : "no backup yet"} />
        <Stat label="Backup contents" value={m?.backup?.summary?.rows ?? "…"} hint={m?.backup?.summary ? `rows · ${m.backup.summary.tables} tables · ${m.backup.summary.files} files` : "—"} />
        <Stat label="Last retention run" value={m ? age(m.retention?.ageSeconds) : "…"} hint={m?.retention?.summary?.deleted ? `${Object.values(m.retention.summary.deleted as Record<string, number>).reduce((a, b) => a + b, 0)} rows pruned across ${m.retention.summary.tenants} workspaces` : m?.retention?.error ?? "—"} />
        <Stat label="Last purge" value={m ? age(m.purge?.ageSeconds) : "…"} hint={m?.purge?.summary?.slug ? `workspace ${m.purge.summary.slug}` : "no workspace purged"} />
      </div>
      <Table
        rows={data?.runs}
        keyOf={(r: any) => r.id}
        empty="No maintenance has run yet."
        columns={[
          { header: "Started", cell: (r: any) => dateTime(r.startedAt) },
          { header: "Kind", cell: (r: any) => r.kind },
          { header: "Trigger", cell: (r: any) => r.trigger },
          { header: "Status", cell: (r: any) => <Badge value={r.status} /> },
          { header: "Size", cell: (r: any) => size(r.sizeBytes), num: true },
          {
            header: "Details",
            cell: (r: any) =>
              r.error ? (
                <span className="error">{r.error}</span>
              ) : r.kind === "backup" ? (
                <span className="muted">{r.summary?.rows ?? "—"} rows · {r.summary?.files ?? 0} files{r.summary?.deleted?.length ? ` · rotated ${r.summary.deleted.length}` : ""}</span>
              ) : r.kind === "retention" ? (
                <span className="muted">{Object.entries((r.summary?.deleted ?? {}) as Record<string, number>).filter(([, n]) => n > 0).map(([k, n]) => `${k.replace(/Days$/, "")} ${n}`).join(", ") || "nothing to prune"}{r.summary?.purged?.length ? ` · purged ${r.summary.purged.join(", ")}` : ""}</span>
              ) : (
                <span className="muted">{r.summary?.slug ?? ""}</span>
              ),
          },
        ]}
      />
      <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
        Archives are encrypted with <span className="mono">BACKUP_KEY</span>. Restore with <span className="mono">npm run restore -- &lt;key&gt; --yes</span> against the target <span className="mono">DATABASE_URL</span>; see docs/DEPLOYMENT.md.
      </p>
    </div>
  );
}

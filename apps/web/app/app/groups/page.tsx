"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

const KIND_LABEL: Record<string, string> = { partner_type: "Partner type", channel: "Channel", geography: "Geography", rate: "Negotiated rate", custom: "Custom" };

export default function GroupsPage() {
  const { data, error, reload } = useApi<any>("/v1/groups");
  const { data: affiliates } = useApi<any>("/v1/affiliates");
  const { busy, error: actionError, success, run } = useAction();
  const [form, setForm] = useState({ name: "", kind: "partner_type", description: "" });
  const [open, setOpen] = useState<string | null>(null);
  const { data: members, reload: reloadMembers } = useApi<any>(open ? `/v1/groups/${open}/members` : null);
  const [pick, setPick] = useState<string[]>([]);

  const memberIds = new Set((members?.members ?? []).map((m: any) => m.id));
  const candidates = (affiliates?.affiliates ?? []).filter((a: any) => !memberIds.has(a.id));

  return (
    <>
      <PageHeader title="Groups" subtitle="Classify affiliates by partner type, channel, geography or negotiated rate. Groups drive tiers, asset access, campaign invites and automation." />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>New group</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api("/v1/groups", { method: "POST", json: { name: form.name, kind: form.kind, description: form.description || undefined } }), "Group created.");
              if (ok) {
                setForm({ name: "", kind: "partner_type", description: "" });
                reload();
              }
            }}
          >
            <div className="row">
              <Field label="Name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Agencies" />
              </Field>
              <Field label="Kind">
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {(data?.kinds ?? Object.keys(KIND_LABEL)).map((k: string) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k] ?? k}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Description (optional)">
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <button className="primary" disabled={busy}>
              Create group
            </button>
          </form>
        </div>
        <div className="card">
          <h2>Groups</h2>
          <Table
            rows={data?.groups}
            keyOf={(g: any) => g.id}
            empty="No groups yet."
            columns={[
              { header: "Group", cell: (g: any) => <><strong>{g.name}</strong>{g.description ? <div className="muted">{g.description}</div> : null}</> },
              { header: "Kind", cell: (g: any) => KIND_LABEL[g.kind] ?? g.kind },
              { header: "Members", cell: (g: any) => g.memberCount, num: true },
              {
                header: "",
                cell: (g: any) => (
                  <span className="actions">
                    <button className="sm" onClick={() => { setOpen(open === g.id ? null : g.id); setPick([]); }}>
                      {open === g.id ? "Close" : "Members"}
                    </button>
                    <button className="sm danger" disabled={busy} onClick={() => run(() => api(`/v1/groups/${g.id}`, { method: "DELETE" }), "Group deleted.").then(() => { if (open === g.id) setOpen(null); reload(); })}>
                      Delete
                    </button>
                  </span>
                ),
              },
            ]}
          />
        </div>
      </div>
      {open ? (
        <div className="card">
          <h2>Members of {data?.groups?.find((g: any) => g.id === open)?.name}</h2>
          <div className="actions" style={{ marginBottom: 12 }}>
            <select multiple value={pick} onChange={(e) => setPick(Array.from(e.target.selectedOptions).map((o) => o.value))} style={{ minWidth: 280, height: 96 }}>
              {candidates.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.email} <>{a.status !== "active" ? `(${a.status})` : ""}</>
                </option>
              ))}
            </select>
            <button className="sm primary" disabled={busy || !pick.length} onClick={() => run(() => api(`/v1/groups/${open}/members`, { method: "POST", json: { affiliateIds: pick } }), "Added.").then(() => { setPick([]); reloadMembers(); reload(); })}>
              Add selected
            </button>
          </div>
          <Table
            rows={members?.members}
            keyOf={(m: any) => m.id}
            empty="No members yet."
            columns={[
              { header: "Affiliate", cell: (m: any) => <Link href={`/app/affiliates/${m.id}`}>{m.name}</Link> },
              { header: "Email", cell: (m: any) => m.email },
              { header: "Status", cell: (m: any) => <Badge value={m.status} /> },
              { header: "", cell: (m: any) => <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/groups/${open}/members/${m.id}`, { method: "DELETE" })).then(() => { reloadMembers(); reload(); })}>Remove</button> },
            ]}
          />
        </div>
      ) : null}
    </>
  );
}

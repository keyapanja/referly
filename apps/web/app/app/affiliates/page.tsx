"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { date } from "@/lib/format";
import { Alert, Badge, CopyBox, Field, PageHeader, Table } from "@/components/ui";

function AffiliatesList() {
  const params = useSearchParams();
  const status = params.get("status") ?? "";
  const { data, error, reload } = useApi<any>(`/v1/affiliates${status ? `?status=${status}` : ""}`);
  const { data: programs } = useApi<any>("/v1/programs?status=active");
  const { busy, error: actionError, run } = useAction();
  const [mode, setMode] = useState<"" | "invite" | "create">("");
  const [invite, setInvite] = useState({ email: "", name: "", programId: "" });
  const [create, setCreate] = useState({ name: "", email: "", programId: "" });
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Affiliates"
        subtitle="Applications, active partners and their performance."
        actions={
          <>
            <select value={status} onChange={(e) => (window.location.search = e.target.value ? `?status=${e.target.value}` : "")}>
              <option value="">All statuses</option>
              {["applied", "active", "suspended", "rejected"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button onClick={() => setMode(mode === "create" ? "" : "create")}>Add manually</button>
            <button className="primary" onClick={() => setMode(mode === "invite" ? "" : "invite")}>
              Invite
            </button>
          </>
        }
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      {acceptUrl ? (
        <Alert kind="success">
          Invitation sent. Accept link: <CopyBox value={acceptUrl} />
        </Alert>
      ) : null}
      {mode === "invite" && (
        <div className="card">
          <h2>Invite an affiliate</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const res = await run(() => api<any>("/v1/affiliates/invites", { method: "POST", json: { programId: invite.programId, email: invite.email, name: invite.name || undefined } }));
              if (res) {
                setAcceptUrl(res.acceptUrl);
                setMode("");
              }
            }}
          >
            <div className="row">
              <Field label="Email">
                <input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required />
              </Field>
              <Field label="Name">
                <input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
              </Field>
              <Field label="Program">
                <select value={invite.programId} onChange={(e) => setInvite({ ...invite, programId: e.target.value })} required>
                  <option value="">Choose…</option>
                  {programs?.programs?.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button className="primary" disabled={busy}>
              Send invitation
            </button>
          </form>
        </div>
      )}
      {mode === "create" && (
        <div className="card">
          <h2>Add an affiliate manually</h2>
          <p className="muted">Creates an active affiliate without a portal login (for partners you manage yourself).</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api("/v1/affiliates", { method: "POST", json: { name: create.name, email: create.email, programIds: create.programId ? [create.programId] : [] } }));
              if (ok) {
                setMode("");
                reload();
              }
            }}
          >
            <div className="row">
              <Field label="Name">
                <input value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} required />
              </Field>
              <Field label="Email">
                <input type="email" value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} required />
              </Field>
              <Field label="Program">
                <select value={create.programId} onChange={(e) => setCreate({ ...create, programId: e.target.value })}>
                  <option value="">None yet</option>
                  {programs?.programs?.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button className="primary" disabled={busy}>
              Add affiliate
            </button>
          </form>
        </div>
      )}
      <div className="card">
        <Table
          rows={data?.affiliates}
          keyOf={(a: any) => a.id}
          empty="No affiliates match."
          columns={[
            { header: "Affiliate", cell: (a: any) => <Link href={`/app/affiliates/${a.id}`}><strong>{a.name}</strong></Link> },
            { header: "Email", cell: (a: any) => a.email },
            { header: "Source", cell: (a: any) => a.source },
            { header: "Status", cell: (a: any) => <Badge value={a.status} /> },
            { header: "Joined", cell: (a: any) => date(a.createdAt) },
            {
              header: "",
              cell: (a: any) =>
                a.status === "applied" ? (
                  <span className="actions">
                    <button className="sm primary" disabled={busy} onClick={() => run(() => api(`/v1/affiliates/${a.id}/approve`, { method: "POST", json: {} })).then(reload)}>
                      Approve
                    </button>
                    <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/affiliates/${a.id}/reject`, { method: "POST", json: {} })).then(reload)}>
                      Reject
                    </button>
                  </span>
                ) : null,
            },
          ]}
        />
      </div>
    </>
  );
}

export default function AffiliatesPage() {
  return (
    <Suspense>
      <AffiliatesList />
    </Suspense>
  );
}

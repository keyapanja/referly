"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { date } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

const TYPES = ["image", "banner", "pdf", "video", "copy", "link", "guideline"];
const TEXT_TYPES = new Set(["copy", "guideline"]);

const emptyForm = { type: "image", title: "", url: "", body: "", usageInstructions: "", visibility: "all", programIds: [] as string[], affiliateIds: [] as string[] };

export default function AssetsPage() {
  const { data, error, reload } = useApi<any>("/v1/assets");
  const { data: programs } = useApi<any>("/v1/programs");
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { busy, error: actionError, success, run } = useAction();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<any>(null);

  const programName = (id: string) => programs?.programs?.find((p: any) => p.id === id)?.name ?? id;
  const affiliateName = (id: string) => affiliates?.affiliates?.find((a: any) => a.id === id)?.name ?? id;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));

  const scopePicker = (value: { programIds: string[]; affiliateIds: string[] }, onChange: (v: { programIds: string[]; affiliateIds: string[] }) => void) => (
    <div className="row">
      <Field label="Programs">
        {programs?.programs?.length ? (
          programs.programs.map((p: any) => (
            <label key={p.id} className="checkbox" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={value.programIds.includes(p.id)} onChange={(e) => onChange({ ...value, programIds: toggle(value.programIds, p.id, e.target.checked) })} /> {p.name}
            </label>
          ))
        ) : (
          <div className="help">No programs yet.</div>
        )}
      </Field>
      <Field label="Specific affiliates">
        {affiliates?.affiliates?.length ? (
          affiliates.affiliates.map((a: any) => (
            <label key={a.id} className="checkbox" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={value.affiliateIds.includes(a.id)} onChange={(e) => onChange({ ...value, affiliateIds: toggle(value.affiliateIds, a.id, e.target.checked) })} /> {a.name}
            </label>
          ))
        ) : (
          <div className="help">No active affiliates yet.</div>
        )}
      </Field>
    </div>
  );

  return (
    <>
      <PageHeader title="Assets" subtitle="Banners, files, copy and guidelines your affiliates can use." actions={<button className="primary" onClick={() => setShow(!show)}>Add asset</button>} />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      {show && (
        <div className="card">
          <h2>New asset</h2>
          <p className="muted">Link to a hosted file (your site, Drive, Dropbox, a CDN) or paste approved copy.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const text = TEXT_TYPES.has(form.type);
              const ok = await run(
                () =>
                  api("/v1/assets", {
                    method: "POST",
                    json: {
                      type: form.type,
                      title: form.title,
                      url: !text && form.url ? form.url : undefined,
                      body: text || form.body ? form.body : undefined,
                      usageInstructions: form.usageInstructions || undefined,
                      visibility: form.visibility,
                      programIds: form.visibility === "restricted" ? form.programIds : [],
                      affiliateIds: form.visibility === "restricted" ? form.affiliateIds : [],
                    },
                  }),
                "Asset added.",
              );
              if (ok) {
                setForm(emptyForm);
                setShow(false);
                reload();
              }
            }}
          >
            <div className="row">
              <Field label="Type">
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Field label="Title">
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
              </Field>
            </div>
            {TEXT_TYPES.has(form.type) ? (
              <Field label={form.type === "copy" ? "Approved copy" : "Guideline text"}>
                <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required />
              </Field>
            ) : (
              <Field label="File or page URL">
                <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" required />
              </Field>
            )}
            <Field label="How affiliates should use it (optional)">
              <textarea value={form.usageInstructions} onChange={(e) => setForm({ ...form, usageInstructions: e.target.value })} style={{ minHeight: 60 }} />
            </Field>
            <Field label="Who can see it">
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
                <option value="all">All active affiliates</option>
                <option value="restricted">Only selected programs or affiliates</option>
              </select>
            </Field>
            {form.visibility === "restricted" ? scopePicker(form, (v) => setForm({ ...form, ...v })) : null}
            <button className="primary" disabled={busy}>
              Add asset
            </button>
          </form>
        </div>
      )}
      {editing && (
        <div className="card">
          <h2>Access for “{editing.title}”</h2>
          <p className="muted">Leave everything unticked to make it visible to all active affiliates.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api(`/v1/assets/${editing.id}/permissions`, { method: "PUT", json: { programIds: editing.programIds, affiliateIds: editing.affiliateIds } }), "Access updated.");
              if (ok) {
                setEditing(null);
                reload();
              }
            }}
          >
            {scopePicker(editing, (v) => setEditing({ ...editing, ...v }))}
            <div className="actions">
              <button className="primary" disabled={busy}>
                Save access
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      <div className="card">
        <Table
          rows={data?.assets}
          keyOf={(a: any) => a.id}
          empty="No assets yet. Add a banner, a PDF or some approved copy."
          columns={[
            { header: "Asset", cell: (a: any) => <><strong>{a.title}</strong>{a.url ? <div><a className="mono" href={a.url} target="_blank" rel="noreferrer">{a.url}</a></div> : a.body ? <div className="muted" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.body}</div> : null}</> },
            { header: "Type", cell: (a: any) => a.type },
            {
              header: "Visible to",
              cell: (a: any) =>
                a.visibility === "all" ? (
                  <span className="muted">All affiliates</span>
                ) : (
                  <span>{a.permissions.map((p: any) => (p.programId ? programName(p.programId) : p.affiliateId ? affiliateName(p.affiliateId) : p.offerId)).join(", ") || "nobody"}</span>
                ),
            },
            { header: "Added", cell: (a: any) => date(a.createdAt) },
            {
              header: "",
              cell: (a: any) => (
                <span className="actions">
                  <button className="sm" onClick={() => setEditing({ id: a.id, title: a.title, programIds: a.permissions.filter((p: any) => p.programId).map((p: any) => p.programId), affiliateIds: a.permissions.filter((p: any) => p.affiliateId).map((p: any) => p.affiliateId) })}>
                    Access
                  </button>
                  <button className="sm danger" disabled={busy} onClick={() => run(() => api(`/v1/assets/${a.id}`, { method: "PATCH", json: { status: "archived" } })).then(reload)}>
                    Archive
                  </button>
                </span>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}

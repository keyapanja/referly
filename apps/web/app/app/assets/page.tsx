"use client";

import { useState } from "react";
import { api, upload } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { date } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

const TYPES = ["image", "banner", "pdf", "video", "copy", "link", "guideline"];
const TEXT_TYPES = new Set(["copy", "guideline"]);

const emptyForm = { type: "image", title: "", url: "", body: "", usageInstructions: "", visibility: "all", programIds: [] as string[], affiliateIds: [] as string[], groupIds: [] as string[] };
const FILE_TYPES = new Set(["image", "banner", "pdf", "video"]);
const ACCEPT: Record<string, string> = { image: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml", banner: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml", pdf: "application/pdf", video: "video/mp4,video/webm" };

export default function AssetsPage() {
  const { data, error, reload } = useApi<any>("/v1/assets");
  const { data: programs } = useApi<any>("/v1/programs");
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { data: groupsData } = useApi<any>("/v1/groups");
  const { busy, error: actionError, success, run } = useAction();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<"upload" | "url">("upload");

  const programName = (id: string) => programs?.programs?.find((p: any) => p.id === id)?.name ?? id;
  const affiliateName = (id: string) => affiliates?.affiliates?.find((a: any) => a.id === id)?.name ?? id;
  const groupName = (id: string) => groupsData?.groups?.find((g: any) => g.id === id)?.name ?? id;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));

  const scopePicker = (value: { programIds: string[]; affiliateIds: string[]; groupIds?: string[] }, onChange: (v: { programIds: string[]; affiliateIds: string[]; groupIds?: string[] }) => void) => (
    <div className="row">
      <Field label="Groups">
        {groupsData?.groups?.length ? (
          groupsData.groups.map((g: any) => (
            <label key={g.id} className="checkbox" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={(value.groupIds ?? []).includes(g.id)} onChange={(e) => onChange({ ...value, groupIds: toggle(value.groupIds ?? [], g.id, e.target.checked) })} /> {g.name}
            </label>
          ))
        ) : (
          <div className="help">No groups yet.</div>
        )}
      </Field>
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
              const useUpload = FILE_TYPES.has(form.type) && source === "upload";
              if (useUpload && !file) return;
              const ok = await run(
                async () => {
                  let url: string | undefined = !text && form.url ? form.url : undefined;
                  let stored: any = null;
                  if (useUpload) {
                    stored = (await upload<any>("/v1/assets/upload", file!)).file;
                    url = stored.url;
                  }
                  return api("/v1/assets", {
                    method: "POST",
                    json: {
                      type: form.type,
                      title: form.title || stored?.name,
                      url,
                      storageKey: stored?.key,
                      contentType: stored?.contentType,
                      sizeBytes: stored?.sizeBytes,
                      body: text || form.body ? form.body : undefined,
                      usageInstructions: form.usageInstructions || undefined,
                      visibility: form.visibility,
                      programIds: form.visibility === "restricted" ? form.programIds : [],
                      affiliateIds: form.visibility === "restricted" ? form.affiliateIds : [],
                      groupIds: form.visibility === "restricted" ? form.groupIds : [],
                    },
                  });
                },
                "Asset added.",
              );
              if (ok) {
                setForm(emptyForm);
                setFile(null);
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
              <Field label="Title" help={FILE_TYPES.has(form.type) && source === "upload" ? "Defaults to the file name." : undefined}>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required={!(FILE_TYPES.has(form.type) && source === "upload")} />
              </Field>
            </div>
            {TEXT_TYPES.has(form.type) ? (
              <Field label={form.type === "copy" ? "Approved copy" : "Guideline text"}>
                <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required />
              </Field>
            ) : FILE_TYPES.has(form.type) ? (
              <>
                <Field label="Source">
                  <select value={source} onChange={(e) => setSource(e.target.value as "upload" | "url")}>
                    <option value="upload">Upload a file (up to 25 MB)</option>
                    <option value="url">Link to a file hosted elsewhere</option>
                  </select>
                </Field>
                {source === "upload" ? (
                  <Field label="File" help={file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB` : "PNG, JPG, GIF, WebP, SVG, PDF, MP4 or WebM."}>
                    <input type="file" accept={ACCEPT[form.type]} onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
                  </Field>
                ) : (
                  <Field label="File URL">
                    <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" required />
                  </Field>
                )}
              </>
            ) : (
              <Field label="Page URL">
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
              {busy ? "Uploading…" : "Add asset"}
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
              const ok = await run(() => api(`/v1/assets/${editing.id}/permissions`, { method: "PUT", json: { programIds: editing.programIds, affiliateIds: editing.affiliateIds, groupIds: editing.groupIds ?? [] } }), "Access updated.");
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
                  <span>{a.permissions.map((p: any) => (p.programId ? programName(p.programId) : p.affiliateId ? affiliateName(p.affiliateId) : p.groupId ? `group: ${groupName(p.groupId)}` : p.offerId)).join(", ") || "nobody"}</span>
                ),
            },
            { header: "Added", cell: (a: any) => date(a.createdAt) },
            {
              header: "",
              cell: (a: any) => (
                <span className="actions">
                  <button className="sm" onClick={() => setEditing({ id: a.id, title: a.title, programIds: a.permissions.filter((p: any) => p.programId).map((p: any) => p.programId), affiliateIds: a.permissions.filter((p: any) => p.affiliateId).map((p: any) => p.affiliateId), groupIds: a.permissions.filter((p: any) => p.groupId).map((p: any) => p.groupId) })}>
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

"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

export default function MessagesPage() {
  const { data, error, reload } = useApi<any>("/v1/messages/templates");
  const { data: log } = useApi<any>("/v1/messages/log?limit=50");
  const { busy, error: actionError, success, run } = useAction();
  const [editing, setEditing] = useState<any>(null);
  const [channel, setChannel] = useState<"email" | "text">("email");
  const templates = data?.templates?.filter((t: any) => t.channel === channel);

  return (
    <>
      <PageHeader title="Messages" subtitle="Templates use safe variables only. Nothing is generated automatically." />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <h2 style={{ marginBottom: 0 }}>Templates</h2>
            <div className="segmented" role="tablist">
              {(["email", "text"] as const).map((c) => (
                <button key={c} type="button" role="tab" aria-selected={channel === c} className={channel === c ? "active" : ""} onClick={() => { setChannel(c); setEditing(null); }}>
                  {c === "email" ? "Email" : "SMS / WhatsApp"}
                </button>
              ))}
            </div>
          </div>
          <p className="muted">{channel === "text" ? "Short texts sent in addition to email, only to affiliates who opted in. Keep them under 160 characters where you can. " : ""}Variables: {data?.variables?.map((v: string) => `{{${v}}}`).join(" ")}</p>
          <Table
            rows={templates}
            keyOf={(t: any) => t.id}
            columns={[
              { header: "Event", cell: (t: any) => t.key.replace(/_/g, " ") },
              { header: channel === "email" ? "Subject" : "Message", cell: (t: any) => (channel === "email" ? t.subject : <span className="muted" style={{ fontSize: 12.5 }}>{t.body.length > 70 ? `${t.body.slice(0, 70)}…` : t.body}</span>) },
              { header: "", cell: (t: any) => <><Badge value={t.enabled ? "active" : "disabled"} /> <button className="sm" onClick={() => setEditing({ ...t })}>Edit</button></> },
            ]}
          />
        </div>
        <div className="card">
          {editing ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await run(() => api(`/v1/messages/templates/${editing.key}?channel=${editing.channel}`, { method: "PATCH", json: { subject: editing.subject, body: editing.body, enabled: editing.enabled } }), "Template saved.");
                if (ok) {
                  setEditing(null);
                  reload();
                }
              }}
            >
              <h2>Edit: {editing.key.replace(/_/g, " ")} {editing.channel === "text" ? <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>(SMS / WhatsApp)</span> : null}</h2>
              <Field label={editing.channel === "text" ? "Label (not sent)" : "Subject"}>
                <input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
              </Field>
              <Field label={editing.channel === "text" ? "Message" : "Body"} help={editing.channel === "text" ? `${editing.body.length} characters · ${Math.max(1, Math.ceil(editing.body.length / 160))} SMS segment${editing.body.length > 160 ? "s" : ""} before variables` : undefined}>
                <textarea style={{ minHeight: editing.channel === "text" ? 100 : 200 }} maxLength={editing.channel === "text" ? 1000 : undefined} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
              </Field>
              <label className="checkbox" style={{ marginBottom: 12 }}>
                <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> Enabled
              </label>
              <div className="actions">
                <button className="primary" disabled={busy}>
                  Save
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="empty">Select a template to edit.</div>
          )}
        </div>
      </div>
      <div className="card">
        <h2>Delivery log</h2>
        <Table
          rows={log?.messages}
          keyOf={(m: any) => m.id}
          empty="No messages sent yet."
          columns={[
            { header: "When", cell: (m: any) => dateTime(m.createdAt) },
            { header: "Event", cell: (m: any) => m.templateKey.replace(/_/g, " ") },
            { header: "Channel", cell: (m: any) => (m.channel === "email" ? "Email" : m.channel === "whatsapp" ? "WhatsApp" : m.channel.toUpperCase()) },
            { header: "To", cell: (m: any) => m.recipient || "—" },
            { header: "Subject", cell: (m: any) => (m.channel === "email" ? m.subject ?? "—" : <span className="muted">{m.body ? (m.body.length > 60 ? `${m.body.slice(0, 60)}…` : m.body) : "—"}</span>) },
            { header: "Status", cell: (m: any) => <><Badge value={m.status} /> {m.error ? <span className="muted">{m.error}</span> : null}</> },
          ]}
        />
      </div>
    </>
  );
}

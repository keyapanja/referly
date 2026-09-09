"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Loading, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";

/** Pages fire this after marking notifications read so the bell updates without waiting for the next poll. */
const REFRESH_EVENT = "referly:notifications";
const refreshBell = () => window.dispatchEvent(new Event(REFRESH_EVENT));

/** Sidebar bell with the unread count; polls every 30 s, after the tab regains focus, and when a page marks something read. */
export function NotificationBell({ base }: { base: "/v1/notifications" | "/portal/notifications" }) {
  const [unread, setUnread] = useState<number | null>(null);
  const href = base === "/portal/notifications" ? "/portal/notifications" : "/app/notifications";
  useEffect(() => {
    let alive = true;
    const load = () => api<{ unread: number }>(`${base}/unread-count`).then((d) => alive && setUnread(d.unread)).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    window.addEventListener(REFRESH_EVENT, onFocus);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(REFRESH_EVENT, onFocus);
    };
  }, [base]);
  return (
    <Link href={href} className="icon-btn bell" title="Notifications" aria-label={unread ? `${unread} unread notifications` : "Notifications"}>
      <Icon name="bell" />
      {unread ? <span className="bell-count">{unread > 99 ? "99+" : unread}</span> : null}
    </Link>
  );
}

/** Notifications page shared by the merchant app and the portal: feed, mark read, category preferences. */
export function NotificationsPage({ base }: { base: "/v1/notifications" | "/portal/notifications" }) {
  const router = useRouter();
  const [filter, setFilter] = useState<"unread" | "all">("unread");
  const { data, error, reload } = useApi<any>(`${base}?limit=100${filter === "unread" ? "&unread=1" : ""}`, [filter]);
  const { data: prefs, reload: reloadPrefs } = useApi<any>(`${base}/preferences`);
  const { busy, error: actionError, run } = useAction();
  const isPortal = base === "/portal/notifications";

  async function open(n: any) {
    if (!n.readAt) {
      await api(`${base}/read`, { method: "POST", json: { ids: [n.id] } }).catch(() => {});
      refreshBell();
    }
    if (n.link) router.push(n.link);
    else reload();
  }

  if (!data) return <Loading error={error} />;
  const items: any[] = data.notifications;

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={data.unread ? `${data.unread} unread` : "You're all caught up"}
        actions={
          <>
            <div className="segmented">
              <button className={filter === "unread" ? "active" : ""} onClick={() => setFilter("unread")}>
                Unread
              </button>
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
                All
              </button>
            </div>
            <button className="sm" disabled={busy || !data.unread} onClick={() => run(() => api(`${base}/read`, { method: "POST", json: { all: true } })).then(() => { refreshBell(); reload(); })}>
              Mark all read
            </button>
          </>
        }
      />
      <Alert kind="error">{actionError}</Alert>
      <div className="card" style={{ padding: 0 }}>
        {items.length === 0 ? (
          <p className="muted" style={{ padding: 16, margin: 0 }}>
            {filter === "unread" ? "Nothing unread." : "No notifications yet."}
          </p>
        ) : (
          <ul className="notif-list">
            {items.map((n) => (
              <li key={n.id} className={n.readAt ? "read" : "unread"}>
                <button className="notif" onClick={() => open(n)}>
                  <span className="dot" aria-hidden />
                  <span className="notif-body">
                    <strong>{n.title}</strong>
                    {n.body ? <span className="muted">{n.body}</span> : null}
                    <small className="muted">
                      {dateTime(n.createdAt)} · {n.category.replace(/^affiliate_/, "").replace(/_/g, " ")}
                    </small>
                  </span>
                  {n.link ? <Icon name="chevron" /> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {prefs ? (
        <div className="card">
          <h2>What you're notified about</h2>
          <p className="muted">{isPortal ? "Switch categories off here for the app and for email. Account and security emails are always sent." : "Switch categories off for your in-app feed. These settings are yours alone; teammates have their own."}</p>
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ textAlign: "center" }}>In app</th>
                {isPortal ? <th style={{ textAlign: "center" }}>Email</th> : null}
              </tr>
            </thead>
            <tbody>
              {prefs.categories.map((c: any) => {
                const on = (ch: "inApp" | "email") => prefs.prefs[c.key]?.[ch] !== false;
                const toggle = (ch: "inApp" | "email") => run(() => api(`${base}/preferences`, { method: "PATCH", json: { [c.key]: { [ch]: !on(ch) } } })).then(reloadPrefs);
                return (
                  <tr key={c.key}>
                    <td>
                      <strong>{c.label}</strong>
                      <div className="muted">{c.description}</div>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" checked={on("inApp")} disabled={busy} onChange={() => toggle("inApp")} aria-label={`${c.label} in app`} />
                    </td>
                    {isPortal ? (
                      <td style={{ textAlign: "center" }}>{c.email ? <input type="checkbox" checked={on("email")} disabled={busy} onChange={() => toggle("email")} aria-label={`${c.label} by email`} /> : <span className="muted">—</span>}</td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

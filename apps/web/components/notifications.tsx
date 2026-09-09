"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Alert, Loading, PageHeader } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";

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

/** Day bucket label for grouping the feed. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const CATEGORY_ICON: Record<string, IconName> = {
  applications: "users",
  sales: "receipt",
  leads: "inbox",
  disputes: "alert",
  payouts: "banknote",
  tasks: "check",
  account: "user",
  earnings: "percent",
  affiliate_payouts: "wallet",
  campaigns: "megaphone",
  affiliate_disputes: "alert",
  program: "layers",
};

/** Notifications page shared by the merchant app and the portal: feed grouped by day, mark read, category preferences. */
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
  const groups: { label: string; items: any[] }[] = [];
  for (const n of items) {
    const label = dayLabel(n.createdAt);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(n);
    else groups.push({ label, items: [n] });
  }

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
      {items.length === 0 ? (
        <div className="card notif-empty">
          <Icon name="bell" width={22} height={22} />
          <strong>{filter === "unread" ? "Nothing unread" : "No notifications yet"}</strong>
          <span className="muted">{filter === "unread" ? "New activity shows up here as it happens." : isPortal ? "Approvals, sales, payouts and campaign invites will appear here." : "Applications, sales, leads, disputes and tasks will appear here."}</span>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label} className="notif-group">
            <h3 className="notif-day">{g.label}</h3>
            <div className="card notif-card">
              <ul className="notif-list">
                {g.items.map((n) => (
                  <li key={n.id} className={n.readAt ? "read" : "unread"}>
                    <button className="notif" onClick={() => open(n)}>
                      <span className={`notif-icon cat-${n.category}`} aria-hidden>
                        <Icon name={CATEGORY_ICON[n.category] ?? "bell"} width={15} height={15} />
                      </span>
                      <span className="notif-body">
                        <span className="notif-title">
                          <strong>{n.title}</strong>
                          {!n.readAt ? <span className="notif-new" aria-label="unread" /> : null}
                        </span>
                        {n.body ? <span className="notif-text">{n.body}</span> : null}
                      </span>
                      <span className="notif-meta">
                        <span className="notif-cat">{n.category.replace(/^affiliate_/, "").replace(/_/g, " ")}</span>
                        <time dateTime={n.createdAt}>{timeLabel(n.createdAt)}</time>
                      </span>
                      {n.link ? <Icon name="chevron" width={16} height={16} className="notif-go" /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))
      )}
      {prefs ? (
        <section className="notif-group">
          <h3 className="notif-day">Preferences</h3>
          <div className="card notif-card">
            <div className="notif-prefs-head">
              <div>
                <strong>What you're notified about</strong>
                <div className="muted">{isPortal ? "Switch categories off for the app and for email. Account and security emails are always sent." : "Switch categories off for your in-app feed. These settings are yours alone; teammates have their own."}</div>
              </div>
              <div className="notif-prefs-cols" aria-hidden>
                <span>In app</span>
                {isPortal ? <span>Email</span> : null}
              </div>
            </div>
            <ul className="notif-prefs">
              {prefs.categories.map((c: any) => {
                const on = (ch: "inApp" | "email") => prefs.prefs[c.key]?.[ch] !== false;
                const toggle = (ch: "inApp" | "email") => run(() => api(`${base}/preferences`, { method: "PATCH", json: { [c.key]: { [ch]: !on(ch) } } })).then(reloadPrefs);
                return (
                  <li key={c.key}>
                    <span className={`notif-icon cat-${c.key}`} aria-hidden>
                      <Icon name={CATEGORY_ICON[c.key] ?? "bell"} width={15} height={15} />
                    </span>
                    <span className="notif-body">
                      <strong>{c.label}</strong>
                      <span className="notif-text">{c.description}</span>
                    </span>
                    <span className="notif-switches">
                      <label className="switch" title={`${c.label} in app`}>
                        <input type="checkbox" checked={on("inApp")} disabled={busy} onChange={() => toggle("inApp")} aria-label={`${c.label} in app`} />
                        <span className="track" />
                      </label>
                      {isPortal ? (
                        c.email ? (
                          <label className="switch" title={`${c.label} by email`}>
                            <input type="checkbox" checked={on("email")} disabled={busy} onChange={() => toggle("email")} aria-label={`${c.label} by email`} />
                            <span className="track" />
                          </label>
                        ) : (
                          <span className="switch-blank" aria-hidden />
                        )
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}
    </>
  );
}

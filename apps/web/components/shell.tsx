"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { api, getToken, setToken } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Icon, type IconName } from "./icons";

type NavItem = readonly [href: string, label: string, icon: IconName];

const MERCHANT_NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Overview",
    items: [
      ["/app", "Home", "home"],
      ["/app/analytics", "Analytics", "chart"],
    ],
  },
  {
    section: "Program",
    items: [
      ["/app/affiliates", "Affiliates", "users"],
      ["/app/offers", "Offers", "tag"],
      ["/app/programs", "Programs", "layers"],
    ],
  },
  {
    section: "Money",
    items: [
      ["/app/conversions", "Conversions", "receipt"],
      ["/app/commissions", "Commissions", "percent"],
      ["/app/payouts", "Payouts", "banknote"],
    ],
  },
  {
    section: "Workspace",
    items: [
      ["/app/messages", "Messages", "mail"],
      ["/app/settings", "Settings", "sliders"],
    ],
  },
];

const PORTAL_NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Promote",
    items: [
      ["/portal", "Home", "home"],
      ["/portal/offers", "Offers", "gift"],
      ["/portal/links", "Links & Codes", "link"],
    ],
  },
  {
    section: "Earnings",
    items: [
      ["/portal/conversions", "Conversions", "receipt"],
      ["/portal/earnings", "Earnings", "percent"],
      ["/portal/payouts", "Payouts", "wallet"],
    ],
  },
  {
    section: "Account",
    items: [["/portal/profile", "Profile", "user"]],
  },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function Shell({ mode, children }: { mode: "merchant" | "portal"; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const nav = mode === "merchant" ? MERCHANT_NAV : PORTAL_NAV;
  const { data, error } = useApi<any>(mode === "merchant" ? "/v1/tenant/me" : "/portal/me");

  useEffect(() => {
    if (!getToken()) router.replace(mode === "portal" ? "/login?portal=1" : "/login");
  }, [mode, router]);

  const tenantName: string = data?.tenant?.name ?? "";
  const who: string = mode === "merchant" ? (data?.user?.name ?? "") : (data?.affiliate?.name ?? "");
  const whoSub: string = mode === "merchant" ? (data?.user?.role ?? "") : "Affiliate";
  const whoLabel = mode === "merchant" ? "Merchant workspace" : "Partner portal";
  const isActive = (href: string) => pathname === href || (href !== "/app" && href !== "/portal" && pathname.startsWith(href));

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">{tenantName ? initials(tenantName) : "A"}</div>
          <div style={{ minWidth: 0 }}>
            <div className="name">{tenantName || "Affiliate Platform"}</div>
            <small>{whoLabel}</small>
          </div>
        </div>
        {nav.map((group) => (
          <div key={group.section}>
            <div className="section">{group.section}</div>
            {group.items.map(([href, label, icon]) => (
              <Link key={href} href={href} className={`nav ${isActive(href) ? "active" : ""}`}>
                <Icon name={icon} />
                {label}
              </Link>
            ))}
          </div>
        ))}
        <div className="spacer" />
        <div className="user">
          <div className="avatar">{who ? initials(who) : "·"}</div>
          <div className="who">
            <strong>{who || "…"}</strong>
            <span style={{ textTransform: "capitalize" }}>{whoSub}</span>
          </div>
          <button
            className="icon-btn"
            title="Sign out"
            aria-label="Sign out"
            onClick={async () => {
              try {
                await api("/v1/auth/logout", { method: "POST" });
              } catch {
                /* ignore */
              }
              setToken(null);
              router.replace(mode === "portal" ? "/login?portal=1" : "/login");
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main className="main">
        {error ? <div className="alert error">{error}</div> : null}
        {children}
      </main>
    </div>
  );
}

/** Brand block for auth and public pages. */
export function AuthBrand({ name, subtitle }: { name?: string; subtitle?: string }) {
  return (
    <div className="auth-brand">
      <div className="mark lg">{name ? initials(name) : "A"}</div>
      <div>
        {name ?? "Affiliate Platform"}
        {subtitle ? <small>{subtitle}</small> : null}
      </div>
    </div>
  );
}

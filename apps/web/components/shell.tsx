"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, signedInHint, setSignedInHint } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Icon, type IconName } from "./icons";
import { brandStyle } from "@/lib/brand";

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
      ["/app/groups", "Groups", "users"],
      ["/app/offers", "Offers", "tag"],
      ["/app/programs", "Programs", "layers"],
      ["/app/assets", "Assets", "image"],
      ["/app/campaigns", "Campaigns", "megaphone"],
    ],
  },
  {
    section: "Money",
    items: [
      ["/app/conversions", "Conversions", "receipt"],
      ["/app/commissions", "Commissions", "percent"],
      ["/app/payouts", "Payouts", "banknote"],
      ["/app/disputes", "Disputes", "alert"],
    ],
  },
  {
    section: "Workspace",
    items: [
      ["/app/messages", "Messages", "mail"],
      ["/app/automation", "Automation", "sliders"],
      ["/app/webhooks", "Webhooks", "link"],
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
      ["/portal/assets", "Assets", "image"],
      ["/portal/campaigns", "Campaigns", "megaphone"],
    ],
  },
  {
    section: "Earnings",
    items: [
      ["/portal/conversions", "Conversions", "receipt"],
      ["/portal/earnings", "Earnings", "percent"],
      ["/portal/payouts", "Payouts", "wallet"],
      ["/portal/disputes", "Disputes", "alert"],
    ],
  },
  {
    section: "Account",
    items: [["/portal/profile", "Profile", "user"]],
  },
];

const PLATFORM_NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Platform",
    items: [
      ["/admin", "Overview", "home"],
      ["/admin/tenants", "Tenants", "layers"],
      ["/admin/jobs", "Jobs", "sliders"],
    ],
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

export function Shell({ mode, children }: { mode: "merchant" | "portal" | "platform"; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const nav = mode === "merchant" ? MERCHANT_NAV : mode === "platform" ? PLATFORM_NAV : PORTAL_NAV;
  const { data, error } = useApi<any>(mode === "portal" ? "/portal/me" : "/v1/tenant/me");
  const [resent, setResent] = useState(false);
  const needsVerification = mode === "merchant" && data?.user && data.user.emailVerified === false;

  useEffect(() => {
    // Fast path for visitors who never signed in; a stale hint still lands on the 401 redirect in api().
    if (!signedInHint()) router.replace(mode === "portal" ? "/login?portal=1" : "/login");
  }, [mode, router]);

  const tenantName: string = data?.tenant?.name ?? "";
  const logoUrl: string | null = data?.tenant?.logoUrl ?? null;
  const brand = brandStyle(data?.tenant?.branding?.primaryColor);
  const who: string = mode === "portal" ? (data?.affiliate?.name ?? "") : (data?.user?.name ?? "");
  const whoSub: string = mode === "portal" ? "Affiliate" : (data?.user?.role ?? "").replace("_", " ");
  const whoLabel = mode === "merchant" ? "Merchant workspace" : mode === "platform" ? "Platform admin" : "Partner portal";
  const isActive = (href: string) => pathname === href || (href !== "/app" && href !== "/portal" && href !== "/admin" && pathname.startsWith(href));

  return (
    <div className="shell branded" style={brand}>
      <aside className="sidebar">
        <div className="brand">
          {logoUrl ? <img className="logo" src={logoUrl} alt="" /> : <div className="mark">{tenantName ? initials(tenantName) : "A"}</div>}
          <div style={{ minWidth: 0 }}>
            <div className="name">{tenantName || "Affiliate Platform"}</div>
            <small>{whoLabel}</small>
          </div>
        </div>
        <nav className="nav-scroll" aria-label="Main">
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
        </nav>
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
              setSignedInHint(false);
              router.replace(mode === "portal" ? "/login?portal=1" : "/login");
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main className="main">
        {error ? <div className="alert error">{error}</div> : null}
        {needsVerification ? (
          <div className="alert info" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name="alert" />
            <span style={{ flex: 1 }}>
              Please verify your email address. We sent a link to <strong>{data.user.email}</strong>.
            </span>
            <button
              className="sm"
              disabled={resent}
              onClick={async () => {
                await api("/v1/tenant/me/resend-verification", { method: "POST" }).catch(() => {});
                setResent(true);
              }}
            >
              {resent ? "Sent" : "Resend"}
            </button>
          </div>
        ) : null}
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

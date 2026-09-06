"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { api, getToken, setToken } from "@/lib/api";
import { useApi } from "@/lib/hooks";

const MERCHANT_NAV = [
  ["/app", "Home"],
  ["/app/affiliates", "Affiliates"],
  ["/app/offers", "Offers"],
  ["/app/programs", "Programs"],
  ["/app/conversions", "Conversions"],
  ["/app/commissions", "Commissions"],
  ["/app/payouts", "Payouts"],
  ["/app/analytics", "Analytics"],
  ["/app/messages", "Messages"],
  ["/app/settings", "Settings"],
] as const;

const PORTAL_NAV = [
  ["/portal", "Home"],
  ["/portal/offers", "Offers"],
  ["/portal/links", "Links & Codes"],
  ["/portal/conversions", "Conversions"],
  ["/portal/earnings", "Earnings"],
  ["/portal/payouts", "Payouts"],
  ["/portal/profile", "Profile"],
] as const;

export function Shell({ mode, children }: { mode: "merchant" | "portal"; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const nav = mode === "merchant" ? MERCHANT_NAV : PORTAL_NAV;
  const { data, error } = useApi<any>(mode === "merchant" ? "/v1/tenant/me" : "/portal/me");

  useEffect(() => {
    if (!getToken()) router.replace(mode === "portal" ? "/login?portal=1" : "/login");
  }, [mode, router]);

  const tenantName = data?.tenant?.name ?? "";
  const who = mode === "merchant" ? data?.principal?.role : data?.affiliate?.name;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          {tenantName || "Affiliate Platform"}
          <small>{mode === "merchant" ? `Merchant · ${who ?? ""}` : `Partner portal · ${who ?? ""}`}</small>
        </div>
        {nav.map(([href, label]) => (
          <Link key={href} href={href} className={`nav ${pathname === href || (href !== "/app" && href !== "/portal" && pathname.startsWith(href)) ? "active" : ""}`}>
            {label}
          </Link>
        ))}
        <div className="spacer" />
        <button
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
          Sign out
        </button>
      </aside>
      <main className="main">
        {error ? <div className="alert error">{error}</div> : null}
        {children}
      </main>
    </div>
  );
}

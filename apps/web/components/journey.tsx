"use client";

import Link from "next/link";
import { dateTime, money } from "@/lib/format";

export type JourneyEventRow = {
  id: string;
  type: "page_view" | "event" | "conversion" | "lead";
  name: string | null;
  url: string | null;
  path: string | null;
  title: string | null;
  referrer: string | null;
  conversionId: string | null;
  sessionId: string;
  affiliateId: string | null;
  properties: Record<string, unknown>;
  occurredAt: string;
};

function humanize(name: string): string {
  const s = name.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Event";
}

function step(e: JourneyEventRow): { text: string; href?: string; outcome?: boolean } {
  if (e.type === "page_view") return { text: `Viewed ${e.title?.trim() || e.path || "a page"}` };
  if (e.type === "event") return { text: humanize(e.name ?? "") };
  if (e.type === "lead") return { text: "Signed up", href: "/app/leads", outcome: true };
  const amount = typeof e.properties?.amountMinor === "number" ? ` · ${money(e.properties.amountMinor as number, (e.properties.currency as string) ?? "USD")}` : "";
  return { text: `Bought${amount}`, href: e.conversionId ? `/app/conversions/${e.conversionId}` : undefined, outcome: true };
}

/** What a visitor did, as a plain list of steps, oldest first: pages viewed, anything the site reported, and the purchase. */
export function JourneyTimeline({ events, empty = "Nothing recorded for this visitor." }: { events: JourneyEventRow[] | null | undefined; empty?: string }) {
  if (!events) return <div className="empty">Loading…</div>;
  if (events.length === 0) return <div className="empty">{empty}</div>;
  return (
    <ol className="journey-steps">
      {events.map((e) => {
        const s = step(e);
        return (
          <li key={e.id}>
            <span className="when">{dateTime(e.occurredAt)}</span>
            <span className="what">
              {s.outcome ? <strong>{s.text}</strong> : s.text}
              {s.href ? (
                <>
                  {" · "}
                  <Link href={s.href}>open</Link>
                </>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

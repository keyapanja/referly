"use client";

import Link from "next/link";
import { dateTime, money } from "@/lib/format";
import { Badge } from "@/components/ui";

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

const TYPE_LABEL: Record<JourneyEventRow["type"], string> = { page_view: "Page", event: "Event", conversion: "Sale", lead: "Lead" };

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function pathOf(url: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** Compact "3 min later" between consecutive events; the absolute time is on the first one of each session. */
function gap(prev: string | undefined, next: string): string | null {
  if (!prev) return null;
  const ms = new Date(next).getTime() - new Date(prev).getTime();
  if (ms < 1000) return null;
  if (ms < 60_000) return `+${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `+${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `+${(ms / 3_600_000).toFixed(1)} h`;
  return `+${Math.round(ms / 86_400_000)} d`;
}

function propsSummary(p: Record<string, unknown>): string {
  const entries = Object.entries(p ?? {}).filter(([k]) => !["amountMinor", "currency", "source", "attributed"].includes(k));
  if (!entries.length) return "";
  return entries
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}

/**
 * A visitor's journey as a vertical timeline. Sessions are separated with a divider; sales
 * and leads are highlighted and link to their record.
 */
export function JourneyTimeline({ events, empty = "No journey recorded for this visitor." }: { events: JourneyEventRow[] | null | undefined; empty?: string }) {
  if (!events) return <div className="empty">Loading…</div>;
  if (events.length === 0) return <div className="empty">{empty}</div>;
  let lastSession: string | null = null;
  let prevAt: string | undefined;
  const first = events[0];
  const referrerHost = hostOf(first?.referrer ?? null);
  return (
    <ol className="journey">
      {events.map((e) => {
        const newSession = e.sessionId !== lastSession;
        const delta = newSession ? null : gap(prevAt, e.occurredAt);
        lastSession = e.sessionId;
        prevAt = e.occurredAt;
        const money_ = typeof e.properties?.amountMinor === "number" ? money(e.properties.amountMinor as number, (e.properties.currency as string) ?? "USD") : null;
        return (
          <li key={e.id} className={`journey-row ${e.type} ${newSession ? "session-start" : ""}`}>
            {newSession ? (
              <div className="journey-session">
                <span>{dateTime(e.occurredAt)}</span>
                {e === first && referrerHost ? <span className="muted">arrived from {referrerHost}</span> : e === first ? <span className="muted">arrived directly</span> : <span className="muted">new visit</span>}
              </div>
            ) : null}
            <div className="journey-item">
              <span className="journey-dot" aria-hidden />
              <span className="journey-when mono">{delta ?? ""}</span>
              <span className="journey-type">
                <Badge value={TYPE_LABEL[e.type].toLowerCase()} />
              </span>
              <span className="journey-what">
                {e.type === "page_view" ? (
                  <>
                    <span className="mono">{e.path ?? pathOf(e.url)}</span>
                    {e.title ? <span className="muted"> · {e.title}</span> : null}
                  </>
                ) : e.type === "event" ? (
                  <>
                    <strong>{e.name}</strong>
                    {propsSummary(e.properties) ? <span className="muted"> · {propsSummary(e.properties)}</span> : null}
                  </>
                ) : (
                  <>
                    <strong>{e.type === "lead" ? "Lead" : "Order"} {e.name}</strong>
                    {money_ ? <span> · {money_}</span> : null}
                    {e.properties?.source ? <span className="muted"> · via {String(e.properties.source)}</span> : null}
                    {e.properties?.attributed === false ? <span className="muted"> · unattributed</span> : null}
                    {e.conversionId ? (
                      <>
                        {" "}
                        <Link href={e.type === "lead" ? "/app/leads" : `/app/conversions/${e.conversionId}`}>open</Link>
                      </>
                    ) : null}
                  </>
                )}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

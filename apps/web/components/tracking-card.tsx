"use client";

import Link from "next/link";
import { dateTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { Badge } from "@/components/ui";

/**
 * Settings → a summary of website tracking. The setup itself lives on its own page, because the
 * per-platform instructions need the room.
 */
export function WebsiteTrackingCard() {
  const { data } = useApi<any>("/v1/tenant/tracking");
  if (!data) return null;

  return (
    <div className="card">
      <h2>Website tracking</h2>
      {!data.enabled ? (
        <>
          <p className="muted">
            One script on your site records what visitors from affiliate links do: pages, events, lead forms, and optionally the order itself, with no checkout work. Off at the moment.
          </p>
          <Link className="btn primary" href="/app/tracking">
            Set up website tracking
          </Link>
        </>
      ) : (
        <>
          <dl className="kv">
            <dt>Status</dt>
            <dd>{data.lastEventAt ? <Badge value="receiving" /> : <Badge value="pending" />}</dd>
            <dt>Last event</dt>
            <dd>{data.lastEventAt ? `${dateTime(data.lastEventAt)}${data.lastEventHost ? ` from ${data.lastEventHost}` : ""}` : "nothing yet"}</dd>
            <dt>Last 7 days</dt>
            <dd>
              {data.events7d} events from {data.visitors7d} visitors
            </dd>
            <dt>Domains</dt>
            <dd>{data.domains.length ? data.domains.join(", ") : <span className="muted">any (not locked down)</span>}</dd>
            <dt>Snippet orders</dt>
            <dd>{data.pixelConversions ? "accepted" : "off"}</dd>
            <dt>Cookie consent</dt>
            <dd>{data.consentMode === "wait" ? "waits for consent" : "not required"}</dd>
          </dl>
          <div className="actions">
            <Link className="btn" href="/app/tracking">
              Setup and code
            </Link>
            <Link className="btn" href="/app/journeys">
              Journeys
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

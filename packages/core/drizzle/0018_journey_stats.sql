CREATE TABLE "journey_stats" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"day" date NOT NULL,
	"affiliate_id" text NOT NULL,
	"page" text DEFAULT '' NOT NULL,
	"stage" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clicks" ADD COLUMN "visitor_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "tracking_last_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "tracking_last_host" text;--> statement-breakpoint
ALTER TABLE "journey_stats" ADD CONSTRAINT "journey_stats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_stats" ADD CONSTRAINT "journey_stats_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_stats_uq" ON "journey_stats" USING btree ("tenant_id","day","affiliate_id","page","stage");--> statement-breakpoint
CREATE INDEX "journey_stats_tenant_day_idx" ON "journey_stats" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE INDEX "clicks_tenant_visitor_idx" ON "clicks" USING btree ("tenant_id","visitor_id");--> statement-breakpoint
ALTER TABLE "journey_stats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journey_stats" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "journey_stats" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint
-- The per-visitor rows go in 0019. Before they do, carry over what is still needed from them. Row-level
-- security is forced on these tables even for their owner, so the copy runs with the bypass on, for this transaction only.
SELECT set_config('app.rls_bypass', 'on', true);--> statement-breakpoint
-- Which visitor landed with which click, so an order that carries a visitor id still finds its click.
UPDATE "clicks" c SET "visitor_id" = j."visitor_id" FROM (SELECT DISTINCT ON ("click_id") "click_id", "visitor_id" FROM "journey_events" WHERE "click_id" IS NOT NULL ORDER BY "click_id", "occurred_at") j WHERE c."id" = j."click_id";--> statement-breakpoint
-- Daily visitor totals per affiliate, so the report does not start from zero.
INSERT INTO "journey_stats" ("id", "tenant_id", "day", "affiliate_id", "page", "stage", "count")
SELECT 'jst_' || substr(md5("tenant_id" || ':' || (("occurred_at" AT TIME ZONE 'UTC')::date)::text || ':' || "affiliate_id"), 1, 21), "tenant_id", ("occurred_at" AT TIME ZONE 'UTC')::date, "affiliate_id", '', 'visit', count(DISTINCT "visitor_id")
FROM "journey_events" WHERE "type" = 'page_view' AND "affiliate_id" IS NOT NULL
GROUP BY "tenant_id", ("occurred_at" AT TIME ZONE 'UTC')::date, "affiliate_id";--> statement-breakpoint
-- When the snippet last reported, for the tracking page's status.
UPDATE "tenants" t SET "tracking_last_at" = j."last_at" FROM (SELECT "tenant_id", max("occurred_at") AS "last_at" FROM "journey_events" WHERE "type" IN ('page_view', 'event') GROUP BY "tenant_id") j WHERE t."id" = j."tenant_id";

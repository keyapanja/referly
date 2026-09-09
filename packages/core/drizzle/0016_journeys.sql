CREATE TABLE "journey_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"seq" serial NOT NULL,
	"visitor_id" text NOT NULL,
	"session_id" text NOT NULL,
	"click_id" text,
	"affiliate_id" text,
	"program_id" text,
	"type" text NOT NULL,
	"name" text,
	"url" text,
	"path" text,
	"title" text,
	"referrer" text,
	"conversion_id" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "site_key" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "tracking" jsonb;--> statement-breakpoint
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_click_id_clicks_id_fk" FOREIGN KEY ("click_id") REFERENCES "public"."clicks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_conversion_id_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."conversions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journey_events_tenant_visitor_idx" ON "journey_events" USING btree ("tenant_id","visitor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "journey_events_tenant_occurred_idx" ON "journey_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "journey_events_tenant_click_idx" ON "journey_events" USING btree ("tenant_id","click_id");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_site_key_unique" UNIQUE("site_key");--> statement-breakpoint
ALTER TABLE "journey_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journey_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "journey_events" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" text NOT NULL,
	"category" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"entity_type" text,
	"entity_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN "notification_prefs" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_prefs" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("tenant_id","recipient_type","recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("tenant_id","recipient_type","recipient_id","read_at");
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));

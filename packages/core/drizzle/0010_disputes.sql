CREATE TABLE "dispute_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"dispute_id" text NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"conversion_id" text,
	"affiliate_id" text,
	"raised_by" text NOT NULL,
	"raised_by_user_id" text,
	"kind" text NOT NULL,
	"order_reference" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"outcome" text,
	"resolution_note" text,
	"previous_conversion_status" text,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dispute_comments" ADD CONSTRAINT "dispute_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_comments" ADD CONSTRAINT "dispute_comments_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispute_comments_dispute_idx" ON "dispute_comments" USING btree ("dispute_id","created_at");--> statement-breakpoint
CREATE INDEX "disputes_tenant_status_idx" ON "disputes" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "disputes_conversion_idx" ON "disputes" USING btree ("conversion_id");
--> statement-breakpoint
ALTER TABLE "disputes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "disputes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "disputes" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "dispute_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dispute_comments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dispute_comments" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));

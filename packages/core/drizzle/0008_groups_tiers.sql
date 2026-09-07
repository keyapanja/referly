CREATE TABLE "affiliate_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"group_id" text NOT NULL,
	"affiliate_id" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'custom' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_rate_tiers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"program_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"group_id" text,
	"metric" text,
	"threshold" bigint,
	"window_days" integer,
	"commission_model" text DEFAULT 'percentage' NOT NULL,
	"commission_rate_bps" integer,
	"commission_fixed_minor" bigint,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_permissions" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "affiliate_group_members" ADD CONSTRAINT "affiliate_group_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_group_members" ADD CONSTRAINT "affiliate_group_members_group_id_affiliate_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."affiliate_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_group_members" ADD CONSTRAINT "affiliate_group_members_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_groups" ADD CONSTRAINT "affiliate_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_rate_tiers" ADD CONSTRAINT "program_rate_tiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_rate_tiers" ADD CONSTRAINT "program_rate_tiers_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_rate_tiers" ADD CONSTRAINT "program_rate_tiers_group_id_affiliate_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."affiliate_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_group_members_uq" ON "affiliate_group_members" USING btree ("group_id","affiliate_id");--> statement-breakpoint
CREATE INDEX "affiliate_group_members_affiliate_idx" ON "affiliate_group_members" USING btree ("tenant_id","affiliate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_groups_name_uq" ON "affiliate_groups" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "program_rate_tiers_program_idx" ON "program_rate_tiers" USING btree ("tenant_id","program_id");
--> statement-breakpoint
ALTER TABLE "affiliate_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "affiliate_groups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "affiliate_groups" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "affiliate_group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "affiliate_group_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "affiliate_group_members" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "program_rate_tiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "program_rate_tiers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "program_rate_tiers" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));

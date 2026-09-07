CREATE TABLE "campaign_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"asset_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"affiliate_id" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_at" timestamp with time zone NOT NULL,
	"joined_at" timestamp with time zone,
	"bonus_awarded_at" timestamp with time zone,
	"bonus_ledger_entry_id" text
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "offer_ids" jsonb;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "commissions" ADD COLUMN "campaign_id" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "campaign_id" text;--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_participants" ADD CONSTRAINT "campaign_participants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_participants" ADD CONSTRAINT "campaign_participants_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_participants" ADD CONSTRAINT "campaign_participants_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_assets_uq" ON "campaign_assets" USING btree ("campaign_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_participants_uq" ON "campaign_participants" USING btree ("campaign_id","affiliate_id");--> statement-breakpoint
CREATE INDEX "campaign_participants_affiliate_idx" ON "campaign_participants" USING btree ("tenant_id","affiliate_id");
--> statement-breakpoint
ALTER TABLE "campaign_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_participants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "campaign_participants" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "campaign_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_assets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "campaign_assets" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));

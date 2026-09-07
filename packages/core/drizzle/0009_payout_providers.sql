CREATE TABLE "tenant_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"credentials_enc" text NOT NULL,
	"hint" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "tenant_integrations" ADD CONSTRAINT "tenant_integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_integrations_uq" ON "tenant_integrations" USING btree ("tenant_id","provider");
--> statement-breakpoint
ALTER TABLE "tenant_integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_integrations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_integrations" FOR ALL USING (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR tenant_id = current_setting('app.tenant_id', true));

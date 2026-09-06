CREATE TABLE "exports" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"entity" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"row_count" integer,
	"size_bytes" integer,
	"storage_key" text,
	"error" text,
	"requested_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exports_tenant_idx" ON "exports" USING btree ("tenant_id","created_at");
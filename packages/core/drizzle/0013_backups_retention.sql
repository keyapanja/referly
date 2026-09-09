CREATE TABLE "maintenance_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"storage_key" text,
	"size_bytes" bigint,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retention" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "maintenance_runs_kind_idx" ON "maintenance_runs" USING btree ("kind","started_at");
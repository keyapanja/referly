ALTER TABLE "affiliates" ADD COLUMN "text_channel" text;--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN "text_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN "text_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_logs" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "message_logs_provider_msg_idx" ON "message_logs" USING btree ("tenant_id","provider_message_id");
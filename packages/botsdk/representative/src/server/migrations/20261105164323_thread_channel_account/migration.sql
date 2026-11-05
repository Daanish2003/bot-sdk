ALTER TABLE "botsdk"."representative_outbound_decision" ADD COLUMN "sent_on" jsonb;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread" ADD COLUMN "channel_account_id" uuid;--> statement-breakpoint
CREATE INDEX "representative_thread_channel_account_idx" ON "botsdk"."representative_thread" ("channel_account_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread" ADD CONSTRAINT "representative_thread_bseS0b32iFZM_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "botsdk"."channel_account"("id") ON DELETE SET NULL;
CREATE TABLE "botsdk"."representative_call" (
	"id" uuid PRIMARY KEY,
	"call_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"channel_account_id" uuid,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"requests" jsonb DEFAULT '[]' NOT NULL,
	CONSTRAINT "representative_call_call_id" UNIQUE("channel_account_id","call_id")
);
--> statement-breakpoint
CREATE INDEX "representative_call_thread_idx" ON "botsdk"."representative_call" ("thread_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_call" ADD CONSTRAINT "representative_call_thread_id_representative_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "botsdk"."representative_thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_call" ADD CONSTRAINT "representative_call_channel_account_id_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "botsdk"."channel_account"("id") ON DELETE SET NULL;
CREATE TABLE "botsdk"."representative_thread_mail" (
	"thread_id" uuid PRIMARY KEY,
	"subject" text NOT NULL,
	"message_ids" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread_mail" ADD CONSTRAINT "representative_thread_mail_bPgeKgiNnvzw_fkey" FOREIGN KEY ("thread_id") REFERENCES "botsdk"."representative_thread"("id") ON DELETE CASCADE;
ALTER TABLE "botsdk"."representative_thread_message" ADD COLUMN "reply_kind" text;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread_message" ADD COLUMN "sources" jsonb;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread_message" ADD COLUMN "assignment_id" uuid;
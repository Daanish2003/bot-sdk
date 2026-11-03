ALTER TABLE "botsdk"."representative_thread" ADD COLUMN "turn_id" uuid;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread" ADD COLUMN "waiting_from" integer;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread" ADD COLUMN "waiting_since" timestamp;
ALTER TABLE "botsdk"."representative_call" ADD COLUMN "external_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_call" ADD COLUMN "message_id" uuid;
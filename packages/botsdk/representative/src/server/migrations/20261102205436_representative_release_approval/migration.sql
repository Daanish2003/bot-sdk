ALTER TABLE "botsdk"."representative" ADD COLUMN "pending_approval" jsonb;--> statement-breakpoint
ALTER TABLE "botsdk"."representative" ADD COLUMN "bot_draft_hash" text;
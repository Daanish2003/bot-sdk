ALTER TYPE "botsdk"."bot_trigger_skip_reason" ADD VALUE 'hop_limit';--> statement-breakpoint
ALTER TYPE "botsdk"."bot_trigger_source" ADD VALUE 'agent';--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD COLUMN "hops" integer DEFAULT 0 NOT NULL;
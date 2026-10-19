ALTER TYPE "chat"."bot_trigger_channel" ADD VALUE 'schedule';--> statement-breakpoint
ALTER TYPE "chat"."bot_trigger_channel" ADD VALUE 'webhook';--> statement-breakpoint
ALTER TYPE "chat"."bot_trigger_source" ADD VALUE 'routine';--> statement-breakpoint
ALTER TYPE "chat"."bot_trigger_source" ADD VALUE 'check_in';--> statement-breakpoint
ALTER TABLE "chat"."bot_trigger" ADD COLUMN "text" text;
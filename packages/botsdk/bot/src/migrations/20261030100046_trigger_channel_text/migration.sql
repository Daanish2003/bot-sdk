ALTER TABLE "botsdk"."bot_trigger" ALTER COLUMN "channel" SET DATA TYPE text USING "channel"::text;--> statement-breakpoint
DROP TYPE "botsdk"."bot_trigger_channel";
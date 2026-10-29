CREATE TYPE "botsdk"."bot_trigger_skip_reason" AS ENUM('cancelled', 'paused', 'reset');--> statement-breakpoint
ALTER TYPE "botsdk"."message_role" ADD VALUE 'reset';--> statement-breakpoint
ALTER TABLE "botsdk"."bot" ADD COLUMN "paused_at" timestamp;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD COLUMN "skipped_at" timestamp;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD COLUMN "skip_reason" "botsdk"."bot_trigger_skip_reason";--> statement-breakpoint
DROP INDEX "botsdk"."bot_trigger_waiting_idx";--> statement-breakpoint
CREATE INDEX "bot_trigger_waiting_idx" ON "botsdk"."bot_trigger" ("conversation_id","received_at") WHERE "turn_id" is null and "skipped_at" is null;--> statement-breakpoint
CREATE INDEX "bot_trigger_skipped_idx" ON "botsdk"."bot_trigger" ("conversation_id","skipped_at") WHERE "skipped_at" is not null;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD CONSTRAINT "bot_trigger_skipped_check" CHECK (("skipped_at" is null) = ("skip_reason" is null) and ("skipped_at" is null or "turn_id" is null));
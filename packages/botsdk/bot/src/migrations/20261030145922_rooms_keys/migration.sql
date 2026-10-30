DROP INDEX "botsdk"."bot_turn_running_bot_id_idx";--> statement-breakpoint
ALTER TABLE "botsdk"."message" ADD COLUMN "author_bot_id" uuid;--> statement-breakpoint
UPDATE "botsdk"."message" SET "author_bot_id" = "bot"."id" FROM "botsdk"."bot" WHERE "bot"."conversation_id" = "message"."conversation_id" AND "message"."role" = 'assistant';--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
UPDATE "botsdk"."bot_trigger" SET "bot_id" = "bot"."id" FROM "botsdk"."bot" WHERE "bot"."conversation_id" = "bot_trigger"."conversation_id";--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ALTER COLUMN "bot_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_turn" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
UPDATE "botsdk"."bot_turn" SET "conversation_id" = "bot"."conversation_id" FROM "botsdk"."bot" WHERE "bot"."id" = "bot_turn"."bot_id";--> statement-breakpoint
ALTER TABLE "botsdk"."bot_turn" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" DROP CONSTRAINT "bot_trigger_pkey";--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD CONSTRAINT "bot_trigger_pkey" PRIMARY KEY("id","bot_id");--> statement-breakpoint
DROP INDEX "botsdk"."bot_trigger_waiting_idx";--> statement-breakpoint
CREATE INDEX "bot_trigger_waiting_idx" ON "botsdk"."bot_trigger" ("conversation_id","bot_id","received_at") WHERE "turn_id" is null and "skipped_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_turn_running_bot_id_conversation_id_idx" ON "botsdk"."bot_turn" ("bot_id","conversation_id") WHERE "status" = 'running';--> statement-breakpoint
ALTER TABLE "botsdk"."message" ADD CONSTRAINT "message_author_bot_id_bot_id_fkey" FOREIGN KEY ("author_bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD CONSTRAINT "bot_trigger_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_turn" ADD CONSTRAINT "bot_turn_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "botsdk"."conversation"("id") ON DELETE CASCADE;

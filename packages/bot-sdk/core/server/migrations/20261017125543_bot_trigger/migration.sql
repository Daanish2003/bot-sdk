CREATE TYPE "chat"."bot_trigger_channel" AS ENUM('web');--> statement-breakpoint
CREATE TYPE "chat"."bot_trigger_source" AS ENUM('user');--> statement-breakpoint
CREATE TABLE "chat"."bot_trigger" (
	"id" text PRIMARY KEY,
	"conversation_id" uuid NOT NULL,
	"source" "chat"."bot_trigger_source" NOT NULL,
	"channel" "chat"."bot_trigger_channel" NOT NULL,
	"message_id" uuid,
	"turn_id" uuid,
	"received_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bot_trigger_conversation_id_received_at_idx" ON "chat"."bot_trigger" ("conversation_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_turn_running_bot_id_idx" ON "chat"."bot_turn" ("bot_id") WHERE "status" = 'running';--> statement-breakpoint
ALTER TABLE "chat"."bot_trigger" ADD CONSTRAINT "bot_trigger_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_trigger" ADD CONSTRAINT "bot_trigger_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."message"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chat"."bot_trigger" ADD CONSTRAINT "bot_trigger_turn_id_bot_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "chat"."bot_turn"("id") ON DELETE CASCADE;
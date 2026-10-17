CREATE TYPE "chat"."bot_turn_status" AS ENUM('running', 'complete', 'error', 'stopped');--> statement-breakpoint
CREATE TABLE "chat"."bot_turn" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"status" "chat"."bot_turn_status" NOT NULL,
	"error" text,
	"usage" jsonb,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"transcript" jsonb
);
--> statement-breakpoint
CREATE INDEX "bot_turn_bot_id_started_at_idx" ON "chat"."bot_turn" ("bot_id","started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "chat"."bot_turn" ADD CONSTRAINT "bot_turn_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "chat"."bot"("id") ON DELETE CASCADE;
CREATE TYPE "chat"."bot_routine_state" AS ENUM('pending', 'active', 'paused');--> statement-breakpoint
CREATE TABLE "chat"."bot_routine" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule" jsonb,
	"time_zone" text NOT NULL,
	"state" "chat"."bot_routine_state" NOT NULL,
	"created_by_turn_id" uuid NOT NULL,
	"approved_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bot_routine_bot_id_name_idx" ON "chat"."bot_routine" ("bot_id","name");--> statement-breakpoint
ALTER TABLE "chat"."bot_routine" ADD CONSTRAINT "bot_routine_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "chat"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_routine" ADD CONSTRAINT "bot_routine_created_by_turn_id_bot_turn_id_fkey" FOREIGN KEY ("created_by_turn_id") REFERENCES "chat"."bot_turn"("id") ON DELETE CASCADE;
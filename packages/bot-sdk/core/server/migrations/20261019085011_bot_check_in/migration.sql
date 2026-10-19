CREATE TYPE "chat"."bot_check_in_state" AS ENUM('pending', 'fired', 'cancelled');--> statement-breakpoint
CREATE TABLE "chat"."bot_check_in" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"at" timestamp NOT NULL,
	"note" text NOT NULL,
	"state" "chat"."bot_check_in_state" NOT NULL,
	"created_by_turn_id" uuid NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bot_check_in_bot_id_idx" ON "chat"."bot_check_in" ("bot_id");--> statement-breakpoint
ALTER TABLE "chat"."bot_check_in" ADD CONSTRAINT "bot_check_in_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "chat"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_check_in" ADD CONSTRAINT "bot_check_in_created_by_turn_id_bot_turn_id_fkey" FOREIGN KEY ("created_by_turn_id") REFERENCES "chat"."bot_turn"("id") ON DELETE CASCADE;
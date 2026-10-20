CREATE TYPE "chat"."bot_summary_kind" AS ENUM('away', 'mid_turn');--> statement-breakpoint
CREATE TABLE "chat"."bot_summary" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"text" text NOT NULL,
	"covers_until" timestamp NOT NULL,
	"kind" "chat"."bot_summary_kind" NOT NULL,
	"turn_id" uuid,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bot_summary_bot_id_created_at_idx" ON "chat"."bot_summary" ("bot_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "chat"."bot_prompt_start" ADD CONSTRAINT "bot_prompt_start_summary_id_bot_summary_id_fkey" FOREIGN KEY ("summary_id") REFERENCES "chat"."bot_summary"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_summary" ADD CONSTRAINT "bot_summary_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "chat"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_summary" ADD CONSTRAINT "bot_summary_turn_id_bot_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "chat"."bot_turn"("id") ON DELETE SET NULL;
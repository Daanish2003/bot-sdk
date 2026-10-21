CREATE TYPE "chat"."bot_review_state" AS ENUM('waiting', 'allowed', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "chat"."bot_review_verdict" AS ENUM('pass', 'block');--> statement-breakpoint
ALTER TYPE "chat"."usage_kind" ADD VALUE 'review';--> statement-breakpoint
CREATE TABLE "chat"."bot_review" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"turn_id" uuid,
	"helper_id" uuid,
	"tool_call_id" text NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"summary" text NOT NULL,
	"verdict" "chat"."bot_review_verdict" NOT NULL,
	"reason" text NOT NULL,
	"state" "chat"."bot_review_state",
	"deadline" timestamp,
	"decided_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bot_review_bot_id_created_at_idx" ON "chat"."bot_review" ("bot_id","created_at");--> statement-breakpoint
ALTER TABLE "chat"."bot_review" ADD CONSTRAINT "bot_review_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "chat"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_review" ADD CONSTRAINT "bot_review_turn_id_bot_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "chat"."bot_turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_review" ADD CONSTRAINT "bot_review_helper_id_bot_helper_id_fkey" FOREIGN KEY ("helper_id") REFERENCES "chat"."bot_helper"("id") ON DELETE CASCADE;
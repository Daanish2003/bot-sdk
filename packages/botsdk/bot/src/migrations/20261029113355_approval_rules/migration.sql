CREATE TYPE "botsdk"."custom_rule_mode" AS ENUM('without_asking', 'pre_approved', 'ask', 'hand_off');--> statement-breakpoint
CREATE TYPE "botsdk"."custom_rule_state" AS ENUM('active', 'proposed');--> statement-breakpoint
ALTER TYPE "botsdk"."bot_review_state" ADD VALUE 'pending' BEFORE 'allowed';--> statement-breakpoint
ALTER TYPE "botsdk"."bot_review_verdict" ADD VALUE 'never';--> statement-breakpoint
ALTER TYPE "botsdk"."bot_trigger_source" ADD VALUE 'approval';--> statement-breakpoint
CREATE TABLE "botsdk"."custom_rule" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"mode" "botsdk"."custom_rule_mode" NOT NULL,
	"state" "botsdk"."custom_rule_state" NOT NULL,
	"proposed_by_bot_id" uuid,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "botsdk"."bot_review" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
CREATE INDEX "custom_rule_user_id_created_at_idx" ON "botsdk"."custom_rule" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "custom_rule_proposed_by_bot_id_idx" ON "botsdk"."custom_rule" ("proposed_by_bot_id");--> statement-breakpoint
ALTER TABLE "botsdk"."custom_rule" ADD CONSTRAINT "custom_rule_proposed_by_bot_id_bot_id_fkey" FOREIGN KEY ("proposed_by_bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE SET NULL;
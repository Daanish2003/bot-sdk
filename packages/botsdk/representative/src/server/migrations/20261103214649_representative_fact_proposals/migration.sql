CREATE TABLE "botsdk"."representative_fact_proposal" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"bot_id" uuid NOT NULL,
	"key" text NOT NULL,
	"proposed" jsonb NOT NULL,
	"why" text NOT NULL,
	"card_id" text NOT NULL,
	"call" text,
	"posted_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "representative_fact_proposal_key" UNIQUE("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative_fact_log" ADD COLUMN "proposed_by" text;--> statement-breakpoint
CREATE INDEX "representative_fact_proposal_bot_idx" ON "botsdk"."representative_fact_proposal" ("bot_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_fact_proposal" ADD CONSTRAINT "representative_fact_proposal_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;
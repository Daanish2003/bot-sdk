CREATE TABLE "botsdk"."representative_gap" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"representative_id" uuid,
	"question" text NOT NULL,
	"normalized" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_at" timestamp NOT NULL,
	"last_at" timestamp NOT NULL,
	"closed_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "representative_gap_open_idx" ON "botsdk"."representative_gap" ("user_id","normalized") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "representative_gap_user_idx" ON "botsdk"."representative_gap" ("user_id","last_at");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_gap" ADD CONSTRAINT "representative_gap_representative_id_representative_id_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE SET NULL;
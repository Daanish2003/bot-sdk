CREATE TABLE "botsdk"."representative_test_result" (
	"id" uuid PRIMARY KEY,
	"representative_id" uuid NOT NULL,
	"draft_hash" text NOT NULL,
	"position" integer NOT NULL,
	"status" text NOT NULL,
	"transcript" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "representative_test_result_position" UNIQUE("representative_id","position")
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative_release" ADD COLUMN "override_reason" text;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_test_result" ADD CONSTRAINT "representative_test_result_enxpE5vSFupS_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;
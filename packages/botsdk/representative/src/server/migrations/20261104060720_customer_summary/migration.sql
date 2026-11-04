CREATE TABLE "botsdk"."representative_customer_summary" (
	"id" uuid PRIMARY KEY,
	"thread_id" uuid NOT NULL CONSTRAINT "representative_customer_summary_thread" UNIQUE,
	"user_id" text NOT NULL,
	"text" text,
	"skipped" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "representative_customer_summary_user_idx" ON "botsdk"."representative_customer_summary" ("user_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_customer_summary" ADD CONSTRAINT "representative_customer_summary_RvVjEVqrmHvt_fkey" FOREIGN KEY ("thread_id") REFERENCES "botsdk"."representative_thread"("id") ON DELETE CASCADE;
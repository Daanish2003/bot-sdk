CREATE TABLE "botsdk"."representative_email_address" (
	"representative_id" uuid PRIMARY KEY,
	"address" text NOT NULL CONSTRAINT "representative_email_address_address" UNIQUE,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative_email_address" ADD CONSTRAINT "representative_email_address_AZlCdFfaxSkv_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;
ALTER TABLE "botsdk"."representative_customer_identity" ADD COLUMN "verified_contact_at" timestamp;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_customer_identity" ADD COLUMN "lapsed_at" timestamp;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread_message" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;
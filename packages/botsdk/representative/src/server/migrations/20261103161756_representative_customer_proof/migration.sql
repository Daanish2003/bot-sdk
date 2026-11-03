CREATE TABLE "botsdk"."representative_verification" (
	"id" uuid PRIMARY KEY,
	"sender_identity_id" uuid NOT NULL,
	"target_identity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative_customer_identity" ADD COLUMN "proven_until" timestamp;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread_message" ADD COLUMN "proof_rule" text;--> statement-breakpoint
CREATE INDEX "representative_verification_sender_idx" ON "botsdk"."representative_verification" ("sender_identity_id","created_at");--> statement-breakpoint
CREATE INDEX "representative_verification_target_idx" ON "botsdk"."representative_verification" ("target_identity_id","created_at");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_verification" ADD CONSTRAINT "representative_verification_7Gh33xVIgHII_fkey" FOREIGN KEY ("sender_identity_id") REFERENCES "botsdk"."representative_customer_identity"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_verification" ADD CONSTRAINT "representative_verification_A3Cuu01hb7X4_fkey" FOREIGN KEY ("target_identity_id") REFERENCES "botsdk"."representative_customer_identity"("id") ON DELETE CASCADE;
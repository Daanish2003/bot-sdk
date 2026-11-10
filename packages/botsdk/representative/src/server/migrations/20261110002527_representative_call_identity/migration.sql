ALTER TABLE "botsdk"."representative_call" ADD COLUMN "identity_id" uuid;--> statement-breakpoint
CREATE INDEX "representative_call_identity_idx" ON "botsdk"."representative_call" ("identity_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_call" ADD CONSTRAINT "representative_call_JtzEyJh3XxNT_fkey" FOREIGN KEY ("identity_id") REFERENCES "botsdk"."representative_customer_identity"("id") ON DELETE CASCADE;--> statement-breakpoint
UPDATE "botsdk"."representative_call" AS "call"
SET "identity_id" = "identity"."id"
FROM "botsdk"."representative_thread" AS "thread", "botsdk"."representative" AS "representative", "botsdk"."representative_customer_identity" AS "identity"
WHERE "thread"."id" = "call"."thread_id"
  AND "representative"."id" = "thread"."representative_id"
  AND "identity"."user_id" = "representative"."user_id"
  AND "identity"."channel" = 'sms'
  AND "identity"."external_id" = "call"."external_id";

ALTER TABLE "botsdk"."representative_hand_off" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_hand_off" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_hand_off" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_hand_off" ADD COLUMN "verified" boolean;--> statement-breakpoint
CREATE INDEX "representative_hand_off_thread_idx" ON "botsdk"."representative_hand_off" ("thread_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_hand_off" ADD CONSTRAINT "representative_hand_off_thread_id_representative_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "botsdk"."representative_thread"("id") ON DELETE SET NULL;
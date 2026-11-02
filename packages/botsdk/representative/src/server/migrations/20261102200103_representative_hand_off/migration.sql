CREATE TABLE "botsdk"."representative_hand_off" (
	"assignment_id" uuid PRIMARY KEY,
	"representative_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE INDEX "representative_hand_off_representative_idx" ON "botsdk"."representative_hand_off" ("representative_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_hand_off" ADD CONSTRAINT "representative_hand_off_assignment_id_bot_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "botsdk"."bot_assignment"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_hand_off" ADD CONSTRAINT "representative_hand_off_jlibJorNz5g3_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;
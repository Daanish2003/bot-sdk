CREATE TABLE "botsdk"."representative_turn" (
	"id" uuid PRIMARY KEY,
	"thread_id" uuid NOT NULL,
	"representative_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative" ADD COLUMN "spending_caps" jsonb DEFAULT '{"threadCalls":30,"threadMicros":500000,"customerCalls":60,"customerMicros":2000000,"strangerCalls":20,"strangerMicros":500000,"monthMicros":50000000}' NOT NULL;--> statement-breakpoint
CREATE INDEX "representative_turn_thread_idx" ON "botsdk"."representative_turn" ("thread_id");--> statement-breakpoint
CREATE INDEX "representative_turn_representative_idx" ON "botsdk"."representative_turn" ("representative_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_turn" ADD CONSTRAINT "representative_turn_thread_id_representative_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "botsdk"."representative_thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_turn" ADD CONSTRAINT "representative_turn_representative_id_representative_id_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;
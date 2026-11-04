CREATE TABLE "botsdk"."representative_held_message" (
	"id" uuid PRIMARY KEY,
	"decision_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"text" text NOT NULL,
	"verified" boolean NOT NULL,
	"reply_kind" text,
	"sources" jsonb,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."representative_outbound_decision" (
	"id" uuid PRIMARY KEY,
	"thread_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"rule" text NOT NULL,
	"release_id" uuid,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"message_id" uuid,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "representative_held_message_thread_idx" ON "botsdk"."representative_held_message" ("thread_id");--> statement-breakpoint
CREATE INDEX "representative_held_message_decision_idx" ON "botsdk"."representative_held_message" ("decision_id");--> statement-breakpoint
CREATE INDEX "representative_outbound_decision_thread_idx" ON "botsdk"."representative_outbound_decision" ("thread_id","id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_held_message" ADD CONSTRAINT "representative_held_message_PxtN6KwsDPck_fkey" FOREIGN KEY ("decision_id") REFERENCES "botsdk"."representative_outbound_decision"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_held_message" ADD CONSTRAINT "representative_held_message_67Mn8IXnVNv3_fkey" FOREIGN KEY ("thread_id") REFERENCES "botsdk"."representative_thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_outbound_decision" ADD CONSTRAINT "representative_outbound_decision_aKCQN6beYYqp_fkey" FOREIGN KEY ("thread_id") REFERENCES "botsdk"."representative_thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_outbound_decision" ADD CONSTRAINT "representative_outbound_decision_fom6AwgNamZ0_fkey" FOREIGN KEY ("message_id") REFERENCES "botsdk"."representative_thread_message"("id") ON DELETE SET NULL;
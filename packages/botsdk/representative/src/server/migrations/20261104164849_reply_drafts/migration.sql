CREATE TABLE "botsdk"."representative_topic" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"mode" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative_held_message" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_held_message" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_held_message" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_held_message" ADD COLUMN "message_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "representative_topic_name" ON "botsdk"."representative_topic" ("user_id",lower("name"));--> statement-breakpoint
ALTER TABLE "botsdk"."representative_held_message" ADD CONSTRAINT "representative_held_message_ibTr1D0dYPt4_fkey" FOREIGN KEY ("message_id") REFERENCES "botsdk"."representative_thread_message"("id") ON DELETE SET NULL;
CREATE TYPE "chat"."bot_demonstration_event_kind" AS ENUM('click', 'input', 'change', 'key', 'navigation', 'pause');--> statement-breakpoint
CREATE TABLE "chat"."bot_demonstration_event" (
	"id" uuid PRIMARY KEY,
	"demonstration_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"offset_ms" integer NOT NULL,
	"kind" "chat"."bot_demonstration_event_kind" NOT NULL,
	"url" text,
	"label" text,
	"selector" text,
	"value" text,
	"screenshot_key" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bot_demonstration_event_demonstration_id_sequence_idx" ON "chat"."bot_demonstration_event" ("demonstration_id","sequence");--> statement-breakpoint
ALTER TABLE "chat"."bot_demonstration_event" ADD CONSTRAINT "bot_demonstration_event_td6uldhf24W6_fkey" FOREIGN KEY ("demonstration_id") REFERENCES "chat"."bot_demonstration"("id") ON DELETE CASCADE;
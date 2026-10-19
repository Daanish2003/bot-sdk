CREATE TABLE "chat"."bot_helper_message" (
	"id" uuid PRIMARY KEY,
	"helper_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"delivered_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "bot_helper_message_helper_id_idx" ON "chat"."bot_helper_message" ("helper_id","created_at");--> statement-breakpoint
ALTER TABLE "chat"."bot_helper_message" ADD CONSTRAINT "bot_helper_message_helper_id_bot_helper_id_fkey" FOREIGN KEY ("helper_id") REFERENCES "chat"."bot_helper"("id") ON DELETE CASCADE;
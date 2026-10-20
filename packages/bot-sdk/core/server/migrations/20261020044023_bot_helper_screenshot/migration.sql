CREATE TABLE "chat"."bot_helper_screenshot" (
	"id" uuid PRIMARY KEY,
	"helper_id" uuid NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bot_helper_screenshot_helper_id_idx" ON "chat"."bot_helper_screenshot" ("helper_id");--> statement-breakpoint
ALTER TABLE "chat"."bot_helper_screenshot" ADD CONSTRAINT "bot_helper_screenshot_helper_id_bot_helper_id_fkey" FOREIGN KEY ("helper_id") REFERENCES "chat"."bot_helper"("id") ON DELETE CASCADE;
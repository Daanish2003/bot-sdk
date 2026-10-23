CREATE TABLE "chat"."bot_upload" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bot_upload_created_at_idx" ON "chat"."bot_upload" ("created_at");--> statement-breakpoint
CREATE INDEX "bot_upload_user_id_idx" ON "chat"."bot_upload" ("user_id");
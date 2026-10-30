CREATE TYPE "botsdk"."channel_account_status" AS ENUM('active', 'needs_attention');--> statement-breakpoint
CREATE TABLE "botsdk"."channel_account" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"platform_bot_id" text NOT NULL,
	"handle" text NOT NULL,
	"encrypted" text NOT NULL,
	"status" "botsdk"."channel_account_status" NOT NULL,
	"reason" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "channel_account_bot_platform_unique" UNIQUE("bot_id","platform"),
	CONSTRAINT "channel_account_platform_bot_unique" UNIQUE("platform","platform_bot_id"),
	CONSTRAINT "channel_account_reason_check" CHECK (("status" = 'needs_attention') = ("reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "botsdk"."channel_account" ADD CONSTRAINT "channel_account_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;
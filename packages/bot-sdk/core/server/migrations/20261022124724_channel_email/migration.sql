ALTER TYPE "chat"."bot_trigger_channel" ADD VALUE 'email';--> statement-breakpoint
CREATE TABLE "chat"."channel_email_address" (
	"bot_id" uuid PRIMARY KEY,
	"address" text NOT NULL UNIQUE,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat"."channel_email_address" ADD CONSTRAINT "channel_email_address_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "chat"."bot"("id") ON DELETE CASCADE;
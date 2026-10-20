CREATE TABLE "chat"."memory_settings" (
	"user_id" text PRIMARY KEY,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
-- The Memory switch moves to the memory plugin (ADR 0013, the #616 amendment): each user's value is copied before the old column goes.
INSERT INTO "chat"."memory_settings" ("user_id", "enabled") SELECT "user_id", "memory_enabled" FROM "chat"."user_settings";--> statement-breakpoint
ALTER TABLE "chat"."user_settings" DROP COLUMN "memory_enabled";
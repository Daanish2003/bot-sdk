CREATE TABLE "chat"."memory_settings" (
	"user_id" text PRIMARY KEY,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
-- The Memory switch moves to the memory plugin (ADR 0013, the #616 amendment): each switch turned off is copied before the old column goes. A user with no row has Memory on, so the others need none.
INSERT INTO "chat"."memory_settings" ("user_id", "enabled") SELECT "user_id", "memory_enabled" FROM "chat"."user_settings" WHERE NOT "memory_enabled";--> statement-breakpoint
ALTER TABLE "chat"."user_settings" DROP COLUMN "memory_enabled";
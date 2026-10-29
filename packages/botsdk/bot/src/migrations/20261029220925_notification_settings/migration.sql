CREATE TYPE "botsdk"."notification_route" AS ENUM('in_app', 'email');--> statement-breakpoint
CREATE TABLE "botsdk"."notification_settings" (
	"user_id" text PRIMARY KEY,
	"quiet_start" text,
	"quiet_end" text,
	"urgent_route" "botsdk"."notification_route",
	"other_route" "botsdk"."notification_route",
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "notification_settings_quiet_hours_check" CHECK (("quiet_start" is null) = ("quiet_end" is null) and ("quiet_start" is null or "quiet_start" <> "quiet_end"))
);

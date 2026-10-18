CREATE TYPE "chat"."computer_state" AS ENUM('asleep', 'awake');--> statement-breakpoint
CREATE TABLE "chat"."computer" (
	"user_id" text PRIMARY KEY,
	"sandbox_id" text,
	"template" text,
	"state" "chat"."computer_state" NOT NULL,
	"last_active_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL
);

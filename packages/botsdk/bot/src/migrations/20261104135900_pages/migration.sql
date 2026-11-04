CREATE TYPE "botsdk"."page_urgency" AS ENUM('routine', 'emergency');--> statement-breakpoint
CREATE TABLE "botsdk"."page" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"cause" text NOT NULL,
	"urgency" "botsdk"."page_urgency" NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"acknowledged_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "page_user_id_created_at_idx" ON "botsdk"."page" ("user_id","created_at");
CREATE TABLE "botsdk"."representative_fact" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"topic" text NOT NULL,
	"value" text NOT NULL,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "representative_fact_key" UNIQUE("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "botsdk"."representative_fact_log" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"action" text NOT NULL,
	"old" jsonb,
	"new" jsonb,
	"at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "representative_fact_log_user_idx" ON "botsdk"."representative_fact_log" ("user_id","at");
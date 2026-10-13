CREATE TYPE "chat"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "chat"."job" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "chat"."job_status" DEFAULT 'queued'::"chat"."job_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"last_error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_idempotency_key_active_idx" ON "chat"."job" ("idempotency_key") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "chat"."job" ("status","run_after");
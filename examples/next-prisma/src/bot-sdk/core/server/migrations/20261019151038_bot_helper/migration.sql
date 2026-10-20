CREATE TYPE "chat"."bot_helper_status" AS ENUM('running', 'waiting', 'complete', 'error', 'stopped');--> statement-breakpoint
CREATE TYPE "chat"."bot_helper_type" AS ENUM('general', 'computer_use');--> statement-breakpoint
ALTER TYPE "chat"."bot_trigger_channel" ADD VALUE 'helper';--> statement-breakpoint
ALTER TYPE "chat"."bot_trigger_source" ADD VALUE 'helper';--> statement-breakpoint
ALTER TYPE "chat"."usage_kind" ADD VALUE 'helper';--> statement-breakpoint
CREATE TABLE "chat"."bot_helper" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"type" "chat"."bot_helper_type" NOT NULL,
	"task" text NOT NULL,
	"status" "chat"."bot_helper_status" NOT NULL,
	"report" text,
	"started_by_turn_id" uuid NOT NULL,
	"job_id" uuid,
	"transcript" jsonb,
	"usage" jsonb,
	"screen" integer,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "bot_helper_bot_id_status_idx" ON "chat"."bot_helper" ("bot_id","status");--> statement-breakpoint
ALTER TABLE "chat"."bot_helper" ADD CONSTRAINT "bot_helper_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "chat"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_helper" ADD CONSTRAINT "bot_helper_started_by_turn_id_bot_turn_id_fkey" FOREIGN KEY ("started_by_turn_id") REFERENCES "chat"."bot_turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_helper" ADD CONSTRAINT "bot_helper_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "chat"."job"("id") ON DELETE SET NULL;
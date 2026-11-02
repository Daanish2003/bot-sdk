CREATE TYPE "botsdk"."bot_assignment_actor" AS ENUM('bot', 'user', 'system');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_assignment_status" AS ENUM('open', 'working', 'blocked', 'done', 'failed', 'cancelled');--> statement-breakpoint
ALTER TYPE "botsdk"."bot_trigger_source" ADD VALUE 'assignment';--> statement-breakpoint
CREATE TABLE "botsdk"."bot_assignment" (
	"id" uuid PRIMARY KEY,
	"assigned_bot_id" uuid NOT NULL,
	"assigner_bot_id" uuid,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"status" "botsdk"."bot_assignment_status" NOT NULL,
	"result" jsonb,
	"overdue_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ended_at" timestamp,
	CONSTRAINT "bot_assignment_result_check" CHECK (("status" in ('done', 'failed')) = ("result" is not null))
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_assignment_log" (
	"id" uuid PRIMARY KEY,
	"assignment_id" uuid NOT NULL,
	"status" "botsdk"."bot_assignment_status" NOT NULL,
	"actor" "botsdk"."bot_assignment_actor" NOT NULL,
	"actor_bot_id" uuid,
	"note" text,
	"turn_id" uuid,
	"at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bot_assignment_assigned_bot_id_idx" ON "botsdk"."bot_assignment" ("assigned_bot_id");--> statement-breakpoint
CREATE INDEX "bot_assignment_assigner_bot_id_idx" ON "botsdk"."bot_assignment" ("assigner_bot_id");--> statement-breakpoint
CREATE INDEX "bot_assignment_log_assignment_id_idx" ON "botsdk"."bot_assignment_log" ("assignment_id");--> statement-breakpoint
CREATE INDEX "bot_trigger_bot_id_source_idx" ON "botsdk"."bot_trigger" ("bot_id","source");--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD CONSTRAINT "bot_assignment_assigned_bot_id_bot_id_fkey" FOREIGN KEY ("assigned_bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD CONSTRAINT "bot_assignment_assigner_bot_id_bot_id_fkey" FOREIGN KEY ("assigner_bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment_log" ADD CONSTRAINT "bot_assignment_log_assignment_id_bot_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "botsdk"."bot_assignment"("id") ON DELETE CASCADE;
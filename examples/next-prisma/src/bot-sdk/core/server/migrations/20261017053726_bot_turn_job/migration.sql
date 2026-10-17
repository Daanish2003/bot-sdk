ALTER TABLE "chat"."bot_turn" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "chat"."bot_turn" DROP COLUMN "heartbeat_at";--> statement-breakpoint
ALTER TABLE "chat"."bot_turn" ADD CONSTRAINT "bot_turn_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "chat"."job"("id") ON DELETE SET NULL;--> statement-breakpoint
-- A Turn left running before Turns ran as jobs has no job to end it.
UPDATE "chat"."bot_turn" SET "status" = 'error', "error" = 'interrupted', "ended_at" = now() WHERE "status" = 'running';
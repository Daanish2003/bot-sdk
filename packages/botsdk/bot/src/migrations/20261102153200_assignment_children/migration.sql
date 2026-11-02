ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "parent_assignment_id" uuid;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "depth" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "bot_assignment_parent_assignment_id_idx" ON "botsdk"."bot_assignment" ("parent_assignment_id");--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD CONSTRAINT "bot_assignment_parent_assignment_id_bot_assignment_id_fkey" FOREIGN KEY ("parent_assignment_id") REFERENCES "botsdk"."bot_assignment"("id") ON DELETE SET NULL;
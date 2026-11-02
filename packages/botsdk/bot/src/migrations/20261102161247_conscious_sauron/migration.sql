ALTER TYPE "botsdk"."bot_assignment_actor" ADD VALUE 'feature';--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "assigner_feature" text;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "assigner_job" text;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "assigner_trusted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD CONSTRAINT "bot_assignment_assigner_feature_check" CHECK (("assigner_feature" is null) = ("assigner_job" is null));--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD CONSTRAINT "bot_assignment_assigner_trusted_check" CHECK ("assigner_trusted" = ("assigner_feature" is null));
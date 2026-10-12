ALTER TYPE "chat"."message_status" ADD VALUE 'awaiting_approval';--> statement-breakpoint
ALTER TABLE "chat"."message" ADD COLUMN "run_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat"."message" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "chat"."message" ADD COLUMN "interrupted_run_id" text;
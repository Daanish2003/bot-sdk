CREATE TYPE "chat"."reasoning_effort" AS ENUM('off', 'low', 'medium', 'high');--> statement-breakpoint
ALTER TABLE "chat"."conversation" ADD COLUMN "reasoning_effort" "chat"."reasoning_effort";--> statement-breakpoint
ALTER TABLE "chat"."message" ADD COLUMN "reasoning_effort" "chat"."reasoning_effort";--> statement-breakpoint
ALTER TABLE "chat"."message" ADD COLUMN "usage" jsonb;--> statement-breakpoint
ALTER TABLE "chat"."message" ADD COLUMN "context_start_id" uuid;--> statement-breakpoint
ALTER TABLE "chat"."user_settings" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "chat"."message" ADD CONSTRAINT "message_context_start_id_message_id_fkey" FOREIGN KEY ("context_start_id") REFERENCES "chat"."message"("id") ON DELETE SET NULL;
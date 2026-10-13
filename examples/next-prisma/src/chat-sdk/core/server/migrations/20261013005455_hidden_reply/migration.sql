ALTER TABLE "chat"."message" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat"."message" ADD COLUMN "hidden_reason" text;
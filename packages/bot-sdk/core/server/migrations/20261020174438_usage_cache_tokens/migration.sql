ALTER TYPE "chat"."usage_kind" ADD VALUE 'summary';--> statement-breakpoint
ALTER TYPE "chat"."usage_kind" ADD VALUE 'warm';--> statement-breakpoint
ALTER TABLE "chat"."usage" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat"."usage" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat"."usage" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "chat"."usage" ADD COLUMN "prompt_hashes" jsonb;
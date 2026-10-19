ALTER TABLE "chat"."bot" ADD COLUMN "computer_rebuild_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat"."computer" ADD COLUMN "rebuilt_at" timestamp with time zone;
ALTER TABLE "chat"."computer" ADD COLUMN "synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "chat"."computer" ADD COLUMN "sync_fingerprint" text;--> statement-breakpoint
ALTER TABLE "chat"."computer" ADD COLUMN "synced_bytes" integer;
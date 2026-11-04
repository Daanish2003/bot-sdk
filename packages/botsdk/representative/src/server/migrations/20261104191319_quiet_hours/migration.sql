ALTER TABLE "botsdk"."representative" ADD COLUMN "quiet_start_hour" integer DEFAULT 21 NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."representative" ADD COLUMN "quiet_end_hour" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."representative" ADD COLUMN "business_time_zone" text DEFAULT 'UTC' NOT NULL;
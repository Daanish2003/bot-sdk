CREATE TYPE "chat"."message_rating" AS ENUM('up', 'down');--> statement-breakpoint
ALTER TABLE "chat"."message" ADD COLUMN "rating" "chat"."message_rating";--> statement-breakpoint
ALTER TABLE "chat"."message" ADD COLUMN "rated_at" timestamp with time zone;
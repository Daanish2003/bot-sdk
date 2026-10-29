ALTER TYPE "botsdk"."notification_route" ADD VALUE 'push';--> statement-breakpoint
CREATE TABLE "botsdk"."push_subscription" (
	"endpoint" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "push_subscription_user_id_idx" ON "botsdk"."push_subscription" ("user_id");
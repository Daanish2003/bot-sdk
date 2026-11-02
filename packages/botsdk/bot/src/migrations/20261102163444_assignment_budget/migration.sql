ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "call_limit" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "money_limit_micros" bigint DEFAULT 1000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "calls_spent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "micros_spent" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment" ADD COLUMN "over_budget_at" timestamp;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment_log" ADD COLUMN "calls" integer;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_assignment_log" ADD COLUMN "cost_micros" bigint;
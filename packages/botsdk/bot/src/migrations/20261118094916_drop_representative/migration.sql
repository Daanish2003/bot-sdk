-- The Representative feature is removed: its tables, its trigger on the Channel accounts, the accounts it held and its journal rows go, and so do the core's Pages, which only it raised. A database that never enabled it has none of the feature's.
DROP TRIGGER IF EXISTS "channel_account_one_holder" ON "botsdk"."channel_account";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_release";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_test_result";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_hand_off";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_verification";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_customer_merge";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_fact";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_fact_log";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_document";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_fact_proposal";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_gap";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_profile_value";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_profile_field";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_customer_summary";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_held_message";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_outbound_decision";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_thread_message";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_topic";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_turn";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_channel_account";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_widget_key";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_email_address";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_thread_mail";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_inbound_mail";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_call";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_customer_identity";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_thread";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative";--> statement-breakpoint
DROP TABLE IF EXISTS "botsdk"."representative_customer";--> statement-breakpoint
DROP FUNCTION IF EXISTS "botsdk"."channel_account_holder_of_account"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "botsdk"."channel_account_holder_of_link"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "botsdk"."check_channel_account_holder"(uuid);--> statement-breakpoint
DELETE FROM "botsdk"."__migrations" WHERE "feature" = 'representative';--> statement-breakpoint
DELETE FROM "botsdk"."channel_account" WHERE "bot_id" IS NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."channel_account" ALTER COLUMN "bot_id" SET NOT NULL;--> statement-breakpoint
DROP TABLE "botsdk"."page";--> statement-breakpoint
DROP TYPE "botsdk"."page_urgency";
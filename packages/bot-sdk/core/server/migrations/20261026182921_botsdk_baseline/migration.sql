CREATE TYPE "botsdk"."bot_check_in_state" AS ENUM('pending', 'fired', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_demonstration_event_kind" AS ENUM('click', 'input', 'change', 'key', 'navigation', 'pause');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_demonstration_state" AS ENUM('recording', 'paused', 'drafting', 'saved', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_helper_status" AS ENUM('running', 'waiting', 'complete', 'error', 'stopped');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_helper_type" AS ENUM('general', 'computer_use');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_review_state" AS ENUM('waiting', 'allowed', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_review_verdict" AS ENUM('pass', 'block');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_summary_kind" AS ENUM('away', 'mid_turn');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_routine_state" AS ENUM('pending', 'active', 'paused');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_trigger_channel" AS ENUM('web', 'schedule', 'webhook', 'helper', 'email');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_trigger_source" AS ENUM('user', 'routine', 'check_in', 'helper');--> statement-breakpoint
CREATE TYPE "botsdk"."bot_turn_status" AS ENUM('running', 'complete', 'error', 'stopped');--> statement-breakpoint
CREATE TYPE "botsdk"."computer_state" AS ENUM('asleep', 'awake');--> statement-breakpoint
CREATE TYPE "botsdk"."usage_kind" AS ENUM('run', 'title', 'web_search', 'transcription', 'image', 'embedding', 'memory', 'turn', 'helper', 'summary', 'warm', 'review', 'skill_draft');--> statement-breakpoint
CREATE TYPE "botsdk"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "botsdk"."message_error_reason" AS ENUM('invalid_key', 'rate_limited', 'provider_error');--> statement-breakpoint
CREATE TYPE "botsdk"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "botsdk"."message_status" AS ENUM('streaming', 'complete', 'stopped', 'error', 'awaiting_approval');--> statement-breakpoint
CREATE TABLE "botsdk"."conversation" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"active_leaf_id" uuid,
	"last_message_at" timestamp DEFAULT now() NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."message" (
	"id" uuid PRIMARY KEY,
	"conversation_id" uuid NOT NULL,
	"parent_id" uuid,
	"role" "botsdk"."message_role" NOT NULL,
	"parts" jsonb NOT NULL,
	"status" "botsdk"."message_status" NOT NULL,
	"error" text,
	"error_reason" "botsdk"."message_error_reason",
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL UNIQUE,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"computer_rebuild_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_check_in" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"at" timestamp NOT NULL,
	"note" text NOT NULL,
	"state" "botsdk"."bot_check_in_state" NOT NULL,
	"created_by_turn_id" uuid NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_demonstration" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"inputs" text[] NOT NULL,
	"state" "botsdk"."bot_demonstration_state" NOT NULL,
	"screen" integer NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"skill_name" text
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_demonstration_event" (
	"id" uuid PRIMARY KEY,
	"demonstration_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"offset_ms" integer NOT NULL,
	"kind" "botsdk"."bot_demonstration_event_kind" NOT NULL,
	"url" text,
	"label" text,
	"selector" text,
	"value" text,
	"screenshot_key" text
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_helper" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"type" "botsdk"."bot_helper_type" NOT NULL,
	"task" text NOT NULL,
	"status" "botsdk"."bot_helper_status" NOT NULL,
	"report" text,
	"started_by_turn_id" uuid NOT NULL,
	"job_id" uuid,
	"transcript" jsonb,
	"usage" jsonb,
	"screen" integer,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_helper_message" (
	"id" uuid PRIMARY KEY,
	"helper_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"delivered_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_helper_screenshot" (
	"id" uuid PRIMARY KEY,
	"helper_id" uuid NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_prompt_start" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"built_at" timestamp NOT NULL,
	"summary_id" uuid,
	"tools" jsonb NOT NULL,
	"sections" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_review" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"turn_id" uuid,
	"helper_id" uuid,
	"tool_call_id" text NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"summary" text NOT NULL,
	"verdict" "botsdk"."bot_review_verdict" NOT NULL,
	"reason" text NOT NULL,
	"state" "botsdk"."bot_review_state",
	"deadline" timestamp,
	"decided_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."secret" (
	"user_id" text,
	"name" text,
	"encrypted" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "secret_pkey" PRIMARY KEY("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_summary" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"text" text NOT NULL,
	"covers_until" timestamp NOT NULL,
	"kind" "botsdk"."bot_summary_kind" NOT NULL,
	"turn_id" uuid,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_routine" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule" jsonb,
	"webhook_token_hash" text,
	"time_zone" text NOT NULL,
	"state" "botsdk"."bot_routine_state" NOT NULL,
	"created_by_turn_id" uuid NOT NULL,
	"approved_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_trigger" (
	"id" text PRIMARY KEY,
	"conversation_id" uuid NOT NULL,
	"source" "botsdk"."bot_trigger_source" NOT NULL,
	"channel" "botsdk"."bot_trigger_channel" NOT NULL,
	"message_id" uuid,
	"text" text,
	"turn_id" uuid,
	"received_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_turn" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"status" "botsdk"."bot_turn_status" NOT NULL,
	"error" text,
	"usage" jsonb,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"job_id" uuid,
	"input" jsonb,
	"prompt_start_id" uuid,
	"transcript" jsonb,
	"memory_changes" jsonb,
	"skill_changes" jsonb,
	"knowledge_changes" jsonb
);
--> statement-breakpoint
CREATE TABLE "botsdk"."bot_upload" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."channel_email_address" (
	"bot_id" uuid PRIMARY KEY,
	"address" text NOT NULL UNIQUE,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."computer" (
	"user_id" text PRIMARY KEY,
	"sandbox_id" text,
	"template" text,
	"state" "botsdk"."computer_state" NOT NULL,
	"last_active_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"synced_at" timestamp,
	"sync_fingerprint" text,
	"synced_bytes" integer,
	"rebuilt_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "botsdk"."user_credentials" (
	"user_id" text,
	"service" text,
	"encrypted" text NOT NULL,
	"hint" text NOT NULL,
	"verified" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_credentials_pkey" PRIMARY KEY("user_id","service")
);
--> statement-breakpoint
CREATE TABLE "botsdk"."model_settings" (
	"user_id" text PRIMARY KEY,
	"image_model" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."usage" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" "botsdk"."usage_kind" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"source_id" text,
	"prompt_hashes" jsonb,
	"cost_micros" bigint NOT NULL,
	"estimated" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."job" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "botsdk"."job_status" DEFAULT 'queued'::"botsdk"."job_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"last_error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."job_event" (
	"job_id" uuid,
	"seq" integer,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_event_pkey" PRIMARY KEY("job_id","seq")
);
--> statement-breakpoint
CREATE TABLE "botsdk"."blob" (
	"key" text PRIMARY KEY,
	"bytes" bytea NOT NULL
);
--> statement-breakpoint
-- Images and PDFs are already compressed: keep the bytes out of line without compressing them again.
ALTER TABLE "botsdk"."blob" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;--> statement-breakpoint
CREATE TABLE "botsdk"."conversation_change" (
	"conversation_id" uuid,
	"seq" integer,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"at" timestamp NOT NULL,
	CONSTRAINT "conversation_change_pkey" PRIMARY KEY("conversation_id","seq")
);
--> statement-breakpoint
CREATE INDEX "conversation_user_id_last_message_at_idx" ON "botsdk"."conversation" ("user_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "message_conversation_id_parent_id_idx" ON "botsdk"."message" ("conversation_id","parent_id");--> statement-breakpoint
CREATE INDEX "bot_check_in_bot_id_idx" ON "botsdk"."bot_check_in" ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_demonstration_bot_id_state_idx" ON "botsdk"."bot_demonstration" ("bot_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_demonstration_event_demonstration_id_sequence_idx" ON "botsdk"."bot_demonstration_event" ("demonstration_id","sequence");--> statement-breakpoint
CREATE INDEX "bot_helper_bot_id_status_idx" ON "botsdk"."bot_helper" ("bot_id","status");--> statement-breakpoint
CREATE INDEX "bot_helper_message_helper_id_idx" ON "botsdk"."bot_helper_message" ("helper_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_helper_screenshot_helper_id_idx" ON "botsdk"."bot_helper_screenshot" ("helper_id");--> statement-breakpoint
CREATE INDEX "bot_prompt_start_bot_id_built_at_idx" ON "botsdk"."bot_prompt_start" ("bot_id","built_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bot_review_bot_id_created_at_idx" ON "botsdk"."bot_review" ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_review_turn_id_idx" ON "botsdk"."bot_review" ("turn_id");--> statement-breakpoint
CREATE INDEX "bot_review_helper_id_idx" ON "botsdk"."bot_review" ("helper_id");--> statement-breakpoint
CREATE INDEX "bot_summary_bot_id_created_at_idx" ON "botsdk"."bot_summary" ("bot_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "bot_routine_bot_id_name_idx" ON "botsdk"."bot_routine" ("bot_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_routine_webhook_token_hash_idx" ON "botsdk"."bot_routine" ("webhook_token_hash");--> statement-breakpoint
CREATE INDEX "bot_trigger_waiting_idx" ON "botsdk"."bot_trigger" ("conversation_id","received_at") WHERE ("turn_id" is null);--> statement-breakpoint
CREATE INDEX "bot_trigger_turn_id_idx" ON "botsdk"."bot_trigger" ("turn_id");--> statement-breakpoint
CREATE INDEX "bot_turn_bot_id_started_at_idx" ON "botsdk"."bot_turn" ("bot_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "bot_turn_running_bot_id_idx" ON "botsdk"."bot_turn" ("bot_id") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX "bot_upload_created_at_idx" ON "botsdk"."bot_upload" ("created_at");--> statement-breakpoint
CREATE INDEX "bot_upload_user_id_idx" ON "botsdk"."bot_upload" ("user_id");--> statement-breakpoint
CREATE INDEX "usage_user_id_created_at_idx" ON "botsdk"."usage" ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_idempotency_key_active_idx" ON "botsdk"."job" ("idempotency_key") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "job_idempotency_key_prefix_idx" ON "botsdk"."job" ("idempotency_key" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "botsdk"."job" ("status","run_after");--> statement-breakpoint
ALTER TABLE "botsdk"."conversation" ADD CONSTRAINT "conversation_active_leaf_id_message_id_fkey" FOREIGN KEY ("active_leaf_id") REFERENCES "botsdk"."message"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."message" ADD CONSTRAINT "message_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "botsdk"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."message" ADD CONSTRAINT "message_parent_id_message_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "botsdk"."message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot" ADD CONSTRAINT "bot_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "botsdk"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_check_in" ADD CONSTRAINT "bot_check_in_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_check_in" ADD CONSTRAINT "bot_check_in_created_by_turn_id_bot_turn_id_fkey" FOREIGN KEY ("created_by_turn_id") REFERENCES "botsdk"."bot_turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_demonstration" ADD CONSTRAINT "bot_demonstration_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_demonstration" ADD CONSTRAINT "bot_demonstration_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "botsdk"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_demonstration_event" ADD CONSTRAINT "bot_demonstration_event_td6uldhf24W6_fkey" FOREIGN KEY ("demonstration_id") REFERENCES "botsdk"."bot_demonstration"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_helper" ADD CONSTRAINT "bot_helper_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_helper" ADD CONSTRAINT "bot_helper_started_by_turn_id_bot_turn_id_fkey" FOREIGN KEY ("started_by_turn_id") REFERENCES "botsdk"."bot_turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_helper" ADD CONSTRAINT "bot_helper_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "botsdk"."job"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_helper_message" ADD CONSTRAINT "bot_helper_message_helper_id_bot_helper_id_fkey" FOREIGN KEY ("helper_id") REFERENCES "botsdk"."bot_helper"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_helper_screenshot" ADD CONSTRAINT "bot_helper_screenshot_helper_id_bot_helper_id_fkey" FOREIGN KEY ("helper_id") REFERENCES "botsdk"."bot_helper"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_prompt_start" ADD CONSTRAINT "bot_prompt_start_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_prompt_start" ADD CONSTRAINT "bot_prompt_start_summary_id_bot_summary_id_fkey" FOREIGN KEY ("summary_id") REFERENCES "botsdk"."bot_summary"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_review" ADD CONSTRAINT "bot_review_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_review" ADD CONSTRAINT "bot_review_turn_id_bot_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "botsdk"."bot_turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_review" ADD CONSTRAINT "bot_review_helper_id_bot_helper_id_fkey" FOREIGN KEY ("helper_id") REFERENCES "botsdk"."bot_helper"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_summary" ADD CONSTRAINT "bot_summary_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_summary" ADD CONSTRAINT "bot_summary_turn_id_bot_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "botsdk"."bot_turn"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_routine" ADD CONSTRAINT "bot_routine_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_routine" ADD CONSTRAINT "bot_routine_created_by_turn_id_bot_turn_id_fkey" FOREIGN KEY ("created_by_turn_id") REFERENCES "botsdk"."bot_turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD CONSTRAINT "bot_trigger_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "botsdk"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD CONSTRAINT "bot_trigger_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "botsdk"."message"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_trigger" ADD CONSTRAINT "bot_trigger_turn_id_bot_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "botsdk"."bot_turn"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_turn" ADD CONSTRAINT "bot_turn_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_turn" ADD CONSTRAINT "bot_turn_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "botsdk"."job"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_turn" ADD CONSTRAINT "bot_turn_prompt_start_id_bot_prompt_start_id_fkey" FOREIGN KEY ("prompt_start_id") REFERENCES "botsdk"."bot_prompt_start"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."channel_email_address" ADD CONSTRAINT "channel_email_address_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."job_event" ADD CONSTRAINT "job_event_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "botsdk"."job"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."conversation_change" ADD CONSTRAINT "conversation_change_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "botsdk"."conversation"("id") ON DELETE CASCADE;
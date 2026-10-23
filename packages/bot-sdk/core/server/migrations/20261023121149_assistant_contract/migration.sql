-- The assistant's Conversations go first; their Messages and links cascade (#819).
DELETE FROM "chat"."conversation" WHERE "kind" = 'assistant';--> statement-breakpoint
ALTER TABLE "chat"."conversation" DROP CONSTRAINT "conversation_project_id_project_id_fkey";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP CONSTRAINT "message_context_start_id_message_id_fkey";--> statement-breakpoint
ALTER TABLE "chat"."artifact_version" DROP CONSTRAINT "artifact_version_artifact_id_artifact_id_fkey";--> statement-breakpoint
ALTER TABLE "chat"."message_attachment" DROP CONSTRAINT "message_attachment_attachment_id_attachment_id_fkey";--> statement-breakpoint
DROP TABLE "chat"."artifact";--> statement-breakpoint
DROP TABLE "chat"."artifact_version";--> statement-breakpoint
DROP TABLE "chat"."generated_image";--> statement-breakpoint
DROP TABLE "chat"."project";--> statement-breakpoint
DROP TABLE "chat"."saved_prompt";--> statement-breakpoint
DROP TABLE "chat"."user_settings";--> statement-breakpoint
DROP TABLE "chat"."shared_link";--> statement-breakpoint
DROP TABLE "chat"."attachment";--> statement-breakpoint
DROP TABLE "chat"."message_attachment";--> statement-breakpoint
ALTER TABLE "chat"."conversation" DROP CONSTRAINT "conversation_assistant_model_check";--> statement-breakpoint
DROP INDEX "chat"."conversation_pinned_user_id_pinned_at_idx";--> statement-breakpoint
DROP INDEX "chat"."conversation_archived_user_id_last_message_at_idx";--> statement-breakpoint
DROP INDEX "chat"."conversation_title_trgm_idx";--> statement-breakpoint
DROP INDEX "chat"."conversation_unprojected_user_id_last_message_at_idx";--> statement-breakpoint
DROP INDEX "chat"."conversation_project_id_last_message_at_idx";--> statement-breakpoint
DROP INDEX "chat"."message_search_text_trgm_idx";--> statement-breakpoint
DROP INDEX "chat"."message_search_text_fts_idx";--> statement-breakpoint
ALTER TABLE "chat"."conversation" DROP COLUMN "pinned_at";--> statement-breakpoint
ALTER TABLE "chat"."conversation" DROP COLUMN "archived_at";--> statement-breakpoint
ALTER TABLE "chat"."conversation" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "chat"."conversation" DROP COLUMN "reasoning_effort";--> statement-breakpoint
ALTER TABLE "chat"."conversation" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "chat"."conversation" DROP COLUMN "tool_settings";--> statement-breakpoint
ALTER TABLE "chat"."conversation" DROP COLUMN "temporary";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "search_text";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "rating";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "rated_at";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "reasoning_effort";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "usage";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "context_start_id";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "cancel_requested_at";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "heartbeat_at";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "run_number";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "thread_id";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "interrupted_run_id";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "hidden_at";--> statement-breakpoint
ALTER TABLE "chat"."message" DROP COLUMN "hidden_reason";--> statement-breakpoint
DROP TYPE "chat"."reasoning_effort";--> statement-breakpoint
DROP TYPE "chat"."artifact_kind";--> statement-breakpoint
DROP TYPE "chat"."message_rating";
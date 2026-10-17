ALTER TABLE "chat"."conversation" ADD COLUMN "kind" text NOT NULL DEFAULT 'assistant';--> statement-breakpoint
ALTER TABLE "chat"."conversation" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chat"."conversation" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat"."conversation" ADD CONSTRAINT "conversation_assistant_model_check" CHECK ("kind" <> 'assistant' OR "model" IS NOT NULL);
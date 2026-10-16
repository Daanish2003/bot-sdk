CREATE TYPE "chat"."message_error_reason" AS ENUM('invalid_key', 'rate_limited', 'provider_error');--> statement-breakpoint
CREATE TYPE "chat"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "chat"."message_status" AS ENUM('streaming', 'complete', 'stopped', 'error');--> statement-breakpoint
CREATE TABLE "chat"."attachment" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat"."attachment_blob" (
	"attachment_id" uuid PRIMARY KEY,
	"bytes" bytea NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat"."message_attachment" (
	"message_id" uuid,
	"attachment_id" uuid,
	"position" integer NOT NULL,
	CONSTRAINT "message_attachment_pkey" PRIMARY KEY("message_id","attachment_id")
);
--> statement-breakpoint
CREATE TABLE "chat"."conversation" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"title" text,
	"model" text NOT NULL,
	"active_leaf_id" uuid,
	"last_message_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat"."message" (
	"id" uuid PRIMARY KEY,
	"conversation_id" uuid NOT NULL,
	"parent_id" uuid,
	"role" "chat"."message_role" NOT NULL,
	"parts" jsonb NOT NULL,
	"model" text,
	"status" "chat"."message_status" NOT NULL,
	"error" text,
	"error_reason" "chat"."message_error_reason",
	"search_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat"."user_credentials" (
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
CREATE TABLE "chat"."user_settings" (
	"user_id" text PRIMARY KEY,
	"title_model" text
);
--> statement-breakpoint
CREATE TABLE "chat"."shared_link" (
	"token" text PRIMARY KEY,
	"conversation_id" uuid NOT NULL UNIQUE,
	"leaf_message_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "attachment_user_id_created_at_idx" ON "chat"."attachment" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "message_attachment_attachment_id_idx" ON "chat"."message_attachment" ("attachment_id");--> statement-breakpoint
CREATE INDEX "conversation_user_id_last_message_at_idx" ON "chat"."conversation" ("user_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_title_trgm_idx" ON "chat"."conversation" USING gin ("title" public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "message_conversation_id_parent_id_idx" ON "chat"."message" ("conversation_id","parent_id");--> statement-breakpoint
CREATE INDEX "message_search_text_trgm_idx" ON "chat"."message" USING gin ("search_text" public.gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "chat"."attachment_blob" ADD CONSTRAINT "attachment_blob_attachment_id_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "chat"."attachment"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."message_attachment" ADD CONSTRAINT "message_attachment_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."message_attachment" ADD CONSTRAINT "message_attachment_attachment_id_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "chat"."attachment"("id");--> statement-breakpoint
ALTER TABLE "chat"."conversation" ADD CONSTRAINT "conversation_active_leaf_id_message_id_fkey" FOREIGN KEY ("active_leaf_id") REFERENCES "chat"."message"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chat"."message" ADD CONSTRAINT "message_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."message" ADD CONSTRAINT "message_parent_id_message_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "chat"."message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."shared_link" ADD CONSTRAINT "shared_link_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."shared_link" ADD CONSTRAINT "shared_link_leaf_message_id_message_id_fkey" FOREIGN KEY ("leaf_message_id") REFERENCES "chat"."message"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Images and PDFs are already compressed: keep the bytes out of line without compressing them again.
ALTER TABLE "chat"."attachment_blob" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;
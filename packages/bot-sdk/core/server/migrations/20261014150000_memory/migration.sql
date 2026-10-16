CREATE TYPE "chat"."memory_origin" AS ENUM('extracted', 'said');--> statement-breakpoint
ALTER TYPE "chat"."usage_kind" ADD VALUE 'memory';--> statement-breakpoint
CREATE TABLE "chat"."memory" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"origin" "chat"."memory_origin" NOT NULL,
	"invalid_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat"."user_settings" ADD COLUMN "memory_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_embedding_hnsw_idx" ON "chat"."memory" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_conversation_id_idx" ON "chat"."memory" ("conversation_id");--> statement-breakpoint
ALTER TABLE "chat"."memory" ADD CONSTRAINT "memory_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."memory" ADD CONSTRAINT "memory_replaced_by_id_memory_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "chat"."memory"("id") ON DELETE SET NULL;
CREATE TYPE "chat"."knowledge_file_status" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "chat"."knowledge_chunk" (
	"file_id" uuid,
	"position" integer,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED NOT NULL,
	CONSTRAINT "knowledge_chunk_pkey" PRIMARY KEY("file_id","position")
);
--> statement-breakpoint
CREATE TABLE "chat"."knowledge_file" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"status" "chat"."knowledge_file_status" DEFAULT 'processing'::"chat"."knowledge_file_status" NOT NULL,
	"failure_code" text,
	"chunk_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat"."project" ADD COLUMN "embedding_model" text;--> statement-breakpoint
CREATE INDEX "knowledge_chunk_embedding_idx" ON "chat"."knowledge_chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunk_tsv_idx" ON "chat"."knowledge_chunk" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "knowledge_file_project_id_idx" ON "chat"."knowledge_file" ("project_id");--> statement-breakpoint
ALTER TABLE "chat"."knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_file_id_knowledge_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "chat"."knowledge_file"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."knowledge_file" ADD CONSTRAINT "knowledge_file_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "chat"."project"("id") ON DELETE CASCADE;
CREATE TYPE "chat"."artifact_kind" AS ENUM('code', 'markdown', 'html', 'svg', 'mermaid');--> statement-breakpoint
CREATE TABLE "chat"."artifact" (
	"id" text PRIMARY KEY,
	"conversation_id" uuid NOT NULL,
	"kind" "chat"."artifact_kind" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat"."artifact_version" (
	"artifact_id" text,
	"message_id" uuid NOT NULL,
	"number" integer,
	"title" text NOT NULL,
	"language" text,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_version_pkey" PRIMARY KEY("artifact_id","number")
);
--> statement-breakpoint
CREATE INDEX "artifact_conversation_id_idx" ON "chat"."artifact" ("conversation_id");--> statement-breakpoint
CREATE INDEX "artifact_version_message_id_idx" ON "chat"."artifact_version" ("message_id");--> statement-breakpoint
ALTER TABLE "chat"."artifact" ADD CONSTRAINT "artifact_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."artifact_version" ADD CONSTRAINT "artifact_version_artifact_id_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "chat"."artifact"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."artifact_version" ADD CONSTRAINT "artifact_version_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."message"("id") ON DELETE CASCADE;
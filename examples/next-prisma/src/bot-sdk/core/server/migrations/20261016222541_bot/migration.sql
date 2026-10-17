CREATE TABLE "chat"."bot" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL UNIQUE,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat"."bot" ADD CONSTRAINT "bot_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversation"("id") ON DELETE CASCADE;
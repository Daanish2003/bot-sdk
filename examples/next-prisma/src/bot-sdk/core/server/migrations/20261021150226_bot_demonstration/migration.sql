CREATE TYPE "chat"."bot_demonstration_state" AS ENUM('recording', 'paused', 'drafting', 'saved', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "chat"."bot_demonstration" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"inputs" text[] NOT NULL,
	"state" "chat"."bot_demonstration_state" NOT NULL,
	"screen" integer NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"skill_name" text
);
--> statement-breakpoint
CREATE INDEX "bot_demonstration_bot_id_state_idx" ON "chat"."bot_demonstration" ("bot_id","state");--> statement-breakpoint
ALTER TABLE "chat"."bot_demonstration" ADD CONSTRAINT "bot_demonstration_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "chat"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_demonstration" ADD CONSTRAINT "bot_demonstration_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversation"("id") ON DELETE CASCADE;
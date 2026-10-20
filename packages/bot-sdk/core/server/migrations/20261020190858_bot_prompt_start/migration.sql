CREATE TABLE "chat"."bot_prompt_start" (
	"id" uuid PRIMARY KEY,
	"bot_id" uuid NOT NULL,
	"built_at" timestamp NOT NULL,
	"summary_id" uuid,
	"tools" jsonb NOT NULL,
	"sections" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat"."bot_turn" ADD COLUMN "prompt_start_id" uuid;--> statement-breakpoint
CREATE INDEX "bot_prompt_start_bot_id_built_at_idx" ON "chat"."bot_prompt_start" ("bot_id","built_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "chat"."bot_prompt_start" ADD CONSTRAINT "bot_prompt_start_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "chat"."bot"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."bot_turn" ADD CONSTRAINT "bot_turn_prompt_start_id_bot_prompt_start_id_fkey" FOREIGN KEY ("prompt_start_id") REFERENCES "chat"."bot_prompt_start"("id") ON DELETE SET NULL;
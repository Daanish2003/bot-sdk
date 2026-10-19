ALTER TABLE "chat"."bot_routine" ADD COLUMN "webhook_token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_routine_webhook_token_hash_idx" ON "chat"."bot_routine" ("webhook_token_hash");
-- The assistant's Memories go (#650, ADR 0013 superseded): their rows, embeddings and indexes are dropped. Only Bots remember, through their files (ADR 0022). The Memory switch, chat.memory_settings, stays.
DROP TABLE "chat"."memory";--> statement-breakpoint
DROP TYPE "chat"."memory_origin";--> statement-breakpoint
-- Their jobs are no longer defined, so the ones still queued or kept would only fail as unknown.
DELETE FROM "chat"."job" WHERE "name" IN ('memory.make', 'memory.reembed');

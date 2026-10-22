-- The assistant's Project Knowledge goes (spec #737, ADR 0025): Knowledge is now plain files on the user's Computer. Nothing is exported. Its bytes in the default Postgres blob store go first, while the file ids can still be read; a Host on another blob store keeps them as strays (ADR 0015).
DELETE FROM "chat"."blob" WHERE "key" IN (SELECT 'knowledge/' || "id" FROM "chat"."knowledge_file");--> statement-breakpoint
-- Its job is no longer defined, so the ones still queued or kept would only fail as unknown.
DELETE FROM "chat"."job" WHERE "name" = 'knowledge.process';--> statement-breakpoint
-- The knowledge_search part is no longer a stored part, so the replies that searched lose it and keep their text.
UPDATE "chat"."message" SET "parts" = jsonb_set("parts", '{parts}', (SELECT coalesce(jsonb_agg("part" ORDER BY "position"), '[]'::jsonb) FROM jsonb_array_elements("parts"->'parts') WITH ORDINALITY AS "found"("part", "position") WHERE "part"->>'type' <> 'knowledge_search')) WHERE "parts"->'parts' @> '[{"type": "knowledge_search"}]';--> statement-breakpoint
ALTER TABLE "chat"."knowledge_chunk" DROP CONSTRAINT "knowledge_chunk_file_id_knowledge_file_id_fkey";--> statement-breakpoint
DROP TABLE "chat"."knowledge_chunk";--> statement-breakpoint
DROP TABLE "chat"."knowledge_file";--> statement-breakpoint
ALTER TABLE "chat"."project" DROP COLUMN "embedding_model";--> statement-breakpoint
DROP TYPE "chat"."knowledge_file_status";--> statement-breakpoint
-- Nothing of the SDK's uses pgvector any more. A Host whose own tables still use it keeps it.
DO $$ BEGIN
	DROP EXTENSION IF EXISTS "vector";
EXCEPTION WHEN dependent_objects_still_exist THEN
	RAISE NOTICE 'The vector extension is still used outside the SDK, so it stays';
END $$;

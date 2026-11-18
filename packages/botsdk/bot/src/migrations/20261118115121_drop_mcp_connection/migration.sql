-- The mcp feature's Connections come from the Host's connection hook now (ADR 0037): its own token table and its journal rows go. A database that never enabled it has neither. Existing Connections must be connected again through the Host.
DROP TABLE IF EXISTS "botsdk"."mcp_connection";--> statement-breakpoint
DELETE FROM "botsdk"."__migrations" WHERE "feature" = 'mcp';

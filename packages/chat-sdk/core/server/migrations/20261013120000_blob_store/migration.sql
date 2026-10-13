CREATE TABLE "chat"."blob" (
	"key" text PRIMARY KEY,
	"bytes" bytea NOT NULL
);
--> statement-breakpoint
-- Images and PDFs are already compressed: keep the bytes out of line without compressing them again.
ALTER TABLE "chat"."blob" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;--> statement-breakpoint
-- Every existing Attachment's bytes move under its blob-store key (ADR 0015).
INSERT INTO "chat"."blob" ("key", "bytes") SELECT 'attachment/' || "attachment_id", "bytes" FROM "chat"."attachment_blob";--> statement-breakpoint
DROP TABLE "chat"."attachment_blob";
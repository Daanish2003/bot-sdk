CREATE TABLE "botsdk"."representative_document" (
	"id" uuid PRIMARY KEY,
	"representative_id" uuid NOT NULL,
	"name" text NOT NULL,
	"text" text NOT NULL,
	"hash" text NOT NULL,
	"chars" integer NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "representative_document_representative_idx" ON "botsdk"."representative_document" ("representative_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_document" ADD CONSTRAINT "representative_document_yOfvktNhvbC5_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;
CREATE TABLE "botsdk"."representative_widget_key" (
	"representative_id" uuid PRIMARY KEY,
	"key" text NOT NULL CONSTRAINT "representative_widget_key_key" UNIQUE,
	"allowed_origins" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "representative_widget_key_status" CHECK ("status" in ('live', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative_widget_key" ADD CONSTRAINT "representative_widget_key_6YFlOIXhvyOK_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;
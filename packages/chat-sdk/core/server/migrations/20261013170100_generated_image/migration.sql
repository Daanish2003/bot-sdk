CREATE TABLE "chat"."generated_image" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"media_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "generated_image_message_id_idx" ON "chat"."generated_image" ("message_id");--> statement-breakpoint
ALTER TABLE "chat"."generated_image" ADD CONSTRAINT "generated_image_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."message"("id") ON DELETE CASCADE;
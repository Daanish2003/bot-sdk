CREATE TABLE "chat"."project" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text,
	"default_model" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat"."conversation" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "chat"."conversation" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
CREATE INDEX "conversation_unprojected_user_id_last_message_at_idx" ON "chat"."conversation" ("user_id","last_message_at" DESC NULLS LAST) WHERE project_id is null;--> statement-breakpoint
CREATE INDEX "conversation_project_id_last_message_at_idx" ON "chat"."conversation" ("project_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_pinned_user_id_pinned_at_idx" ON "chat"."conversation" ("user_id","pinned_at" DESC NULLS LAST) WHERE pinned_at is not null;--> statement-breakpoint
CREATE INDEX "project_user_id_idx" ON "chat"."project" ("user_id");--> statement-breakpoint
ALTER TABLE "chat"."conversation" ADD CONSTRAINT "conversation_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "chat"."project"("id") ON DELETE CASCADE;
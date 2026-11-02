CREATE TABLE "botsdk"."representative" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"bot_id" uuid,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"live_release_id" uuid,
	"draft" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."representative_release" (
	"id" uuid PRIMARY KEY,
	"representative_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"approved_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "representative_release_number" UNIQUE("representative_id","number")
);
--> statement-breakpoint
CREATE INDEX "representative_user_idx" ON "botsdk"."representative" ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "botsdk"."representative" ADD CONSTRAINT "representative_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_release" ADD CONSTRAINT "representative_release_representative_id_representative_id_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;
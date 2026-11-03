CREATE TABLE "botsdk"."representative_customer_merge" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"survivor_customer_id" uuid NOT NULL,
	"absorbed_customer_id" uuid NOT NULL,
	"how" text NOT NULL,
	"identity_ids" jsonb NOT NULL,
	"thread_ids" jsonb NOT NULL,
	"moved_holds" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	"undone_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread" ADD COLUMN "turn_from" integer;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread_message" ADD COLUMN "held_for_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "representative_customer_merge_user_idx" ON "botsdk"."representative_customer_merge" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "representative_customer_merge_survivor_idx" ON "botsdk"."representative_customer_merge" ("survivor_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "representative_customer_merge_absorbed_idx" ON "botsdk"."representative_customer_merge" ("absorbed_customer_id") WHERE "undone_at" is null;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_customer_merge" ADD CONSTRAINT "representative_customer_merge_Mn1uoORUijTG_fkey" FOREIGN KEY ("survivor_customer_id") REFERENCES "botsdk"."representative_customer"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_customer_merge" ADD CONSTRAINT "representative_customer_merge_pVbHH0Xf5Itc_fkey" FOREIGN KEY ("absorbed_customer_id") REFERENCES "botsdk"."representative_customer"("id") ON DELETE CASCADE;
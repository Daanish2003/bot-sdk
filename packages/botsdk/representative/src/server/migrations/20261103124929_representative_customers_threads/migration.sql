CREATE TABLE "botsdk"."representative_customer" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."representative_customer_identity" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "representative_customer_identity_address" UNIQUE("user_id","channel","external_id")
);
--> statement-breakpoint
CREATE TABLE "botsdk"."representative_thread" (
	"id" uuid PRIMARY KEY,
	"customer_id" uuid NOT NULL,
	"representative_id" uuid NOT NULL,
	"state" text DEFAULT 'representative' NOT NULL,
	"last_channel" text NOT NULL,
	"last_external_id" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."representative_thread_message" (
	"id" uuid PRIMARY KEY,
	"thread_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"author" text NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "representative_thread_message_position" UNIQUE("thread_id","position")
);
--> statement-breakpoint
CREATE INDEX "representative_customer_user_idx" ON "botsdk"."representative_customer" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "representative_customer_identity_customer_idx" ON "botsdk"."representative_customer_identity" ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "representative_thread_open_idx" ON "botsdk"."representative_thread" ("customer_id","representative_id") WHERE "state" <> 'closed';--> statement-breakpoint
CREATE INDEX "representative_thread_customer_idx" ON "botsdk"."representative_thread" ("customer_id");--> statement-breakpoint
CREATE INDEX "representative_thread_representative_idx" ON "botsdk"."representative_thread" ("representative_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_customer_identity" ADD CONSTRAINT "representative_customer_identity_V1wa8UJdIMn9_fkey" FOREIGN KEY ("customer_id") REFERENCES "botsdk"."representative_customer"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread" ADD CONSTRAINT "representative_thread_n6pfi9Lo8t8k_fkey" FOREIGN KEY ("customer_id") REFERENCES "botsdk"."representative_customer"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread" ADD CONSTRAINT "representative_thread_representative_id_representative_id_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_thread_message" ADD CONSTRAINT "representative_thread_message_CLJcN0LqaT8Y_fkey" FOREIGN KEY ("thread_id") REFERENCES "botsdk"."representative_thread"("id") ON DELETE CASCADE;
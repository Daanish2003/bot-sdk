CREATE TABLE "botsdk"."representative_profile_field" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."representative_profile_value" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"fixed_field" text,
	"field_id" uuid,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"recorded_at" timestamp NOT NULL,
	CONSTRAINT "representative_profile_value_fixed" UNIQUE("customer_id","fixed_field"),
	CONSTRAINT "representative_profile_value_field" UNIQUE("customer_id","field_id"),
	CONSTRAINT "representative_profile_value_one_field" CHECK (num_nonnulls("fixed_field", "field_id") = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "representative_profile_field_name" ON "botsdk"."representative_profile_field" ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "representative_profile_value_field_idx" ON "botsdk"."representative_profile_value" ("field_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_profile_value" ADD CONSTRAINT "representative_profile_value_ouIMP6uZgzKN_fkey" FOREIGN KEY ("customer_id") REFERENCES "botsdk"."representative_customer"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_profile_value" ADD CONSTRAINT "representative_profile_value_G9g7W6UndZEp_fkey" FOREIGN KEY ("field_id") REFERENCES "botsdk"."representative_profile_field"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "botsdk"."representative_profile_value" ("id", "user_id", "customer_id", "fixed_field", "value", "source", "status", "recorded_at")
SELECT gen_random_uuid(), "user_id", "id", 'name', "name", 'owner', 'confirmed', "created_at" FROM "botsdk"."representative_customer" WHERE "name" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_customer" DROP COLUMN "name";
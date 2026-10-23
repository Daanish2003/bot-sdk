CREATE TABLE "chat"."model_settings" (
	"user_id" text PRIMARY KEY,
	"image_model" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The Image Model moves to the models plugin (spec #801), so it outlives the assistant: each pick is copied. A user with no row has the Host's default, so the others need none. user_settings.image_model is left unused until the assistant goes.
INSERT INTO "chat"."model_settings" ("user_id", "image_model") SELECT "user_id", "image_model" FROM "chat"."user_settings" WHERE "image_model" IS NOT NULL;

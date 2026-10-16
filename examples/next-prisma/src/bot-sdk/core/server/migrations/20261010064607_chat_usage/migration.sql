CREATE TYPE "chat"."usage_kind" AS ENUM('run', 'title', 'web_search');--> statement-breakpoint
CREATE TABLE "chat"."usage" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" "chat"."usage_kind" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"estimated" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "usage_user_id_created_at_idx" ON "chat"."usage" ("user_id","created_at");
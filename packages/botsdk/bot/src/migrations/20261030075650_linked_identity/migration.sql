CREATE TABLE "botsdk"."link_code" (
	"user_id" text PRIMARY KEY,
	"code_hash" text NOT NULL CONSTRAINT "link_code_hash_unique" UNIQUE,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "botsdk"."linked_identity" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"platform_user_id" text NOT NULL,
	"handle" text NOT NULL,
	"workspace_id" text,
	"linked_at" timestamp NOT NULL,
	CONSTRAINT "linked_identity_user_platform_unique" UNIQUE("user_id","platform"),
	CONSTRAINT "linked_identity_platform_account_unique" UNIQUE NULLS NOT DISTINCT("platform","workspace_id","platform_user_id")
);

CREATE TABLE "chat"."secret" (
	"user_id" text,
	"name" text,
	"encrypted" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "secret_pkey" PRIMARY KEY("user_id","name")
);

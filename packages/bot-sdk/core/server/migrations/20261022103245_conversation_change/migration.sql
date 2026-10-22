CREATE TABLE "chat"."conversation_change" (
	"conversation_id" uuid,
	"seq" integer,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"at" timestamp NOT NULL,
	CONSTRAINT "conversation_change_pkey" PRIMARY KEY("conversation_id","seq")
);
--> statement-breakpoint
ALTER TABLE "chat"."conversation" ADD COLUMN "last_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat"."conversation_change" ADD CONSTRAINT "conversation_change_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversation"("id") ON DELETE CASCADE;
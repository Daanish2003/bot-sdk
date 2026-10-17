CREATE TABLE "chat"."job_event" (
	"job_id" uuid,
	"seq" integer,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_event_pkey" PRIMARY KEY("job_id","seq")
);
--> statement-breakpoint
ALTER TABLE "chat"."job_event" ADD CONSTRAINT "job_event_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "chat"."job"("id") ON DELETE CASCADE;
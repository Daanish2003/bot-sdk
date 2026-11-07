CREATE TABLE "botsdk"."representative_inbound_mail" (
	"representative_id" uuid,
	"message_hash" text,
	CONSTRAINT "representative_inbound_mail_pkey" PRIMARY KEY("representative_id","message_hash")
);
--> statement-breakpoint
ALTER TABLE "botsdk"."representative_inbound_mail" ADD CONSTRAINT "representative_inbound_mail_yedZzhrabbM3_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;
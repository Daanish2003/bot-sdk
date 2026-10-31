CREATE TABLE "botsdk"."bot_room_member" (
	"conversation_id" uuid,
	"bot_id" uuid,
	"lead" boolean DEFAULT false NOT NULL,
	"reset_at" timestamp,
	"joined_at" timestamp NOT NULL,
	CONSTRAINT "bot_room_member_pkey" PRIMARY KEY("conversation_id","bot_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bot_room_member_lead_idx" ON "botsdk"."bot_room_member" ("conversation_id") WHERE "lead";--> statement-breakpoint
CREATE INDEX "bot_room_member_bot_id_idx" ON "botsdk"."bot_room_member" ("bot_id");--> statement-breakpoint
ALTER TABLE "botsdk"."bot_room_member" ADD CONSTRAINT "bot_room_member_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "botsdk"."conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."bot_room_member" ADD CONSTRAINT "bot_room_member_bot_id_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "botsdk"."bot"("id") ON DELETE CASCADE;
CREATE TABLE "botsdk"."representative_channel_account" (
	"channel_account_id" uuid PRIMARY KEY,
	"representative_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE INDEX "representative_channel_account_representative_id_idx" ON "botsdk"."representative_channel_account" ("representative_id");--> statement-breakpoint
ALTER TABLE "botsdk"."representative_channel_account" ADD CONSTRAINT "representative_channel_account_Am1mdeaqkJvN_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "botsdk"."channel_account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "botsdk"."representative_channel_account" ADD CONSTRAINT "representative_channel_account_1QtmM4GPPidh_fkey" FOREIGN KEY ("representative_id") REFERENCES "botsdk"."representative"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE FUNCTION "botsdk"."check_channel_account_holder"(account uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  holder_bot uuid;
BEGIN
  SELECT bot_id INTO holder_bot FROM botsdk.channel_account WHERE id = account;
  -- A deleted account holds nothing.
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF (holder_bot IS NOT NULL) = EXISTS (
    SELECT 1 FROM botsdk.representative_channel_account WHERE channel_account_id = account
  ) THEN
    RAISE EXCEPTION 'A Channel account belongs to one Bot or one Representative'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'channel_account_one_holder';
  END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "botsdk"."channel_account_holder_of_account"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM botsdk.check_channel_account_holder(NEW.id);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "botsdk"."channel_account_holder_of_link"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM botsdk.check_channel_account_holder(OLD.channel_account_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM botsdk.check_channel_account_holder(NEW.channel_account_id);
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "channel_account_one_holder" AFTER INSERT OR UPDATE OF "bot_id" ON "botsdk"."channel_account"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "botsdk"."channel_account_holder_of_account"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "representative_channel_account_one_holder" AFTER INSERT OR UPDATE OR DELETE ON "botsdk"."representative_channel_account"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "botsdk"."channel_account_holder_of_link"();

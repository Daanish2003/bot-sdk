-- A Routine's schedule holds a list of times (#1025): each one-time schedule becomes a one-item list.
UPDATE "botsdk"."bot_routine" SET "schedule" = jsonb_build_object('days', "schedule"->'days', 'times', jsonb_build_array("schedule"->'at')) WHERE "schedule" ? 'at';

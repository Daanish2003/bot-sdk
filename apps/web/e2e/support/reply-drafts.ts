import { randomUUID } from "node:crypto";

import { createDb } from "@ai-chat/db";

import { e2eDatabaseUrl } from "../database";

/** Switches the Representative on and gives it a thread with a Reply draft, as the gate holds one. */
export async function seedDraft(
  userId: string,
  representativeId: string,
  { name, text }: { name: string; text: string },
) {
  const customerId = randomUUID();
  const threadId = randomUUID();
  const decisionId = randomUUID();
  const externalId = `+1555${customerId.slice(0, 8)}`;
  const now = new Date();
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    const run = (query: string, values: unknown[]) => db.$client.query(query, values);
    await run("update botsdk.representative set enabled = true where id = $1", [representativeId]);
    await run("insert into botsdk.representative_customer (id, user_id) values ($1, $2)", [
      customerId,
      userId,
    ]);
    await run(
      "insert into botsdk.representative_profile_value (id, user_id, customer_id, fixed_field, value, source, status, recorded_at) values ($1, $2, $3, 'name', $4, 'owner', 'confirmed', $5)",
      [randomUUID(), userId, customerId, name, now],
    );
    await run(
      "insert into botsdk.representative_customer_identity (id, user_id, customer_id, channel, external_id) values ($1, $2, $3, 'sms', $4)",
      [randomUUID(), userId, customerId, externalId],
    );
    await run(
      "insert into botsdk.representative_thread (id, customer_id, representative_id, last_channel, last_external_id, message_count) values ($1, $2, $3, 'sms', $4, 1)",
      [threadId, customerId, representativeId, externalId],
    );
    await run(
      "insert into botsdk.representative_thread_message (id, thread_id, position, author, channel, external_id, text) values ($1, $2, 1, 'customer', 'sms', $3, 'What do I owe?')",
      [randomUUID(), threadId, externalId],
    );
    await run(
      "insert into botsdk.representative_outbound_decision (id, thread_id, kind, outcome, rule, channel, external_id, created_at) values ($1, $2, 'reply', 'hold', 'topic', 'sms', $3, $4)",
      [decisionId, threadId, externalId, now],
    );
    await run(
      "insert into botsdk.representative_held_message (id, decision_id, thread_id, text, verified, reply_kind, sources, topic, created_at) values ($1, $2, $3, $4, false, 'small_talk', '[]', 'billing', $5)",
      [randomUUID(), decisionId, threadId, text, now],
    );
  } finally {
    await db.$client.end();
  }
}

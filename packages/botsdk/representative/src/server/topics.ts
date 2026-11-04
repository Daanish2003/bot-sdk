import { and, asc, eq, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { isUniqueViolation } from "@botsdk/bot/lib/unique-violation";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import type { TopicView } from "../shared/contract";
import { representativeTopic, type TopicMode } from "./db/schema";

/*
 * The owner's topics (ticket #1306). A Representative labels each reply with one, and the Outbound
 * gate lets a reply go by itself only on a topic the owner has promoted, so a name they don't have
 * waits for them like any new topic. Every read and write starts from the owner's id, and someone
 * else's topic is "not found".
 */

type Context = Pick<FeatureContext, "db" | "clock">;

const topic = representativeTopic;

const topicNameIndex = "representative_topic_name";

/** The most topic names a Turn's prompt lists, so an owner's many topics can't fail every Turn. */
const topicsPromptLimit = 200;

const view = ({ id, name, mode, createdAt }: typeof topic.$inferSelect): TopicView => ({
  id,
  name,
  mode,
  createdAt,
});

/** The owner's topics, oldest first. */
export async function listTopics({ db }: Pick<Context, "db">, userId: string) {
  const rows = await db
    .select()
    .from(topic)
    .where(eq(topic.userId, userId))
    .orderBy(asc(topic.createdAt), asc(topic.id));
  return rows.map(view);
}

/** Adds a topic, at `draft`. Refused when the owner has that name already, ignoring case. */
export async function addTopic({ db, clock }: Context, userId: string, name: string) {
  try {
    const [row] = await db
      .insert(topic)
      .values({ id: uuidv7(), userId, name, createdAt: clock() })
      .returning();
    return view(row!);
  } catch (error) {
    if (isUniqueViolation(error, topicNameIndex)) {
      throw rpcError("CONFLICT", "error.topicExists", "You already have this topic");
    }
    throw error;
  }
}

export async function removeTopic({ db }: Pick<Context, "db">, userId: string, id: string) {
  const [row] = await db
    .delete(topic)
    .where(and(eq(topic.id, id), eq(topic.userId, userId)))
    .returning({ id: topic.id });
  if (!row) throw rpcError("NOT_FOUND", "error.topicNotFound", "Topic not found");
}

/** The mode of the owner's topic a reply was labelled with, ignoring case; null when they have none. */
export async function modeOfLabel(
  tx: Transaction,
  userId: string,
  label: string | undefined,
): Promise<TopicMode | null> {
  if (label === undefined) return null;
  const [row] = await tx
    .select({ mode: topic.mode })
    .from(topic)
    .where(and(eq(topic.userId, userId), sql`lower(${topic.name}) = lower(${label})`));
  return row?.mode ?? null;
}

/** The names a Turn may label a reply with. Never each one's mode: it isn't the Model's to aim for. */
export async function topicNames(db: FeatureContext["db"], userId: string) {
  const rows = await db
    .select({ name: topic.name })
    .from(topic)
    .where(eq(topic.userId, userId))
    .orderBy(asc(topic.createdAt), asc(topic.id))
    .limit(topicsPromptLimit);
  return rows.map(({ name }) => name);
}

export async function exportTopics(tx: Transaction, userId: string) {
  return tx
    .select({ name: topic.name, mode: topic.mode, createdAt: topic.createdAt })
    .from(topic)
    .where(eq(topic.userId, userId))
    .orderBy(asc(topic.createdAt), asc(topic.id));
}

export async function deleteTopics(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(topic).where(eq(topic.userId, userId));
}

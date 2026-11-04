import { and, asc, count, eq, inArray, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { isUniqueViolation } from "@botsdk/bot/lib/unique-violation";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import { promotionSuggestedAt, type TopicView } from "../shared/contract";
import type { ReplySource } from "../shared/replies";
import {
  draftRule,
  representative,
  representativeFact,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
  representativeTopic,
  type TopicMode,
} from "./db/schema";

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

const view = (
  { id, name, mode, createdAt }: typeof topic.$inferSelect,
  approvedUnedited = 0,
): TopicView => ({
  id,
  name,
  mode,
  approvedUnedited,
  promotionSuggested: mode === "draft" && approvedUnedited >= promotionSuggestedAt,
  createdAt,
});

/**
 * How many Reply drafts of the owner's the owner approved without editing, by lower-cased topic
 * label. An edited approval has its own resolution, so it isn't counted.
 */
async function approvedUnedited(db: Context["db"], userId: string) {
  const held = representativeHeldMessage;
  const rows = await db
    .select({ label: sql<string>`lower(${held.topic})`, count: count() })
    .from(held)
    .innerJoin(
      representativeOutboundDecision,
      eq(representativeOutboundDecision.id, held.decisionId),
    )
    .innerJoin(representativeThread, eq(representativeThread.id, held.threadId))
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(
      and(
        eq(representative.userId, userId),
        eq(representativeOutboundDecision.rule, draftRule),
        eq(held.resolution, "approved"),
      ),
    )
    .groupBy(sql`lower(${held.topic})`);
  return new Map(rows.map((row) => [row.label, row.count]));
}

/** The owner's topics, oldest first. */
export async function listTopics({ db }: Pick<Context, "db">, userId: string) {
  const rows = await db
    .select()
    .from(topic)
    .where(eq(topic.userId, userId))
    .orderBy(asc(topic.createdAt), asc(topic.id));
  const approved = await approvedUnedited(db, userId);
  return rows.map((row) => view(row, approved.get(row.name.toLowerCase()) ?? 0));
}

/**
 * Moves the owner's topic to `mode`. Only this does: nothing a Model writes reaches it, and the
 * suggestion after enough approvals is only shown.
 */
export async function setTopicMode(
  context: Pick<Context, "db">,
  userId: string,
  id: string,
  mode: TopicMode,
) {
  const [row] = await context.db
    .update(topic)
    .set({ mode })
    .where(and(eq(topic.id, id), eq(topic.userId, userId)))
    .returning();
  if (!row) throw rpcError("NOT_FOUND", "error.topicNotFound", "Topic not found");
  const approved = await approvedUnedited(context.db, userId);
  return view(row, approved.get(row.name.toLowerCase()) ?? 0);
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

/**
 * Whether a reply's sources all belong to its topic: it has some, and each is a Published fact whose
 * topic is the label, ignoring case. A document, a Bot's result or a memory has no topic, so a reply
 * resting on one never does, and a reply resting on nothing has nothing to check.
 */
export async function sourcesBelongToLabel(
  tx: Transaction,
  userId: string,
  label: string | undefined,
  sources: ReplySource[] | undefined,
) {
  if (label === undefined || !sources?.length) return false;
  const keys: string[] = [];
  for (const source of sources) {
    if (source.type !== "fact") return false;
    keys.push(source.key);
  }
  const rows = await tx
    .select({
      key: representativeFact.key,
      onTopic: sql<boolean>`lower(${representativeFact.topic}) = lower(${label})`,
    })
    .from(representativeFact)
    .where(and(eq(representativeFact.userId, userId), inArray(representativeFact.key, keys)));
  const onTopic = new Map(rows.map((row) => [row.key, row.onTopic]));
  return keys.every((key) => onTopic.get(key) === true);
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

import { and, asc, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@botsdk/bot/plugin";
import { maxThreadMessageLength } from "../shared/contract";
import { isInEffect } from "../shared/facts";
import { type ReplyKind, type ReplySource, sourceFreeKinds } from "../shared/replies";
import type { ThreadEntry } from "./customers";
import { representativeFact } from "./db/schema";

/*
 * The check of a Representative's reply before anything is sent (ticket #1260). A Model writes a
 * Published fact's key as `{{key}}` and code puts the fact's value there, so no Model can misquote
 * it. Code also checks what the reply says it rests on. That proves each source exists, not that
 * what the reply says of it is right. A refusal sends nothing and tells the Model why.
 */

const keyPattern = /\{\{([^{}]*)\}\}/g;

/**
 * The most a reply's answer to the Model holds of the values put in it, as JSON. Over the long-output
 * limit an answer is cut, and a test conversation reads what was sent from it.
 */
const maxInsertedLength = 8_000;

const keysIn = (text: string) => [...text.matchAll(keyPattern)].map((match) => match[1]!.trim());

/** `text` with each key that has a value replaced by it, once: a value is never read for keys. */
export const insertValues = (text: string, values: Record<string, string>) =>
  text.replace(keyPattern, (written, key: string) => {
    const trimmed = key.trim();
    return Object.hasOwn(values, trimmed) ? values[trimmed]! : written;
  });

const refused = (why: string) => ({ error: `Nothing was sent: ${why}` });

/** The facts of `userId`'s that are in effect at `now`, in a fixed order, as a Turn's prompt lists them. */
export async function factsInEffect(tx: Transaction, userId: string, now: Date) {
  const rows = await tx
    .select()
    .from(representativeFact)
    .where(eq(representativeFact.userId, userId))
    .orderBy(asc(representativeFact.topic), asc(representativeFact.key));
  return rows
    .filter((row) => isInEffect(row, now))
    .map(({ key, type, topic, value }) => ({ key, type, topic, value }));
}

export type CheckedReply = {
  text: string;
  sources: ReplySource[];
  /** The value put in for each key the text wrote. */
  inserted: Record<string, string>;
};

/** `text` with its facts' values in, and every source it rests on; or why it can't be sent. */
export async function checkReply(
  tx: Transaction,
  {
    userId,
    now,
    text,
    kind,
    sources,
    entries,
  }: {
    userId: string;
    now: Date;
    text: string;
    kind: ReplyKind;
    sources: ReplySource[];
    /** What this Turn read of its thread: a Bot's result is a source only if it was this Turn's to tell. */
    entries: ThreadEntry[];
  },
): Promise<CheckedReply | { error: string }> {
  if (/\{\{|\}\}/.test(text.replace(keyPattern, ""))) {
    return refused("the text has a broken {{key}}. Write a fact's key as {{key}}, or not at all.");
  }
  const written = [...new Set(keysIn(text))];
  if (written.length === 0 && sources.length === 0 && !sourceFreeKinds.includes(kind)) {
    return refused(
      `a reply of kind "${kind}" needs at least one source. If nothing you were given says it, don't state it.`,
    );
  }
  const cited = sources.flatMap((source) => (source.type === "fact" ? [source.key] : []));
  const keys = [...new Set([...cited, ...written])];
  const rows =
    keys.length === 0
      ? []
      : await tx
          .select()
          .from(representativeFact)
          .where(and(eq(representativeFact.userId, userId), inArray(representativeFact.key, keys)));
  const facts = new Map(rows.map((row) => [row.key, row]));
  for (const key of keys) {
    const fact = facts.get(key);
    if (!fact) {
      return refused(
        `"${key.slice(0, 64)}" is not a Published fact's key. Use a key you were given, or don't state it.`,
      );
    }
    if (!isInEffect(fact, now)) {
      return refused(`the fact "${key}" isn't in effect now, so don't state it.`);
    }
  }
  for (const source of sources) {
    if (source.type !== "assignment") continue;
    const told = entries.some(
      (entry) =>
        entry.author === "bot" &&
        !entry.earlier &&
        entry.assignmentId === source.assignmentId &&
        entry.text.includes(source.quote),
    );
    if (!told) {
      return refused(
        `no result of Assignment "${source.assignmentId}" that this Turn is to tell has that exact quote.`,
      );
    }
  }
  const inserted = Object.fromEntries(written.map((key) => [key, facts.get(key)!.value]));
  if (JSON.stringify(inserted).length > maxInsertedLength) {
    return refused("it quotes too much at once. Split it into shorter replies.");
  }
  const filled = insertValues(text, inserted);
  if (filled.length > maxThreadMessageLength) {
    return refused("it is too long once its facts' values are in. Say it more shortly.");
  }
  return {
    text: filled,
    inserted,
    sources: [
      ...keys.map((key): ReplySource => ({ type: "fact", key })),
      ...sources.filter((source) => source.type !== "fact"),
    ],
  };
}

import { and, asc, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@botsdk/bot/plugin";
import { maxThreadMessageLength } from "../shared/contract";
import { isInEffect } from "../shared/facts";
import { type ReplyKind, type ReplySource, sourceFreeKinds } from "../shared/replies";
import type { ThreadEntry } from "./customers";
import type { DocumentText } from "./documents";
import { representativeFact } from "./db/schema";

/*
 * The check of a Representative's reply before anything is sent (ticket #1260). A Model writes a
 * Published fact's key as `{{key}}` and code puts the fact's value there, so no Model can misquote
 * it. Code also checks what the reply says it rests on. That proves each source exists, not that
 * what the reply says of it is right. A refusal sends nothing and tells the Model why.
 */

const keyPattern = /\{\{([^{}]*)\}\}/g;

/** The most characters of facts a Turn's prompt lists, so an owner's many facts can't fail every Turn. */
export const factsPromptChars = 100_000;

/** Whether `text` shows braces meant as a key, once whole keys are taken out of it. */
const brokenKey = (text: string) =>
  /\{\{\{|\}\}\}/.test(text) ||
  /\{\{|\}\}|\{[a-z0-9][a-z0-9._-]*\}/.test(text.replace(keyPattern, ""));

const keysIn = (text: string) => [...text.matchAll(keyPattern)].map((match) => match[1]!.trim());

/** `text` with each key that has a value replaced by it, once: a value is never read for keys. */
export const insertValues = (text: string, values: Record<string, string>) =>
  text.replace(keyPattern, (written, key: string) => {
    const trimmed = key.trim();
    return Object.hasOwn(values, trimmed) ? values[trimmed]! : written;
  });

/*
 * A code check of shapes (ticket #1268), not a judge of meaning: money, phone numbers and links a
 * Model typed. A price written out in words is not caught.
 */
const typedShapes = [
  // An amount: a currency sign before it, or a currency name after it.
  {
    name: "price",
    pattern:
      /[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|dollars?|euros?|pounds?|bucks)\b/gi,
  },
  // A scheme or "www.", or a bare domain on a common top-level domain.
  {
    name: "link",
    pattern:
      /\b(?:https?:\/\/|www\.)[^\s<>"]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|app|dev|info|biz|us|uk|ca|au|de|fr|shop|store|online|site)\b(?:\/[^\s<>"]*)?/gi,
  },
  // Seven to fifteen digits with the usual separators, other than a date.
  { name: "phone number", pattern: /\+?\(?\d[\d\s().-]{5,}\d/g },
];

const digitsOf = (text: string) => text.replace(/\D/g, "");
const squashed = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

/** The first price, phone number or link in `text` that none of `allowed` holds, or undefined. */
function typedValue(text: string, allowed: string[]) {
  const lowered = allowed.map(squashed);
  const numbers = allowed.map(digitsOf);
  for (const { name, pattern } of typedShapes) {
    for (const [found] of text.matchAll(pattern)) {
      const value = found.replace(/[.,;:!?)]+$/, "");
      if (name === "phone number") {
        const digits = digitsOf(value);
        if (digits.length < 7 || digits.length > 15 || /^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
        if (numbers.some((held) => held.includes(digits))) continue;
        return { name, value };
      }
      if (lowered.some((held) => held.includes(squashed(value)))) continue;
      return { name, value };
    }
  }
  return undefined;
}

export const refused = (why: string) => ({
  error: `Nothing was sent: ${why}`,
  refused: true as const,
});

/** What a Customer gets when code hands off (ticket #1261), so a refused guess never reaches them. */
export const handOffMessage =
  "I can't confirm that right now, so I've passed this on to someone who can. They'll follow up with you here.";

/**
 * The facts of `userId`'s that are in effect at `now`, in a fixed order, as a Turn's prompt lists
 * them, up to `factsPromptChars`; `more` says some didn't fit.
 */
export async function factsInEffect(tx: Transaction, userId: string, now: Date) {
  const rows = await tx
    .select()
    .from(representativeFact)
    .where(eq(representativeFact.userId, userId))
    .orderBy(asc(representativeFact.topic), asc(representativeFact.key));
  const facts: Array<Pick<(typeof rows)[number], "key" | "type" | "topic" | "value">> = [];
  let chars = 0;
  for (const { key, type, topic, value, ...dates } of rows) {
    if (!isInEffect(dates, now)) continue;
    chars += key.length + topic.length + value.length;
    if (chars > factsPromptChars) return { facts, more: true };
    facts.push({ key, type, topic, value });
  }
  return { facts, more: false };
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
    documents,
  }: {
    userId: string;
    now: Date;
    text: string;
    kind: ReplyKind;
    sources: ReplySource[];
    /** What this Turn read of its thread: a Bot's result is a source only if it was this Turn's to tell. */
    entries: ThreadEntry[];
    /** The documents the Turn's Release pinned: a quote is checked against these and no other text. */
    documents: DocumentText[];
  },
): Promise<CheckedReply | ReturnType<typeof refused>> {
  if (brokenKey(text)) {
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
  for (const source of sources) {
    if (source.type !== "document") continue;
    const document = documents.find((candidate) => candidate.name === source.name);
    if (!document) {
      return refused(
        `"${source.name.slice(0, 64)}" is not a document of this Release. Cite one you were given, or don't state it.`,
      );
    }
    if (!document.text.includes(source.quote)) {
      return refused(
        `document "${source.name.slice(0, 64)}" has no such exact quote. Quote it word for word, or don't state it.`,
      );
    }
  }
  // What the Model typed, with its keys taken out: only a fact's value or a cited quote may hold a
  // price, phone number or link, and a Customer's words are neither.
  const typed = typedValue(text.replace(keyPattern, " "), [
    ...written.map((key) => facts.get(key)!.value),
    ...sources.flatMap((source) => (source.type === "fact" ? [] : [source.quote])),
  ]);
  if (typed) {
    return refused(
      `the text has a ${typed.name} you typed ("${typed.value.slice(0, 64)}"). Only a Published fact's key, written as {{key}}, or a quote you cite may give one.`,
    );
  }
  const inserted = Object.fromEntries(written.map((key) => [key, facts.get(key)!.value]));
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

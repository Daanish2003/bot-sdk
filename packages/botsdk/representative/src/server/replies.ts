import { and, asc, eq, inArray } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { maxThreadMessageLength } from "../shared/contract";
import { isInEffect } from "../shared/facts";
import { type ReplyKind, type ReplySource, sourceFreeKinds } from "../shared/replies";
import type { ThreadEntry } from "./customers";
import { type CustomerMemory, memoryHolds } from "./customer-memory";
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
const withScheme = /(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ww][Ww][Ww]\.)[^\s<>"]+/;
const bareDomain =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|app|dev|info|biz|us|uk|ca|au|de|fr|eu|me|ai|xyz|shop|store|online|site)\b(?:\/[^\s<>"]*)?/;
/** An email address, whole: it is none of the three, whatever digits or domain it holds. With a path it is a link. */
const emailAddress = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+(?![\w/-])/gi;
/**
 * ISO 4217 codes beyond the three the price pattern knows, capitals only, as a list and not any three
 * capitals: "24 HRS" and "10 USB" are no prices. AMD is left out, as "Ryzen 5 AMD" is the likelier read.
 */
const currencyCodes =
  "AED|AFN|ANG|AOA|ARS|AUD|AWG|AZN|BBD|BDT|BGN|BHD|BIF|BMD|BND|BRL|BSD|BTN|BWP|BYN|BZD|CAD|CDF|CHF|CLP|CNY|CRC|CVE|CZK|DJF|DKK|DOP|DZD|EGP|ERN|ETB|FJD|FKP|GHS|GIP|GMD|GNF|GTQ|GYD|HKD|HNL|HTG|HUF|IDR|ILS|INR|IQD|IRR|ISK|JMD|JOD|JPY|KES|KGS|KHR|KMF|KPW|KRW|KWD|KYD|KZT|LAK|LBP|LKR|LRD|LSL|LYD|MDL|MGA|MKD|MMK|MNT|MRU|MUR|MVR|MWK|MXN|MYR|MZN|NAD|NGN|NIO|NOK|NPR|NZD|OMR|PAB|PGK|PKR|PLN|PYG|QAR|RSD|RUB|RWF|SAR|SBD|SCR|SDG|SEK|SGD|SHP|SLE|SRD|SSP|STN|SVC|SYP|SZL|THB|TJS|TMT|TND|TTD|TWD|TZS|UAH|UGX|UYU|UZS|VES|VND|VUV|WST|XAF|XCD|XOF|XPF|YER|ZAR|ZMW|ZWG";
/** The codes that also read as a word or a name, only after an amount: "TOP 10" is no price and "50 TRY" is. */
const wordLikeCurrencyCodes = "ALL|BAM|BOB|COP|CUP|GEL|MAD|MOP|PEN|PHP|RON|SOS|TOP|TRY";
const amount = String.raw`\d[\d,]*(?:\.\d+)?`;
const phoneShape = /\+?\(?\d{1,4}\)?(?:[ .-]?\(?\d{2,4}\)?){2,5}/g;
const typedShapes = [
  // An amount: a currency sign or code beside it, or a currency name after it.
  {
    name: "price",
    pattern:
      /(?:\p{Sc}|\b(?:usd|eur|gbp)\s?)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:\p{Sc}|(?:usd|eur|gbp|dollars?|euros?|pounds?|cents?|bucks)\b)/giu,
  },
  {
    name: "price",
    pattern: new RegExp(
      String.raw`\b(?:${currencyCodes})\s?${amount}(?!\w)|(?<!\p{Sc}\s?)\b${amount}\s?(?:${currencyCodes}|${wordLikeCurrencyCodes})\b`,
      "gu",
    ),
  },
  // A scheme or "www.", or a bare domain on a common lowercase top-level domain.
  {
    name: "link",
    pattern: new RegExp(`${withScheme.source}|${bareDomain.source}`, "g"),
  },
  // Groups of digits with the usual separators.
  { name: "phone number", pattern: phoneShape },
];

const digitsOf = (text: string) => text.replace(/\D/g, "");
const squashed = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

/** Whether `held` has `value` whole, not as the start, end or middle of a longer number or word. */
function holds(held: string, value: string) {
  for (let at = held.indexOf(value); at !== -1; at = held.indexOf(value, at + 1)) {
    const before = held[at - 1] ?? " ";
    const after = held.slice(at + value.length, at + value.length + 2);
    if (!/[\w\p{Sc}@.]/u.test(before) && !/^(?:\w|[.,]\w)/.test(after)) return true;
  }
  return false;
}

/** The digits of each phone number in `text`; a date, or digits run together under ten, is not one. */
function phonesIn(text: string) {
  const phones: string[] = [];
  for (const [found] of text.matchAll(phoneShape)) {
    const value = found.trim();
    const digits = digitsOf(value);
    if (digits.length < 7 || digits.length > 15) continue;
    if (/^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}$/.test(value)) continue;
    if (!/[+( .-]/.test(value) && digits.length < 10) continue;
    phones.push(value);
  }
  return phones;
}

/** The first price, phone number or link in `text` that none of `allowed` holds, or undefined. */
function typedValue(text: string, allowed: string[]) {
  const lowered = allowed.map(squashed);
  const numbers = new Set(allowed.flatMap(phonesIn).map(digitsOf));
  const read = text.replace(emailAddress, " ");
  for (const { name, pattern } of typedShapes) {
    if (name === "phone number") {
      const loose = phonesIn(read).find((value) => !numbers.has(digitsOf(value)));
      if (loose) return { name, value: loose };
      continue;
    }
    for (const [found] of read.matchAll(pattern)) {
      const value = found.replace(/[.,;:!?)]+$/, "");
      if (lowered.some((held) => holds(held, squashed(value)))) continue;
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
export async function factsInEffect(db: FeatureContext["db"], userId: string, now: Date) {
  const rows = await db
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

/** The kind of source list a sent reply has: every fact it names or writes, then the rest as cited. */
const withFactSources = (keys: string[], sources: ReplySource[]) => [
  ...keys.map((key): ReplySource => ({ type: "fact", key })),
  ...sources.filter((source) => source.type !== "fact"),
];

export type ReplyEvidence = { inserted: Record<string, string>; sources: ReplySource[] };

/** What `text`, which `checkReply` passed, went out with, as the facts are now. */
export async function replyEvidence(
  db: FeatureContext["db"],
  userId: string,
  text: string,
  sources: ReplySource[],
): Promise<ReplyEvidence> {
  const written = [...new Set(keysIn(text))];
  const cited = sources.flatMap((source) => (source.type === "fact" ? [source.key] : []));
  const rows =
    written.length === 0
      ? []
      : await db
          .select({ key: representativeFact.key, value: representativeFact.value })
          .from(representativeFact)
          .where(
            and(eq(representativeFact.userId, userId), inArray(representativeFact.key, written)),
          );
  return {
    inserted: Object.fromEntries(rows.map((row) => [row.key, row.value])),
    sources: withFactSources([...new Set([...cited, ...written])], sources),
  };
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
    memory,
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
    /** The verified Customer's memory this Turn read: a quote is checked against this and no other. */
    memory: CustomerMemory;
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
  for (const source of sources) {
    if (source.type === "memory" && !memoryHolds(memory, source.quote)) {
      return refused(
        "this Customer's memory has no such exact quote. Quote what you were given word for word, or don't state it.",
      );
    }
  }
  const inserted = Object.fromEntries(written.map((key) => [key, facts.get(key)!.value]));
  const filled = insertValues(text, inserted);
  // What the Model typed, as the Customer would read it: only a fact's value or a cited quote may
  // hold a price, phone number or link, and a Customer's words are neither. A value sits whole
  // beside what was typed, so digits typed against a key make a number no source holds.
  const typed = typedValue(filled, [
    ...Object.values(inserted),
    ...sources.flatMap((source) => (source.type === "fact" ? [] : [source.quote])),
  ]);
  if (typed) {
    return refused(
      `the text has a ${typed.name} you typed ("${typed.value.slice(0, 64)}"). Only a Published fact's key, written as {{key}}, or a quote you cite may give one.`,
    );
  }
  if (filled.length > maxThreadMessageLength) {
    return refused("it is too long once its facts' values are in. Say it more shortly.");
  }
  return {
    text: filled,
    inserted,
    sources: withFactSources(keys, sources),
  };
}

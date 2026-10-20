import { createHash } from "node:crypto";

import {
  type AnyServerTool,
  convertSchemaToJsonSchema,
  firstSentence,
  type ModelMessage,
  type SystemPrompt,
} from "@tanstack/ai";
import { and, desc, eq, lt, ne, sql } from "drizzle-orm";

import type { PromptHash } from "../../../core/server/chat/hooks";
import { bot, botPromptStart, botTurn, message, usage } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { Transaction } from "../../../core/server/plugin";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { PromptStartSection, PromptStartTool } from "./db/bot-prompt-start";
import { botDirectory, sharedDirectory } from "./computer-tools";
import { formatterIn, knownZone } from "./time-zone";

/** The name of a Prompt start's first message among its sections. */
export const firstMessageSection = "first_message";

/** The Prompt start a loop sends on every model call (slide 31), and what it needs to hash it. */
export type LoopPromptStart = {
  id: string;
  /** The tool definitions every call sends, in place of the live tools' own. */
  tools: PromptStartTool[];
  /** The system blocks, in order, by section name. */
  system: { name: string; text: string }[];
  /** The first message, sent before the loop's input. */
  firstMessage: string;
  /** The last model call before the loop's, with the Prompt start it sent, or `undefined`. */
  previousCall: () => Promise<PreviousCall | undefined>;
};

/** What a model call recorded of its prompt, for the next call to compare against. */
export type PreviousCall = { promptStartId: string | null; hashes: PromptHash[] };

/** The sha256 of `text`, in hex. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `value` as JSON with every object's keys sorted, so equal values have equal bytes. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

/** The definitions of `tools` as a model call sends them, sorted by name. */
function definitionsOf(tools: AnyServerTool[]): PromptStartTool[] {
  return tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.inputSchema ? { inputSchema: convertSchemaToJsonSchema(tool.inputSchema) } : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const builtTime: Intl.DateTimeFormatOptions = {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * The first message: the Bot's environment (its name, the user's time zone, when the Prompt start
 * was built, and which of Computer, Memory and Helpers are on, with their directories), then every
 * tool's name with the first sentence of its description.
 */
function firstMessageOf({
  botId,
  name,
  zone,
  builtAt,
  computer,
  memory,
  tools,
}: {
  botId: string;
  name: string;
  zone: string;
  builtAt: Date;
  computer: boolean;
  memory: boolean;
  tools: PromptStartTool[];
}): string {
  const environment = [
    "[Your environment]",
    `Your name: ${name}`,
    `The user's time zone: ${zone}`,
    `This start of your prompt was built: ${formatterIn(zone, builtTime).format(builtAt)} (${zone})`,
    computer
      ? `Computer: on. Your own directory is ${botDirectory(botId)}, and the Bots share ${sharedDirectory}.`
      : "Computer: off.",
    memory ? `Memory: on. Your memory files are in ${botDirectory(botId)}/memory.` : "Memory: off.",
    // Helpers run on the Computer, so they are on with it.
    computer ? "Helpers: on." : "Helpers: off.",
  ];
  const toolLines = tools.map((tool) => `${tool.name}: ${firstSentence(tool.description)}`);
  return [...environment, "", "[Your tools]", ...toolLines].join("\n");
}

/** A section of `name` holding `text`, hashed. */
const sectionOf = (name: string, text: string): PromptStartSection => ({
  name,
  text,
  hash: sha256(text),
});

/** What a Turn's Prompt start is built from, when the Bot has none yet. */
export type PromptStartParts = {
  turn: { id: string; botId: string; conversationId: string; startedAt: Date };
  now: Date;
  /** The system blocks in their fixed order: rules, Computer, memory snapshot, Routines. */
  system: { name: string; text: string }[];
  tools: AnyServerTool[];
  computer: boolean;
  memory: boolean;
};

/**
 * The id of the Prompt start a Turn sends, in `tx`: the Bot's latest, or, for its first Turn, one
 * built from `parts` and stored. It is set on the Turn's row. Call it in a recorded activity, so a
 * replay reads the same row.
 */
export async function promptStartFor(tx: Transaction, parts: PromptStartParts): Promise<string> {
  const { turn } = parts;
  const [latest] = await tx
    .select({ id: botPromptStart.id })
    .from(botPromptStart)
    .where(eq(botPromptStart.botId, turn.botId))
    .orderBy(desc(botPromptStart.builtAt), desc(botPromptStart.id))
    .limit(1);
  const id = latest?.id ?? (await buildPromptStart(tx, parts));
  await tx.update(botTurn).set({ promptStartId: id }).where(eq(botTurn.id, turn.id));
  return id;
}

async function buildPromptStart(tx: Transaction, parts: PromptStartParts): Promise<string> {
  const { turn } = parts;
  const [owner] = await tx.select({ name: bot.name }).from(bot).where(eq(bot.id, turn.botId));
  // The user's zone is the newest user Message's before the Turn, as for the time notice.
  const [newestUser] = await tx
    .select({ parts: message.parts })
    .from(message)
    .where(
      and(
        eq(message.conversationId, turn.conversationId),
        eq(message.role, "user"),
        lt(message.createdAt, turn.startedAt),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1);
  const tools = definitionsOf(parts.tools);
  const firstMessage = firstMessageOf({
    botId: turn.botId,
    name: owner?.name ?? "",
    zone: knownZone(newestUser?.parts.timeZone),
    builtAt: parts.now,
    computer: parts.computer,
    memory: parts.memory,
    tools,
  });
  const id = uuidv7();
  await tx.insert(botPromptStart).values({
    id,
    botId: turn.botId,
    builtAt: parts.now,
    summaryId: null,
    tools,
    sections: [
      ...parts.system.map((block) => sectionOf(block.name, block.text)),
      sectionOf(firstMessageSection, firstMessage),
    ],
  });
  return id;
}

/** The stored Prompt start `id`, as a loop sends it. */
export async function loopPromptStart(
  db: Database | Transaction,
  id: string,
  previousCall: LoopPromptStart["previousCall"],
): Promise<LoopPromptStart> {
  const [row] = await db.select().from(botPromptStart).where(eq(botPromptStart.id, id));
  if (!row) throw new Error(`Prompt start ${id} no longer exists`);
  const system = row.sections.filter((section) => section.name !== firstMessageSection);
  const first = row.sections.find((section) => section.name === firstMessageSection);
  if (!first) throw new Error(`Prompt start ${id} has no first message`);
  return {
    id,
    tools: row.tools,
    system: system.map(({ name, text }) => ({ name, text })),
    firstMessage: first.text,
    previousCall,
  };
}

/**
 * The prompt hashes of the Bot's last recorded model call in a Turn before `turn`'s. It reads the
 * user's usage rows newest first, on their `(user_id, created_at)` index.
 */
export async function previousTurnCall(
  db: Database | Transaction,
  turn: { id: string; botId: string; userId: string },
): Promise<PreviousCall | undefined> {
  const [row] = await db
    .select({ hashes: usage.promptHashes, promptStartId: botTurn.promptStartId })
    .from(usage)
    .innerJoin(botTurn, eq(sql`${botTurn.id}::text`, usage.sourceId))
    .where(
      and(
        eq(usage.userId, turn.userId),
        eq(usage.kind, "turn"),
        eq(botTurn.botId, turn.botId),
        ne(botTurn.id, turn.id),
      ),
    )
    .orderBy(desc(usage.createdAt), desc(usage.id))
    .limit(1);
  return row?.hashes ? { promptStartId: row.promptStartId, hashes: row.hashes } : undefined;
}

/** What one model call sends of a Prompt start and history. */
/** A section's hash, with its size estimated at 4 characters a token. */
const hashed = (name: string, text: string): PromptHash => ({
  name,
  hash: sha256(text),
  tokens: Math.ceil(text.length / 4),
});

type SentPrompt = {
  tools: unknown[];
  systemPrompts: SystemPrompt[];
  messages: ModelMessage[];
};

/**
 * The hash of each section a model call sends (slide 32): `tools` as canonical JSON, each system
 * block, the first message, then `history`, the messages after it. The first section that differs
 * from `previous` is flagged: `expected` when `previous` sent another Prompt start, else `bug`. On
 * `history`, it is the messages `previous` sent that differ, so only the newest may be new.
 */
export function promptHashesOf(
  start: Pick<LoopPromptStart, "id" | "system">,
  sent: SentPrompt,
  previous: PreviousCall | undefined,
): PromptHash[] {
  const [first, ...history] = sent.messages;
  const sections: PromptHash[] = [
    hashed("tools", canonicalJson(sent.tools)),
    ...sent.systemPrompts.map((prompt, index) =>
      hashed(
        start.system[index]?.name ?? `system_${index}`,
        typeof prompt === "string" ? prompt : prompt.content,
      ),
    ),
    hashed(
      firstMessageSection,
      typeof first?.content === "string" ? first.content : canonicalJson(first),
    ),
  ];
  const sentHistory: PromptHash = {
    ...hashed("history", canonicalJson(history)),
    messages: history.length,
  };
  if (!previous) return [...sections, sentHistory];
  const changed = previous.promptStartId === start.id ? "bug" : "expected";
  const differs = sections.findIndex((section, index) => {
    const before = previous.hashes[index];
    return before?.name !== section.name || before.hash !== section.hash;
  });
  if (differs >= 0) {
    sections[differs] = { ...sections[differs]!, changed };
    return [...sections, sentHistory];
  }
  const before = previous.hashes.find((entry) => entry.name === "history");
  const kept =
    before?.messages !== undefined &&
    before.messages <= history.length &&
    sha256(canonicalJson(history.slice(0, before.messages))) === before.hash;
  return [...sections, kept ? sentHistory : { ...sentHistory, changed }];
}

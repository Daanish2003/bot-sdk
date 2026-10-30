import { type AnyServerTool, convertSchemaToJsonSchema, firstSentence } from "@tanstack/ai";
import { and, desc, eq, exists, isNull, lt, ne, or, sql } from "drizzle-orm";

import { bot, botPromptStart, botSummary, botTurn, message, usage } from "../../storage";
import type { Database, PromptStartSection, PromptStartTool } from "../../storage";
import type { Transaction } from "../../plugin";
import { uuidv7 } from "../../lib/uuidv7";
import {
  botDirectory,
  formatterIn,
  knownZone,
  noResetAfter,
  sharedDirectory,
} from "../conversation";
import { describeToolName, runToolName } from "./tool-search";
import {
  firstMessageSection,
  type LoopPromptStart,
  type PreviousCall,
  sha256,
} from "../agent-loop";

/** The definitions of `tools` as a model call sends them, sorted by name. */
export function definitionsOf(tools: AnyServerTool[]): PromptStartTool[] {
  return tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.inputSchema ? { inputSchema: convertSchemaToJsonSchema(tool.inputSchema) } : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const toolsHeader = "[Your tools]";
const deferredHeader = `[Deferred tools: call ${describeToolName} with the name first, then ${runToolName}]`;

/** The names of the tools a first message lists, deferred ones included. */
export function listedToolNames(firstMessage: string): Set<string> {
  const start = firstMessage.indexOf(`${toolsHeader}\n`);
  if (start < 0) return new Set();
  const end = firstMessage.indexOf("\n\n[Summary of your conversation so far]");
  return new Set(
    firstMessage
      // The Summary, when there is one, follows the tool lists.
      .slice(start, end < 0 ? undefined : end)
      .split("\n")
      .flatMap((line) => /^([^\s:]+): /.exec(line)?.[1] ?? []),
  );
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
 * was built, and which of Computer and Helpers are on, with their directories, and the features'
 * own lines), then every
 * tool's name with the first sentence of its description: the tools every call sends, then the
 * deferred ones, which need `describe_tool` first, then the Summary when there is one.
 */
function firstMessageOf({
  botId,
  name,
  zone,
  builtAt,
  computer,
  features,
  tools,
  deferred,
  summary,
}: {
  botId: string;
  name: string;
  zone: string;
  builtAt: Date;
  computer: boolean;
  /** The enabled features' environment lines. */
  features: string[];
  tools: PromptStartTool[];
  deferred: PromptStartTool[];
  summary: string | undefined;
}): string {
  const environment = [
    "[Your environment]",
    `Your name: ${name}`,
    `The user's time zone: ${zone}`,
    `This start of your prompt was built: ${formatterIn(zone, builtTime).format(builtAt)} (${zone})`,
    computer
      ? `Computer: on. Your own directory is ${botDirectory(botId)}, and the Bots share ${sharedDirectory}.`
      : "Computer: off.",
    ...features,
    // Helpers run on the Computer, so they are on with it.
    computer ? "Helpers: on." : "Helpers: off.",
  ];
  const lineOf = (tool: PromptStartTool) => `${tool.name}: ${firstSentence(tool.description)}`;
  const summaryLines =
    summary === undefined ? [] : ["", "[Summary of your conversation so far]", summary];
  return [
    ...environment,
    "",
    toolsHeader,
    ...tools.map(lineOf),
    ...(deferred.length > 0 ? ["", deferredHeader, ...deferred.map(lineOf)] : []),
    ...summaryLines,
  ].join("\n");
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
  /** The system blocks in their fixed order: rules, Computer, features, Skills, Routines, Custom Rules. */
  system: { name: string; text: string }[];
  /** The tools every call sends. */
  tools: AnyServerTool[];
  /** The tools listed in the first message only, loaded on demand. */
  deferred: PromptStartTool[];
  computer: boolean;
  /** The enabled features' lines for the first message's environment. */
  features: string[];
};

/**
 * The Bot's latest Prompt start's id and build time, or `undefined` before its first Turn builds one,
 * or since its latest reset mark (spec #1007): one built before it holds what came before. One that
 * holds a Summary belongs to the Conversation the Summary is about (spec #1055): the Conversation of
 * the Turn a mid-Turn Summary was written in, or the Bot's own for an away one. Only a Turn there, in
 * `conversationId` (the Bot's own when not given), may start from it, so a Room's text never reaches
 * another Conversation's Turns.
 */
export async function latestPromptStart(
  db: Database | Transaction,
  botId: string,
  conversationId?: string,
): Promise<{ id: string; builtAt: Date } | undefined> {
  const own = db.select({ id: bot.conversationId }).from(bot).where(eq(bot.id, botId));
  const aboutHere = db
    .select({ id: botSummary.id })
    .from(botSummary)
    .where(
      and(
        eq(botSummary.id, botPromptStart.summaryId),
        sql`case when ${botSummary.kind} = 'away' then (${own}) else (select ${botTurn.conversationId} from ${botTurn} where ${botTurn.id} = ${botSummary.turnId}) end = ${conversationId ?? sql`(${own})`}`,
      ),
    );
  const [latest] = await db
    .select({ id: botPromptStart.id, builtAt: botPromptStart.builtAt })
    .from(botPromptStart)
    .where(
      and(
        eq(botPromptStart.botId, botId),
        noResetAfter(db, { botId }, botPromptStart.builtAt),
        or(isNull(botPromptStart.summaryId), exists(aboutHere)),
      ),
    )
    .orderBy(desc(botPromptStart.builtAt), desc(botPromptStart.id))
    .limit(1);
  return latest;
}

/** The id of the Bot's latest Prompt start, or `undefined` before its first Turn builds one. */
export async function latestPromptStartId(
  db: Database | Transaction,
  botId: string,
  conversationId?: string,
): Promise<string | undefined> {
  return (await latestPromptStart(db, botId, conversationId))?.id;
}

/**
 * The id of the Prompt start a Turn sends, in `tx`: the Bot's latest, or, for its first Turn, one
 * built from `parts` and stored. It is set on the Turn's row. Call it in a recorded activity, so a
 * replay reads the same row.
 */
export async function promptStartFor(tx: Transaction, parts: PromptStartParts): Promise<string> {
  const { turn } = parts;
  const id =
    (await latestPromptStartId(tx, turn.botId, turn.conversationId)) ??
    (await buildPromptStart(tx, parts));
  await tx.update(botTurn).set({ promptStartId: id }).where(eq(botTurn.id, turn.id));
  return id;
}

/**
 * Builds and stores a Prompt start from `parts`, its first message ending with `summary` when
 * given, and returns its id.
 */
export async function buildPromptStart(
  tx: Transaction,
  parts: PromptStartParts,
  summary?: { id: string; text: string },
): Promise<string> {
  const { turn } = parts;
  const [owner] = await tx.select({ name: bot.name }).from(bot).where(eq(bot.id, turn.botId));
  const tools = definitionsOf(parts.tools);
  const firstMessage = firstMessageOf({
    botId: turn.botId,
    name: owner?.name ?? "",
    zone: await userZoneAt(tx, turn),
    builtAt: parts.now,
    computer: parts.computer,
    features: parts.features,
    tools,
    deferred: parts.deferred,
    summary: summary?.text,
  });
  const id = uuidv7();
  await tx.insert(botPromptStart).values({
    id,
    botId: turn.botId,
    builtAt: parts.now,
    summaryId: summary?.id ?? null,
    tools,
    sections: [
      ...parts.system.map((block) => sectionOf(block.name, block.text)),
      sectionOf(firstMessageSection, firstMessage),
    ],
  });
  return id;
}

/** The user's time zone for a Turn: the newest user Message's before it, as for the time notice. */
export async function userZoneAt(
  tx: Transaction,
  turn: Pick<PromptStartParts["turn"], "conversationId" | "startedAt">,
): Promise<string> {
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
  return knownZone(newestUser?.parts.timeZone);
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

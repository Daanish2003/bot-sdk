import type { SentFile } from "@botsdk/client/bot/files";
import { searchTextOf } from "@botsdk/client/message-parts";
import { type AnyServerTool, type ModelMessage, toolDefinition } from "@tanstack/ai";
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { botTrigger, botTurn, message, type MessageRow } from "../../storage";
import type { Database, PromptStartTool } from "../../storage";
import { enabledFeatures, hasConnectorFeature } from "../../feature";
import type { BotSdkContext, Transaction } from "../../plugin";
import type { WorkflowContext } from "../../runner/internal";
import { type EarlierTurn, changeNotesFor } from "./change-notes";
import {
  capText,
  computerOf,
  computerPrompt,
  spillPath,
  spillThreshold,
  type LoopPromptStart,
} from "../agent-loop";
import { type FeatureSection, featureSectionsNow, featureTurnOf } from "./features";
import {
  botFileRef,
  copyUploads,
  isInlineImage,
  userFilesLine,
  controlOf,
  reactionsOf,
  formatterIn,
  knownZone,
  timeNotice,
} from "../conversation";

import type { LoopKit } from "../agent-loop";

import {
  definitionsOf,
  loopPromptStart,
  previousTurnCall,
  type PromptStartParts,
  promptStartFor,
} from "./prompt-start";
import { createRoutineToolName, routinesPrompt } from "../routines";
import { customRulesPrompt } from "../safety";

import { historyFrom, historyTurns, summaryOf, writeSummary } from "./summary";

import {
  cancelCheckInToolName,
  listCheckInsToolName,
  sendToUserToolName,
  setCheckInToolName,
} from "./tool-names";
import { isDirectTool, toolSearchTools } from "./tool-search";

/*
 * The context of a Bot's Turn (spec #871): its Prompt start, its history from the Prompt start's
 * Summary on, the Change notes, the newest message, and how a Summary rebuilds the Prompt start.
 * An away Summary builds its Prompt start through the same `build`.
 */

const promptOpening =
  "You are a Bot the user talks to in a messenger. The user never sees your text replies or your " +
  `tool calls; they see only the messages you send with the ${sendToUserToolName} tool. `;

/** What the Bot can't do, with no Computer. */
const onlyToolLimits =
  "Besides it, you have only web_search: you cannot send email or messages to anyone else, or act " +
  "outside this chat. ";

/** What the Bot can't do, with its Computer. */
const computerLimits =
  "Besides it, you have only web_search and your computer (below): you cannot send email or " +
  "messages to anyone else. ";

/**
 * The Bot's rules, with or without its Computer. The sentence after "say plainly that you cannot"
 * is a recorded deviation from eval tuning (#575): gpt-5.4-mini answered "I can send the summary if
 * you paste it here, but I can't message your boss directly".
 */
const promptRules =
  "When asked to, say plainly that you cannot, then offer what you can do. Start with the refusal " +
  `(for example, "I can't send email"), and never offer to send anything to anyone but the user. ` +
  `To say something, call ${sendToUserToolName}. You may call it more than once, in order. Set endTurn to ` +
  "true on your last message, so you stop there. Anything you want the user to read goes through " +
  "it, including a refusal (you cannot do what they asked) and a question you need answered. If " +
  "there is nothing worth saying (the user just acknowledged, said goodbye for now, or needs no " +
  "answer), send nothing: reply with no text and no tool call, not even to say you are staying " +
  "quiet. Do not send a pleasantry (you're welcome, good luck, see you) in reply to one. " +
  `When the user asks for something to happen on a schedule, save it with ${createRoutineToolName}; ` +
  "it runs only once the user approves it, and it repeats. For a one-time reminder, or to come back to something once, at a time you choose, " +
  `set a Check-in with ${setCheckInToolName}; it needs no approval, ${listCheckInsToolName} shows ` +
  `the ones you have pending, and ${cancelCheckInToolName} cancels one. When a Routine run finds ` +
  "nothing new worth telling the user, send nothing, not even to say so. When a Check-in you set " +
  "fires, do what its note says.";

/** The fixed Bot system prompt with no Computer: there are no per-Bot instructions. */
export const botSystemPrompt = promptOpening + onlyToolLimits + promptRules;

/**
 * The system prompts of a Bot's Turn. With `computer` on, the Bot's limits allow its Computer, and
 * a second prompt names its own directory and the shared one, its ladder with connectors when
 * `withConnectors` (the Host installs `mcp`); with it off, it is `botSystemPrompt`.
 */
export function botSystemPrompts(
  botId: string,
  withComputer: boolean,
  withConnectors = false,
): string[] {
  if (!withComputer) return [botSystemPrompt];
  return [promptOpening + computerLimits + promptRules, computerPrompt(botId, withConnectors)];
}

/** The Turn a catalogue is listed for. */
export type CatalogueTurn = {
  id: string;
  botId: string;
  userId: string;
  conversationId: string;
  model: string;
};

/** A Turn's tools, as the catalogue lists them. */
export type TurnTools = {
  /** The core's tools, then the features' tools, which never shadow the core's. */
  tools: AnyServerTool[];
  /**
   * `describe_tool` and `run_tool`, which reach the tools the Prompt start lists by name only. A
   * Connector tool whose Connection listed nothing this Turn is still answered, with its error.
   */
  searchTools: AnyServerTool[];
  /** The names of the tools whose features say they are Connector tools. */
  connectorNames: Set<string>;
  /** Whether SendToUser has sent the Turn's last Message. */
  ended: () => boolean;
};

/** A Helper on the Bot's to-do list (#567), as the Turn that reads it started. */
export type TodoItem = {
  id: string;
  type: "general" | "computer_use";
  status: "running" | "waiting";
  gist: string;
  /** ISO, so the Turn's start Checkpoint records it as it reads. */
  startedAt: string;
  /** Why a waiting Helper needs the user: its open Computer card's reason. */
  reason?: string;
};

/** The Turn a context is built for. */
export type ContextTurn = CatalogueTurn & { startedAt: Date };

/**
 * How a context reads what can change between Turns, once: the Bot's Routines, the enabled
 * features' sections and Change notes, then the tool catalogue, given those sections.
 */
export type ContextReads = {
  routines: () => Promise<string | null>;
  /** The user's active Custom Rules block (ADR 0031), or null when they have none. */
  customRules: () => Promise<string | null>;
  features: () => Promise<FeatureSection[]>;
  tools: (sections: readonly FeatureSection[]) => Promise<TurnTools>;
};

/** What a Turn's loop starts from: its Prompt start, history and newest message. */
export type TurnStart = {
  promptStart: LoopPromptStart;
  /** The earlier Turns from the Prompt start's Summary on. */
  history: ModelMessage[];
  /** How the loop summarizes mid-Turn, building the next Prompt start from this context. */
  summarize: {
    write: (tx: Transaction, prose: string) => Promise<string>;
    load: (id: string) => Promise<LoopPromptStart>;
  };
  /** The Turn's newest message, which holds the Change notes. */
  newest: ModelMessage[];
  /** The tools the Prompt start sends that the catalogue no longer has, each saying it is gone. */
  retired: AnyServerTool[];
};

/** A Bot's context, as read once for a Turn. */
export type BotContext = {
  /** The Turn's tools, as the catalogue listed them. */
  tools: TurnTools;
  /** What a Prompt start built at `now` holds: by the Bot's first Turn, or by a Summary. */
  parts: (now: Date) => PromptStartParts;
  /**
   * The Turn's start, through its loop's `kit`: the Bot's latest Prompt start, or the one its first
   * Turn builds from this context, recorded so a replay sends the row its attempt chose; then the
   * history and the Change notes since it, which `newest` renders into the newest message. `db`
   * reads the stored Prompt start.
   */
  start: (
    kit: Pick<LoopKit, "liveActivity">,
    options: {
      db: Database | Transaction;
      newest: (changeNotes: string | undefined) => Promise<ModelMessage[]>;
    },
  ) => Promise<TurnStart>;
};

/**
 * The Bot's context for `turn`, read once through `reads`. Memory and Routines are still read
 * every Turn (ADR 0022, amended), but the Prompt start keeps them as they were when it was built. A
 * Summary written mid-Turn builds the next Prompt start from the tools and the system blocks as this
 * Turn read them at its start.
 */
export async function build(
  deps: BotSdkContext,
  turn: ContextTurn,
  reads: ContextReads,
): Promise<BotContext> {
  const routines = await reads.routines();
  const customRules = await reads.customRules();
  const features = await reads.features();
  const tools = await reads.tools(features);
  const withComputer = Boolean(deps.computer);
  const parts = (now: Date): PromptStartParts =>
    startParts(turn, now, {
      tools: tools.tools,
      withComputer,
      withConnectors: hasConnectorFeature(deps),
      features,
      routines,
      customRules,
    });
  return {
    tools,
    parts,
    start: async (kit, { db, newest }) => {
      const { id } = await kit.liveActivity("prompt_start", undefined, async (tx) => ({
        id: await promptStartFor(tx, parts(deps.clock())),
      }));
      const promptStart = await loopPromptStart(db, id, () => previousTurnCall(deps.db, turn));
      const summary = await summaryOf(db, id);
      const earlier = await historyTurns(db, turn.botId, summary, turn.startedAt);
      // A mid-Turn Summary's Prompt start was built from what its Turn read at its start, so what
      // the Bot saw and did in that Turn counts as seen since it too.
      const seenSince: EarlierTurn[] = earlier.map((row) =>
        summary?.kind === "mid_turn" && row.id === summary.turnId
          ? { ...row, promptStartId: id }
          : row,
      );
      // What changed since the Prompt start, from what this Turn read: the features' sections and
      // the Routines as recorded, and the live tools.
      const changeNotes = await changeNotesFor(db, id, seenSince, {
        features,
        routines,
        customRules,
        tools: definitionsOf(tools.tools),
        connectors: tools.connectorNames,
      });
      // A tool a deploy removed stays defined, as the Prompt start sends it, and says it is gone.
      const known = new Set([...tools.tools, ...tools.searchTools].map((tool) => tool.name));
      return {
        promptStart,
        history: historyFrom(earlier, summary),
        summarize: {
          write: (tx, prose) =>
            writeSummary(tx, { parts: parts(deps.clock()), prose, kind: "mid_turn" }),
          load: (summarized) => loopPromptStart(db, summarized, async () => undefined),
        },
        newest: await newest(changeNotes),
        retired: promptStart.tools.filter((tool) => !known.has(tool.name)).map(retiredTool),
      };
    },
  };
}

/**
 * A Turn's recorded reads of its Routines and its features' sections, through its loop's `kit`: a
 * replay reads the recorded ones. With no feature, there is no activity, so the histories of Turns
 * without one don't change.
 */
export function recordedReads(
  deps: BotSdkContext,
  turn: ContextTurn,
  kit: LoopKit,
): Pick<ContextReads, "routines" | "customRules" | "features"> {
  return {
    customRules: () =>
      kit.liveActivity(
        "custom_rules",
        undefined,
        async (tx) => (await customRulesPrompt(tx, turn.userId)) ?? null,
      ),
    routines: () =>
      kit.liveActivity(
        "routines",
        undefined,
        async (tx) => (await routinesPrompt(tx, turn.botId)) ?? null,
      ),
    features: async () => {
      if (!enabledFeatures(deps).length) return [];
      const read = await kit.liveRequest("features", undefined, () =>
        featureSectionsNow(deps, featureTurnOf(turn), turn.startedAt, kit.signal, { masked: true }),
      );
      return Array.isArray(read) ? read : [];
    },
  };
}

/**
 * How a Turn renders its newest message once its Change notes are known, and stores it before its
 * first model call, so a stopped or interrupted Turn keeps what it sent, and a replay reads the
 * recorded input. A long Trigger is cut once, and the user's files are copied onto the Computer,
 * each in its own Checkpoint, so a replay reads the recorded text and paths. History is each
 * earlier Turn's stored input, then its transcript: nothing is rendered again, so its bytes never
 * change. What an earlier Turn sent is in its input; only what came after the last such Turn
 * started is new.
 */
export async function newestRenderer(
  deps: BotSdkContext,
  turn: ContextTurn,
  ctx: WorkflowContext<Transaction>,
  {
    db,
    todo,
    attempt,
    canSee,
  }: {
    db: Database | Transaction;
    todo: TodoItem[] | null;
    attempt?: AbortSignal;
    /** Whether the Bot's Model sees images. */
    canSee: () => Promise<boolean>;
  },
): Promise<(changeNotes: string | undefined) => Promise<ModelMessage[]>> {
  const cutTrigger = (id: string, text: string) =>
    text.length <= spillThreshold
      ? Promise.resolve(text)
      : ctx.step(
          "trigger_text",
          async () => {
            const computer = deps.computer ? computerOf(deps, turn.userId) : undefined;
            return capText(
              text,
              spillPath(turn.botId, id),
              computer && ((path, content) => computer.writeFile(path, content)),
            );
          },
          { yields: false },
        );
  const since = await lastInputAt(db, turn);
  const userFiles = {
    place: (files: SentFile[]) =>
      ctx.step(
        "user_files",
        async () =>
          deps.computer
            ? copyUploads(deps, computerOf(deps, turn.userId), turn.botId, files, attempt)
            : files.map(() => null),
        { yields: false },
      ),
    canSee,
  };
  return async (changeNotes) => {
    const rendered = await newestInput(db, turn, since, todo, changeNotes, cutTrigger, userFiles);
    return ctx.step(turnInputActivity, async (tx) => {
      await tx.update(botTurn).set({ input: rendered }).where(eq(botTurn.id, turn.id));
      return rendered;
    });
  };
}

/** The Checkpoint that stores the Turn's newest message, before its first model call. */
const turnInputActivity = "turn_input";

const sinceTime: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * The Bot's to-do list (#567), after the time notice: one line per running or waiting Helper,
 * `<id> · General · running: <gist> · since 10:42`, the time in the user's zone. A Helper waiting
 * on a hand-off reads `waiting for the user: <reason> · task: <gist>`.
 */
function todoNotice(todo: TodoItem[], stored: string | undefined): string {
  const since = formatterIn(knownZone(stored), sinceTime);
  const lines = todo.map((item) => {
    const kind = item.type === "general" ? "General" : "Computer-use";
    const state = item.status === "waiting" ? "waiting for the user" : "running";
    const doing = item.reason === undefined ? item.gist : `${item.reason} · task: ${item.gist}`;
    return `${item.id} · ${kind} · ${state}: ${doing} · since ${since.format(new Date(item.startedAt))}`;
  });
  return ["[Your to-do list: the Helpers still working or waiting for the user]", ...lines].join(
    "\n",
  );
}

/**
 * When the Bot's last Turn before `turn` that took its input started: the last one that stored its
 * input, or one from before Turns stored it (a transcript and no input), whose Messages are not
 * rendered again. `undefined` for the Bot's first Turn.
 */
async function lastInputAt(
  db: Database | Transaction,
  turn: ContextTurn,
): Promise<Date | undefined> {
  const [row] = await db
    .select({ startedAt: botTurn.startedAt })
    .from(botTurn)
    .where(
      and(
        eq(botTurn.botId, turn.botId),
        lt(botTurn.startedAt, turn.startedAt),
        // A Turn stores its input before its first model call, so one with a transcript and no
        // input is from before inputs were stored. One that never ran (stopped while queued, or
        // failed before its first call) has neither, and what it took is still new.
        or(isNotNull(botTurn.input), sql`jsonb_array_length(${botTurn.transcript}) > 0`),
      ),
    )
    .orderBy(desc(botTurn.startedAt), desc(botTurn.id))
    .limit(1);
  return row?.startedAt;
}

/**
 * The Turn's newest message, rendered once: what arrived since `since`, the start of the last Turn
 * that stored its input, in order. Each user Message is a user turn, and each Trigger with no Message (such as a Routine's
 * fire) an input turn of its text, through `cutTrigger`, which cuts a long one once (#668). The
 * newest opens with the time in the newest user Message's zone, as of the Turn's start, then the
 * Change notes (#671), then the to-do list as the Turn's start Checkpoint recorded it. Only what came before the Turn counts, so
 * every attempt reads the same.
 */
async function newestInput(
  db: Database | Transaction,
  turn: ContextTurn,
  since: Date | undefined,
  todo: TodoItem[] | null,
  changeNotes: string | undefined,
  cutTrigger: (id: string, text: string) => Promise<string>,
  userFiles: {
    /** Copies the files onto the Computer: each one's path there, in order, or null. */
    place: (files: SentFile[]) => Promise<(string | null)[]>;
    /** Whether the Bot's Model sees images. */
    canSee: () => Promise<boolean>;
  },
): Promise<ModelMessage[]> {
  const beforeTurn = and(
    eq(message.conversationId, turn.conversationId),
    eq(message.role, "user"),
    lt(message.createdAt, turn.startedAt),
  );
  const [users, woken, [newestUser], reacted] = await Promise.all([
    db
      .select({ id: message.id, parts: message.parts, createdAt: message.createdAt })
      .from(message)
      .where(and(beforeTurn, since && gte(message.createdAt, since)))
      .orderBy(asc(message.createdAt), asc(message.id)),
    // The Triggers that carry no Message (a Routine's fire, #539), taken and received by the time
    // this Turn started: never one taken later. A Turn's input holds the ones taken and received by
    // its start, so one a Stop handed to it later goes to the next Turn, once.
    db
      .select({ id: botTrigger.id, text: botTrigger.text, receivedAt: botTrigger.receivedAt })
      .from(botTrigger)
      .innerJoin(botTurn, eq(botTurn.id, botTrigger.turnId))
      .where(
        and(
          eq(botTrigger.conversationId, turn.conversationId),
          // A user Trigger without a Message is a saved Secret: its text wakes the Bot (spec #691).
          or(ne(botTrigger.source, "user"), isNull(botTrigger.messageId)),
          isNotNull(botTrigger.text),
          lte(botTurn.startedAt, turn.startedAt),
          lte(botTrigger.receivedAt, turn.startedAt),
          since && or(gt(botTurn.startedAt, since), gt(botTrigger.receivedAt, since)),
        ),
      )
      .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id)),
    db
      .select({ parts: message.parts })
      .from(message)
      .where(beforeTurn)
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(1),
    // The user's emojis on the Bot's Messages since the last Turn began (spec #761). They wake
    // nothing, so this is the only way the Bot hears of them.
    db
      .select({ parts: message.parts })
      .from(message)
      .where(
        and(
          eq(message.conversationId, turn.conversationId),
          eq(message.role, "assistant"),
          sql`(${message.parts}->'reactions'->'user'->>'at')::timestamptz <= ${turn.startedAt.toISOString()}::timestamptz`,
          since &&
            sql`(${message.parts}->'reactions'->'user'->>'at')::timestamptz > ${since.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(message.createdAt), asc(message.id)),
  ]);
  // The user's files (spec #801), copied onto the Computer once, in one activity: each Message
  // names its files' paths, and a Model that can see gets its images inline too.
  const sent = users.map((row) => controlOf(row.parts, "files")?.files ?? []);
  const allFiles = sent.flat();
  const placed = allFiles.length ? await userFiles.place(allFiles) : [];
  const pathOf = new Map(allFiles.map((file, index) => [file.id, placed[index] ?? null]));
  const canSee = allFiles.some(isInlineImage) && (await userFiles.canSee());
  const inputs: { at: number; content: string; messageId?: string; images?: SentFile[] }[] =
    users.map((row, index) => {
      const files = sent[index]!;
      const text = searchTextOf(row.parts);
      if (files.length === 0)
        return { at: row.createdAt.getTime(), content: text, messageId: row.id };
      const line = userFilesLine(files.map((file) => ({ ...file, path: pathOf.get(file.id)! })));
      return {
        at: row.createdAt.getTime(),
        content: text ? `${text}\n\n${line}` : line,
        messageId: row.id,
        images: canSee ? files.filter(isInlineImage) : [],
      };
    });
  // One at a time: each long one is an activity, in a stable order.
  for (const row of woken) {
    inputs.push({ at: row.receivedAt.getTime(), content: await cutTrigger(row.id, row.text!) });
  }
  // A stable sort keeps a user Message before a Trigger received at the same time.
  inputs.sort((a, b) => a.at - b.at);
  const newest = inputs.at(-1);
  if (newest) {
    const zone = newestUser?.parts.timeZone;
    // The Change notes share the time's block, which holds no user text: only there are they read
    // back as told (`notesIn`).
    const time = timeNotice(turn.startedAt, zone);
    const notices = [
      changeNotes ? `${time}\n${changeNotes}` : time,
      ...(newest.messageId ? [`[The user's message id, to react to it: ${newest.messageId}]`] : []),
      ...(reacted.length ? [reactionNotice(reacted)] : []),
      ...(todo?.length ? [todoNotice(todo, zone)] : []),
    ];
    newest.content = `${notices.join("\n\n")}\n\n${newest.content}`;
  }
  // One input turn each, never a user Message: a Trigger's text opens with what woke the Bot.
  return inputs.map(({ content, images }) => ({
    role: "user",
    // The images go as refs, which the loop reads from the blob store when it calls the Model.
    content: images?.length
      ? [
          { type: "text", content },
          ...images.map((file) => ({
            type: "image" as const,
            source: {
              type: "url" as const,
              value: `${botFileRef}${file.id}`,
              mimeType: file.mediaType,
            },
          })),
        ]
      : content,
  }));
}

/** The user's new emojis on the Bot's Messages, one line each, the Message quoted. */
function reactionNotice(rows: { parts: MessageRow["parts"] }[]): string {
  const lines = rows.map((row) => {
    const quote = searchTextOf(row.parts).replace(/\s+/g, " ").trim();
    const cut = quote.length > 80 ? `${quote.slice(0, 80)}...` : quote;
    return `${reactionsOf(row.parts)?.user?.emoji} on your message "${cut}"`;
  });
  return ["[The user reacted since your last turn]", ...lines].join("\n");
}

/**
 * What a Prompt start built at `now` holds: the system blocks in their fixed order, and of every
 * tool the code has now (`tools`), the direct ones and `describe_tool` and `run_tool`; the rest are
 * listed by name in its first message and reached through those two.
 */
function startParts(
  turn: PromptStartParts["turn"],
  now: Date,
  {
    tools,
    withComputer,
    withConnectors,
    features,
    routines,
    customRules,
  }: {
    tools: AnyServerTool[];
    withComputer: boolean;
    /** Whether the Host installs `mcp`, which puts connectors in the ladder. */
    withConnectors: boolean;
    /** The enabled features' sections, each named by its feature's id (spec #871). */
    features: FeatureSection[];
    routines: string | null;
    customRules: string | null;
  },
): PromptStartParts {
  const [rules, computerBlock] = botSystemPrompts(turn.botId, withComputer, withConnectors);
  return {
    turn,
    now,
    system: [
      { name: "rules", text: rules! },
      ...(computerBlock ? [{ name: "computer", text: computerBlock }] : []),
      ...features.flatMap(({ name, section }) => (section ? [{ name, text: section }] : [])),
      ...(routines ? [{ name: "routines", text: routines }] : []),
      ...(customRules ? [{ name: "custom_rules", text: customRules }] : []),
    ],
    tools: [...tools.filter(isDirectTool), ...toolSearchTools(tools)],
    deferred: definitionsOf(tools.filter((tool) => !isDirectTool(tool))),
    computer: withComputer,
    features: features.flatMap(({ environment }) =>
      environment === undefined ? [] : [environment],
    ),
  };
}

/** A tool the Prompt start sent that the code no longer has: it answers that it is gone. */
const retiredTool = (stored: PromptStartTool) =>
  toolDefinition({
    name: stored.name,
    description: stored.description,
    inputSchema: z.object({}).passthrough(),
  }).server(async () => ({
    error:
      `${stored.name} is no longer available (a deploy removed it, or the feature behind it is ` +
      "off). Don't call it again; use another tool for the job, or tell the user it can't be done.",
  }));

import { isEndedAssignment } from "@botsdk/client/bot/assignment";
import type { ModelMessage } from "@tanstack/ai";
import { and, eq, gte, inArray, isNotNull, lte, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { BotSdkContext, Transaction } from "../../plugin";
import { defineCoreJob } from "../../runner/internal";
import {
  bot,
  botAssignment,
  botAssignmentLog,
  botCheckIn,
  botHelper,
  botHelperMessage,
  botPromptStart,
  botReview,
  botSummary,
  botTrigger,
  botTurn,
  message,
} from "../../storage";
import { midTurnNote, sha256 } from "../agent-loop";
import { hintChanged, recordBotChange, redactedText, reviewOwnerOf } from "../conversation";
import { approvalTriggerId, denyForDeletedCustomer } from "../safety";
import { checkInKey, checkInOfKey, lockConversationSet } from "../triggers";
import { assignmentTitleOf, botsThatCanWork, moveToCancelled } from "./assignment";

/*
 * Redacting Assignments by reference (ticket #1288, spec #1170, ADR 0029's amendment): when a Customer
 * is deleted, no copy of their words stays in a Bot's records, and the Bot keeps working. What it
 * reaches, from the Assignments it's given:
 * - the Assignment and those it led to: its children, and any a Turn wholly on it opened;
 * - their logs and their Triggers;
 * - each Turn on them: its notices, and its whole Model side, which can't be told apart;
 * - each other Turn that read one, by its id: only the lines that did;
 * - the Bot's Messages of a Turn wholly on them;
 * - verbatim copies anywhere else in the Bot's Turns and Messages since, its Summaries and its Prompt
 *   starts;
 * - the Check-ins, Helpers and Approvals of a Turn wholly on them, the Triggers those Approvals
 *   left, and any Approval of theirs still open, which is denied so that no action runs for them.
 * It rewrites old history, so the Bot's next call misses the Provider's cache once. A Turn running
 * through it writes its transcript at its end: `queueRedactionAfterTurn` catches that.
 */

/** The Assignment an `assignment` Trigger's id names, whichever notice it is. */
const helperTriggerKey = (helperId: string) => `helper:${helperId}`;

const assignmentIdOfTrigger = sql<string>`split_part(${botTrigger.id}, ':', 2)`;

const turnColumns = {
  id: botTurn.id,
  botId: botTurn.botId,
  conversationId: botTurn.conversationId,
  input: botTurn.input,
  transcript: botTurn.transcript,
  startedAt: botTurn.startedAt,
  endedAt: botTurn.endedAt,
};

/** Whether `text` is the notice a redaction left for a Bot that had read the Assignment it cancelled. */
const isRedactedCancelNotice = (text: string | null) =>
  /^Assignment \S+ was cancelled by /.test(text ?? "") && assignmentTitleOf(text) === redactedText;

/** The Messages that `botIds` wrote since `since`. */
const wroteSince = (botIds: string[], since: Date) =>
  and(
    inArray(message.authorBotId, botIds),
    eq(message.role, "assistant"),
    gte(message.createdAt, since),
  );

/** What a set of Assignments reaches, read in `tx`. */
async function scopeOf(tx: Transaction, userId: string, seeds: string[]) {
  const owned = await tx.select({ id: bot.id }).from(bot).where(eq(bot.userId, userId));
  const botIds = owned.map((row) => row.id);
  const ids = new Set(seeds);
  const checkIns = new Set<string>();
  const helpers = new Set<string>();
  const reviews = new Set<string>();
  let onTurns: string[] = [];
  let whollyOn = new Set<string>();
  let triggers: {
    id: string;
    botId: string;
    conversationId: string;
    text: string | null;
    turnId: string | null;
  }[] = [];
  // Until nothing new turns up: what a Turn wholly on them set going can have Turns of its own.
  for (let size = -1; size !== ids.size + checkIns.size + helpers.size + reviews.size;) {
    size = ids.size + checkIns.size + helpers.size + reviews.size;
    const children = await tx
      .select({ id: botAssignment.id })
      .from(botAssignment)
      .where(inArray(botAssignment.parentAssignmentId, [...ids]));
    for (const child of children) ids.add(child.id);
    triggers = await tx
      .select({
        id: botTrigger.id,
        botId: botTrigger.botId,
        conversationId: botTrigger.conversationId,
        text: botTrigger.text,
        turnId: botTrigger.turnId,
      })
      .from(botTrigger)
      .where(
        and(
          inArray(botTrigger.botId, botIds),
          or(
            and(eq(botTrigger.source, "assignment"), inArray(assignmentIdOfTrigger, [...ids])),
            inArray(botTrigger.id, [
              ...[...checkIns].map(checkInKey),
              ...[...helpers].map(helperTriggerKey),
              ...[...reviews].map(approvalTriggerId),
            ]),
          ),
        ),
      );
    const logged = await tx
      .select({ turnId: botAssignmentLog.turnId })
      .from(botAssignmentLog)
      .where(
        and(inArray(botAssignmentLog.assignmentId, [...ids]), isNotNull(botAssignmentLog.turnId)),
      );
    onTurns = [
      ...new Set(
        [...triggers.filter((row) => !isRedactedCancelNotice(row.text)), ...logged].flatMap(
          (row) => (row.turnId ? [row.turnId] : []),
        ),
      ),
    ];
    const taken = await tx
      .select({ id: botTrigger.id, turnId: botTrigger.turnId })
      .from(botTrigger)
      .where(inArray(botTrigger.turnId, onTurns));
    const inScope = new Set(triggers.map((row) => row.id));
    whollyOn = new Set(
      onTurns.filter((turnId) => {
        const own = taken.filter((row) => row.turnId === turnId);
        return own.length > 0 && own.every((row) => inScope.has(row.id));
      }),
    );
    const wholly = [...whollyOn];
    const opened = await tx
      .select({ id: botAssignmentLog.assignmentId })
      .from(botAssignmentLog)
      .where(
        and(
          inArray(botAssignmentLog.turnId, wholly),
          eq(botAssignmentLog.status, "open"),
          eq(botAssignmentLog.actor, "bot"),
        ),
      );
    for (const row of opened) ids.add(row.id);
    const setCheckIns = await tx
      .select({ id: botCheckIn.id })
      .from(botCheckIn)
      .where(inArray(botCheckIn.createdByTurnId, wholly));
    for (const row of setCheckIns) checkIns.add(row.id);
    const startedHelpers = await tx
      .select({ id: botHelper.id })
      .from(botHelper)
      .where(inArray(botHelper.startedByTurnId, wholly));
    for (const row of startedHelpers) helpers.add(row.id);
    const raised = await tx
      .select({ id: botReview.id })
      .from(botReview)
      .where(or(inArray(botReview.turnId, wholly), inArray(botReview.helperId, [...helpers])));
    for (const row of raised) reviews.add(row.id);
  }
  const assignments = await tx
    .select({
      id: botAssignment.id,
      title: botAssignment.title,
      instructions: botAssignment.instructions,
      status: botAssignment.status,
      result: botAssignment.result,
      assignedBotId: botAssignment.assignedBotId,
      assignedConversationId: bot.conversationId,
      assignedModel: bot.model,
      createdAt: botAssignment.createdAt,
      assignerBotId: botAssignment.assignerBotId,
      assignerFeature: botAssignment.assignerFeature,
      assignerJob: botAssignment.assignerJob,
      assignerTrusted: botAssignment.assignerTrusted,
    })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(and(inArray(botAssignment.id, [...ids]), eq(bot.userId, userId)));
  const idPattern = [...ids].join("|");
  const turns = await tx
    .select(turnColumns)
    .from(botTurn)
    .where(
      and(
        inArray(botTurn.botId, botIds),
        or(
          inArray(botTurn.id, onTurns),
          sql`${botTurn.input}::text ~ ${idPattern}`,
          sql`${botTurn.transcript}::text ~ ${idPattern}`,
        ),
      ),
    );
  const botsInvolved = [
    ...new Set([
      ...assignments.flatMap((row) => [
        row.assignedBotId,
        ...(row.assignerBotId ? [row.assignerBotId] : []),
      ]),
      ...turns.map((turn) => turn.botId),
    ]),
  ];
  // Copies of their words can only be in what these Bots wrote since the first of them came.
  const since = new Date(Math.min(...assignments.map((row) => row.createdAt.getTime())));
  const later = assignments.length
    ? await tx
        .select(turnColumns)
        .from(botTurn)
        .where(and(inArray(botTurn.botId, botsInvolved), gte(botTurn.startedAt, since)))
    : [];
  const sentSince = assignments.length
    ? await tx
        .selectDistinct({ conversationId: message.conversationId })
        .from(message)
        .where(wroteSince(botsInvolved, since))
    : [];
  const ownConversations = await tx
    .select({ conversationId: bot.conversationId })
    .from(bot)
    .where(inArray(bot.id, botsInvolved));
  const conversationIds = [
    ...new Set(
      [...triggers, ...turns, ...later, ...sentSince, ...ownConversations].map(
        (row) => row.conversationId,
      ),
    ),
  ];
  return {
    ids: [...ids],
    assignments,
    triggers,
    turns: [...new Map([...turns, ...later].map((turn) => [turn.id, turn])).values()],
    since,
    onTurns: new Set(onTurns),
    whollyOn,
    checkIns: [...checkIns],
    helpers: [...helpers],
    reviews: [...reviews],
    botsInvolved,
    conversationIds,
  };
}

/** Whether Trigger `id` is an Assignment's, rather than a Check-in's, a Helper's or an Approval's. */
const assignmentOwnsTrigger = (id: string) =>
  checkInOfKey(id) === undefined && !id.startsWith("helper:") && !id.startsWith("approval:");

type Scope = Awaited<ReturnType<typeof scopeOf>>;

type RecordChange = (
  conversationId: string,
  kind: Parameters<typeof recordBotChange>[2],
  refId: string,
) => Promise<void>;

/** Whether `text` may hold someone's words: there's some, and it isn't just what a redaction left. */
const holdsWords = (text: string | null | undefined): text is string =>
  Boolean(text) && text !== redactedText;

/** Under this, a passage can't be told from other words, so it's taken only from its own record. */
const shortestCopy = 12;

/** The passages of `text` a Bot may have copied whole: an Assignment's instructions start with who sent them. */
const passagesOf = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((passage) => passage.trim())
    .filter((passage) => passage.length >= shortestCopy);

/** `text` without any of `copies`, which come longest first, so a shorter can't split a longer. */
const withoutCopies = (text: string, copies: string[]) =>
  copies.reduce((left, copy) => left.split(copy).join(redactedText), text);

/** A Model message without `copies`, in what it says and what it called. */
const entryWithoutCopies = (entry: ModelMessage, copies: string[]): ModelMessage => ({
  ...entry,
  ...(typeof entry.content === "string" && { content: withoutCopies(entry.content, copies) }),
  ...(entry.toolCalls && {
    toolCalls: entry.toolCalls.map((call) => ({
      ...call,
      function: { ...call.function, arguments: withoutCopies(call.function.arguments, copies) },
    })),
  }),
});

/** What's left of a Model message once it's redacted: its shape, so that a replay stays valid. */
function redactedEntry(entry: ModelMessage): ModelMessage {
  if (entry.role === "user" && entry.content === midTurnNote) return entry;
  return {
    role: entry.role,
    content: entry.content === null ? null : redactedText,
    ...(entry.name && { name: entry.name }),
    ...(entry.toolCallId && { toolCallId: entry.toolCallId }),
    ...(entry.toolCalls && {
      toolCalls: entry.toolCalls.map((call) => ({
        ...call,
        function: { ...call.function, arguments: "{}" },
      })),
    }),
  };
}

/**
 * A Turn's stored newest message without the notices of `ids` and without `copies`. A notice is a
 * line naming the Assignment and ending in its quoted title, and runs to the end of its message, as a
 * Trigger's text comes last in one. A line that only names the Assignment is someone's own words.
 */
function redactedInput(input: ModelMessage[], ids: string[], copies: string[]): ModelMessage[] {
  const notice = new RegExp(
    `(^|\\n)(?:Result of )?Assignment (${ids.join("|")}) [^\\n]*: "(?:[^"\\\\\\n]|\\\\.)*"(?=\\n|$)[\\s\\S]*$`,
  );
  const clean = (text: string) =>
    withoutCopies(text, copies).replace(notice, (match, lead: string, id: string) =>
      isRedactedCancelNotice(match.slice(lead.length))
        ? match
        : `${lead}Assignment ${id}: "${redactedText}"`,
    );
  return input.map((entry) => ({
    ...entry,
    content:
      typeof entry.content === "string"
        ? clean(entry.content)
        : Array.isArray(entry.content)
          ? entry.content.map((part) =>
              part.type === "text" ? { ...part, content: clean(part.content) } : part,
            )
          : entry.content,
  }));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Redacts Assignments `ids` of user `userId`, and what they reach (see above), in `tx`, taking the
 * Conversations' locks up front in id order; any lock of the caller's that others take before a
 * Conversation's comes first. One that hasn't ended is cancelled with its children, so no Bot waits
 * on it, its Bot is told if a Turn had read it, and a result after that is refused. Repeating it
 * changes nothing. Returns the Conversations it changed: wake the runner and hint them once `tx`
 * has committed.
 */
export async function redactAssignments(
  deps: BotSdkContext,
  tx: Transaction,
  { userId, ids: seeds }: { userId: string; ids: string[] },
): Promise<string[]> {
  if (seeds.length === 0) return [];
  const beforeLocks = await scopeOf(tx, userId, seeds);
  if (beforeLocks.assignments.length === 0) return [];
  // Asks the Host, so before any Conversation's lock.
  const tellable = await botsThatCanWork(
    deps,
    userId,
    beforeLocks.assignments.filter((row) => !isEndedAssignment(row.status)),
  );
  await lockConversationSet(tx, async (db) => (await scopeOf(db, userId, seeds)).conversationIds);
  const scope = await scopeOf(tx, userId, seeds);
  const { ids, assignments, whollyOn } = scope;
  const now = deps.clock();
  const changed = new Set<string>();
  const change: RecordChange = async (conversationId, kind, refId) => {
    changed.add(conversationId);
    await recordBotChange(tx, { conversationId }, kind, refId, now);
  };

  // Their words, for what can only be cleaned of verbatim copies.
  const notes = await tx
    .select({ note: botAssignmentLog.note })
    .from(botAssignmentLog)
    .where(and(inArray(botAssignmentLog.assignmentId, ids), isNotNull(botAssignmentLog.note)));
  const copies = new Set<string>(
    [
      ...assignments.flatMap((row) => [
        row.title,
        row.instructions,
        row.result?.outcome,
        row.result?.forCustomer,
      ]),
      ...notes.map((row) => row.note),
    ]
      .filter(holdsWords)
      .flatMap(passagesOf),
  );

  for (const row of assignments) {
    const result = row.result && { outcome: redactedText };
    const redacted = row.title === redactedText && row.instructions === redactedText;
    if (redacted && same(row.result, result)) continue;
    await tx
      .update(botAssignment)
      .set({ title: redactedText, instructions: redactedText, result, updatedAt: now })
      .where(eq(botAssignment.id, row.id));
    await change(row.assignedConversationId, "assignment", row.id);
  }
  await tx
    .update(botAssignmentLog)
    .set({ note: redactedText })
    .where(
      and(
        inArray(botAssignmentLog.assignmentId, ids),
        isNotNull(botAssignmentLog.note),
        sql`${botAssignmentLog.note} <> ${redactedText}`,
      ),
    );

  const triggerCopies: string[] = [];
  for (const row of scope.triggers) {
    const text = assignmentOwnsTrigger(row.id)
      ? `Assignment ${row.id.split(":")[1]}: "${redactedText}"`
      : redactedText;
    if (!holdsWords(row.text) || row.text === text || isRedactedCancelNotice(row.text)) continue;
    triggerCopies.push(row.text);
    await tx
      .update(botTrigger)
      .set({ text })
      .where(and(eq(botTrigger.id, row.id), eq(botTrigger.botId, row.botId)));
    changed.add(row.conversationId);
  }

  // The Messages of a Turn wholly on them go first, so that their words leave the rest too.
  const sentBy = (turn: Scope["turns"][number]) =>
    tx
      .select({ id: message.id, parts: message.parts, conversationId: message.conversationId })
      .from(message)
      .where(
        and(
          eq(message.conversationId, turn.conversationId),
          eq(message.authorBotId, turn.botId),
          eq(message.role, "assistant"),
          gte(message.createdAt, turn.startedAt),
          turn.endedAt ? lte(message.createdAt, turn.endedAt) : undefined,
        ),
      );
  const setParts = async (
    row: Awaited<ReturnType<typeof sentBy>>[number],
    parts: typeof row.parts.parts,
  ) => {
    if (same(parts, row.parts.parts)) return;
    await tx
      .update(message)
      .set({ parts: { ...row.parts, parts } })
      .where(eq(message.id, row.id));
    await change(row.conversationId, "message", row.id);
  };
  for (const turn of scope.turns.filter((each) => whollyOn.has(each.id))) {
    for (const row of await sentBy(turn)) {
      const kept = row.parts.parts.filter(
        (part) => part.type !== "thinking" && part.type !== "tool_call",
      );
      for (const part of kept) {
        if (part.type === "text" && holdsWords(part.text as string)) {
          for (const passage of passagesOf(part.text as string)) copies.add(passage);
        }
      }
      await setParts(
        row,
        kept.map((part) => (part.type === "text" ? { ...part, text: redactedText } : part)),
      );
    }
  }
  // A passage another of the owner's Assignments holds too isn't only theirs: a sender's line, say.
  const others = await tx
    .select({
      title: botAssignment.title,
      instructions: botAssignment.instructions,
      result: botAssignment.result,
    })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(and(eq(bot.userId, userId), notInArray(botAssignment.id, ids)));
  const shared = new Set(
    others
      .flatMap((row) => [row.title, row.instructions, row.result?.outcome, row.result?.forCustomer])
      .filter(holdsWords)
      .flatMap(passagesOf),
  );
  const allCopies = [...copies]
    .filter((copy) => !shared.has(copy))
    .sort((a, b) => b.length - a.length);
  if (allCopies.length > 0) {
    const sent = await tx
      .select({ id: message.id, parts: message.parts, conversationId: message.conversationId })
      .from(message)
      .where(wroteSince(scope.botsInvolved, scope.since));
    for (const row of sent) {
      await setParts(
        row,
        row.parts.parts.map((part) =>
          part.type === "text"
            ? { ...part, text: withoutCopies(part.text as string, allCopies) }
            : part,
        ),
      );
    }
  }

  const turnCopies = [...triggerCopies, ...allCopies].sort((a, b) => b.length - a.length);
  for (const turn of scope.turns) {
    const isOn = scope.onTurns.has(turn.id);
    const names = (entry: ModelMessage) => ids.some((id) => JSON.stringify(entry).includes(id));
    const input = turn.input && redactedInput(turn.input, ids, turnCopies);
    const transcript =
      turn.transcript &&
      turn.transcript.map((entry) =>
        isOn || names(entry) ? redactedEntry(entry) : entryWithoutCopies(entry, turnCopies),
      );
    if (same(input, turn.input) && same(transcript, turn.transcript)) continue;
    await tx.update(botTurn).set({ input, transcript }).where(eq(botTurn.id, turn.id));
    await change(turn.conversationId, "turn", turn.id);
  }

  const summaries = await tx
    .select({ id: botSummary.id, text: botSummary.text, conversationId: bot.conversationId })
    .from(botSummary)
    .innerJoin(bot, eq(bot.id, botSummary.botId))
    .where(inArray(botSummary.botId, scope.botsInvolved));
  for (const row of summaries) {
    const text = withoutCopies(row.text, allCopies);
    if (text === row.text) continue;
    await tx.update(botSummary).set({ text }).where(eq(botSummary.id, row.id));
    await change(row.conversationId, "summary", row.id);
  }
  const starts = await tx
    .select({ id: botPromptStart.id, sections: botPromptStart.sections })
    .from(botPromptStart)
    .where(inArray(botPromptStart.botId, scope.botsInvolved));
  for (const row of starts) {
    const sections = row.sections.map((section) => {
      const text = withoutCopies(section.text, allCopies);
      return text === section.text ? section : { ...section, text, hash: sha256(text) };
    });
    if (same(sections, row.sections)) continue;
    await tx.update(botPromptStart).set({ sections }).where(eq(botPromptStart.id, row.id));
  }

  await redactWhatTurnsStarted(deps, tx, scope, change, now);

  // Last, so that its notice stays as the Bot should read it: it names the title, now redacted.
  for (const row of assignments) {
    if (isEndedAssignment(row.status)) continue;
    const moved = await moveToCancelled(
      deps,
      tx,
      { ...row, title: redactedText, assignedUserId: userId },
      { actor: row.assignerFeature ? "feature" : "system" },
      { tell: tellable.has(row.assignedBotId), by: "the user's deleting who it came from", now },
    );
    if (moved) changed.add(row.assignedConversationId);
  }
  return [...changed];
}

/** What a Turn wholly on them set going: Check-ins, Helpers and its Approvals, an open one denied. */
async function redactWhatTurnsStarted(
  deps: BotSdkContext,
  tx: Transaction,
  scope: Scope,
  change: RecordChange,
  now: Date,
) {
  const owners = await tx
    .select({ id: bot.id, conversationId: bot.conversationId })
    .from(bot)
    .where(inArray(bot.id, scope.botsInvolved));
  const conversationOf = (botId: string) =>
    owners.find((owner) => owner.id === botId)!.conversationId;
  const checkIns = await tx
    .update(botCheckIn)
    .set({ note: redactedText })
    .where(and(inArray(botCheckIn.id, scope.checkIns), sql`${botCheckIn.note} <> ${redactedText}`))
    .returning({ id: botCheckIn.id, botId: botCheckIn.botId });
  for (const row of checkIns) await change(conversationOf(row.botId), "check_in", row.id);
  const helpers = await tx
    .select({
      id: botHelper.id,
      botId: botHelper.botId,
      task: botHelper.task,
      report: botHelper.report,
      transcript: botHelper.transcript,
    })
    .from(botHelper)
    .where(inArray(botHelper.id, scope.helpers));
  for (const row of helpers) {
    if (row.task === redactedText) continue;
    await tx
      .update(botHelper)
      .set({
        task: redactedText,
        report: row.report === null ? null : redactedText,
        transcript: row.transcript && row.transcript.map(redactedEntry),
      })
      .where(eq(botHelper.id, row.id));
    await change(conversationOf(row.botId), "helper", row.id);
  }
  await tx
    .update(botHelperMessage)
    .set({ text: redactedText })
    .where(
      and(
        inArray(botHelperMessage.helperId, scope.helpers),
        sql`${botHelperMessage.text} <> ${redactedText}`,
      ),
    );
  const denied = await denyForDeletedCustomer(deps, tx, scope.reviews, now);
  const cleared = await tx
    .update(botReview)
    .set({ input: {}, summary: redactedText, reason: redactedText, output: null })
    .where(and(inArray(botReview.id, scope.reviews), sql`${botReview.summary} <> ${redactedText}`))
    .returning({ id: botReview.id });
  for (const id of new Set([...denied, ...cleared.map((row) => row.id)])) {
    const asked = await reviewOwnerOf(tx, id);
    if (asked) await change(asked.conversationId, "review", id);
  }
  // Each one's card in the thread holds its summary. A Helper's falls in no Turn's time, so by its id.
  const cards = await tx
    .select({ id: message.id, parts: message.parts, conversationId: message.conversationId })
    .from(message)
    .where(
      and(
        inArray(message.conversationId, scope.conversationIds),
        inArray(sql`${message.parts}->'parts'->1->'control'->>'reviewId'`, scope.reviews),
        sql`${message.parts}->'parts'->0->>'text' <> ${redactedText}`,
      ),
    );
  for (const card of cards) {
    const parts = card.parts.parts.map((part) =>
      part.type === "text" ? { ...part, text: redactedText } : part,
    );
    await tx
      .update(message)
      .set({ parts: { ...card.parts, parts } })
      .where(eq(message.id, card.id));
    await change(card.conversationId, "message", card.id);
  }
}

const redactionJobName = "bot.assignment_redaction";

/** The redaction again, for what a Turn left at its end (`queueRedactionAfterTurn`). */
export const assignmentRedactionJob = defineCoreJob({
  name: redactionJobName,
  payload: z.object({ userId: z.string(), ids: z.array(z.uuid()) }),
  run: async ({ userId, ids }, ctx) => {
    const deps = ctx.deps;
    const changed = await ctx.step("redact", (tx) => redactAssignments(deps, tx, { userId, ids }));
    deps.runner.wake();
    for (const conversationId of changed) await hintChanged(deps, conversationId);
  },
});

/**
 * Queues the redaction again for what Turn `turn`, now ended in `tx`, was on and has been redacted: a
 * Turn running through a redaction writes its transcript at its end, and may have sent or assigned
 * since. A job, as `tx` holds this Conversation's lock and the redaction takes others' in id order.
 */
export async function queueRedactionAfterTurn(
  deps: BotSdkContext,
  tx: Transaction,
  turn: { id: string; userId: string },
): Promise<void> {
  const ofTurn = await tx
    .select({ id: botAssignment.id, text: botTrigger.text })
    .from(botTrigger)
    .innerJoin(botAssignment, sql`${botAssignment.id}::text = ${assignmentIdOfTrigger}`)
    .where(
      and(
        eq(botTrigger.turnId, turn.id),
        eq(botTrigger.source, "assignment"),
        eq(botAssignment.title, redactedText),
      ),
    );
  const worked = ofTurn.filter((row) => !isRedactedCancelNotice(row.text));
  if (worked.length === 0) return;
  await deps.runner.enqueueIn(tx, redactionJobName, {
    userId: turn.userId,
    ids: [...new Set(worked.map((row) => row.id))],
  });
}

import { type AnyServerTool, toolDefinition } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { message } from "../../../../core/server/storage";
import type { BotSdkContext } from "../../../../core/server/plugin";
import { routineScheduleSchema } from "../../shared/routine";
import { lockConversation } from "../triggers";
import {
  type CatalogueTurn,
  type FeatureSection,
  type TurnTools,
  featuresDemonstrate,
  featureTools,
  featureTurnOf,
  takenNames,
  toolSearchTools,
  cancelCheckInToolName,
  listCheckInsToolName,
  sendToUserToolName,
  setCheckInToolName,
} from "../context";
import {
  hintChanged,
  recordBotChange,
  appendBotMessage,
  controlParts,
  setReaction,
  textParts,
  copyFilesToStorage,
} from "../conversation";
import {
  cancelCheckInTool,
  pendingCheckIns,
  saveCheckIn,
  createRoutineToolName,
  deleteRoutine,
  deleteRoutineToolName,
  saveRoutine,
  updateRoutine,
  updateRoutineToolName,
} from "../routines";
import { computerToolDefinitions, webSearchTool } from "../agent-loop";
import { helperTools } from "../helpers";
import { watchUserTool } from "../demonstrations";
import type { LoopKit } from "../agent-loop";

import { choiceOptionsSchema } from "../../shared/choice";
import { maxFilesPerMessage } from "../../shared/files";
import { emojiSchema } from "../../shared/reaction";
import type { RichControl } from "../../shared/rich-control";
import { secretNameSchema } from "../../shared/secret";

import { generateImageTool } from "./generate-image";

/*
 * The tool catalogue of a Turn (spec #871): the core's tools, then the enabled features' tools, and
 * the tool search that reaches the deferred ones. A Turn's context lists them in its Prompt start.
 */

/** The activity that copies the files of a `send_to_user` call to storage. */
const sendFilesActivity = "send_to_user:files";

/** What SendToUser returns for an empty `text`: what went wrong, and what to do instead. */
export const emptyTextError =
  `The message was not sent: text is empty. Call ${sendToUserToolName} again with the words the ` +
  "user should read, or, if there is nothing worth saying, reply with no text and no tool call.";

const sendToUserDefinition = toolDefinition({
  name: sendToUserToolName,
  description:
    "Send one message to the user. This is the only way the user sees anything from you: your " +
    "plain text replies stay private. Each call appears to the user at once as its own message, " +
    "in the order you call it. Set endTurn to true on your last message of this turn, so the " +
    "turn ends there; set it to false when you will send more.",
  inputSchema: z.object({
    text: z.string().meta({ description: "The message the user reads, as plain text." }),
    endTurn: z.boolean().meta({
      description: "true on your last message of this turn, false when you will send more.",
    }),
    secret: z
      .object({
        name: secretNameSchema.meta({
          description: "The Secret's name, an environment-variable name like GITHUB_TOKEN.",
        }),
        why: z.string().meta({ description: "Why you need it, in a sentence the user reads." }),
      })
      .optional()
      .meta({
        description:
          "Ask the user for a password or token. The message shows a secure field; the value goes " +
          "straight to the server and you never see it. You are woken with 'Saved secret NAME' " +
          "once they save it. Use it by naming it in the secrets of a shell call.",
      }),
    files: z
      .array(z.string())
      .min(1)
      .max(maxFilesPerMessage)
      .optional()
      .meta({
        description:
          "Paths of files on your computer to send with the message, as downloads under it. They " +
          "are copied when you send, and nothing is sent if one is missing. Not with secret.",
      }),
    choice: z
      .object({
        options: choiceOptionsSchema.meta({ description: "The options the user picks one from." }),
        other: z.boolean().optional().meta({
          description: "true to add an Other option where the user types their own answer.",
        }),
      })
      .optional()
      .meta({
        description:
          "Ask the user to pick one option; the text is the question. You are woken with " +
          'Answered "<question>": <option> once they answer. Not with secret or files.',
      }),
    react: z
      .object({
        messageId: z.uuid().meta({ description: "The id of the user's message to react to." }),
        emoji: emojiSchema.meta({ description: "One emoji." }),
      })
      .optional()
      .meta({
        description:
          "Put an emoji on one of the user's messages instead of replying, such as for a thanks. " +
          "Send no text with it: it makes no message. A second reaction to the same message " +
          "replaces the first. Use endTurn as usual. Not with secret, files or choice.",
      }),
  }),
});

/** A Routine's name: a slug, unique per Bot. */
const routineName = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'name must be a slug: lowercase letters, digits and hyphens, like "morning-brief"',
  )
  .max(60, "name must be at most 60 characters");

const createRoutineDefinition = toolDefinition({
  name: createRoutineToolName,
  description:
    "Save a Routine: a prompt that repeats on a schedule (days of the week at a time in the user's " +
    "time zone) or whenever an outside service calls its webhook URL, never a one-time reminder. Give exactly one of schedule or " +
    "webhook. Use it when the user asks for something recurring, or for something to happen when " +
    "another service sends an event. It runs only once the user approves it, and each run wakes " +
    "you with its prompt. The user gets a webhook Routine's URL in the app; you never see it.",
  inputSchema: z.object({
    name: routineName.meta({
      description: 'A short slug naming the Routine, like "morning-brief".',
    }),
    prompt: z
      .string()
      .trim()
      .min(1, "prompt must not be empty")
      .meta({ description: "What to do on each run, written as an instruction to yourself." }),
    schedule: routineScheduleSchema.optional().meta({
      description:
        'When it runs, like { "days": ["mon", "tue", "wed", "thu", "fri"], "at": "08:00" }. ' +
        "Leave it out for a webhook Routine.",
    }),
    webhook: z
      .boolean()
      .optional()
      .meta({
        description:
          "true to run whenever its webhook URL is called, in place of a schedule. A run reads what " +
          "the call sent after the prompt, as untrusted data.",
      }),
  }),
});

const updateRoutineDefinition = toolDefinition({
  name: updateRoutineToolName,
  description:
    "Change the prompt or the schedule of one of your Routines, named as in your list. A change to " +
    "a Routine the user approved sends it back for their OK: it stops running until they approve it.",
  inputSchema: z.object({
    name: routineName.meta({ description: "The name of the Routine to change." }),
    prompt: z
      .string()
      .trim()
      .min(1, "prompt must not be empty")
      .optional()
      .meta({ description: "The new prompt; leave it out to keep the current one." }),
    schedule: routineScheduleSchema.optional().meta({
      description: "The new schedule; leave it out to keep the current one.",
    }),
  }),
});

const deleteRoutineDefinition = toolDefinition({
  name: deleteRoutineToolName,
  description: "Delete one of your Routines, named as in your list. It never runs again.",
  inputSchema: z.object({
    name: routineName.meta({ description: "The name of the Routine to delete." }),
  }),
});

const setCheckInDefinition = toolDefinition({
  name: setCheckInToolName,
  description:
    "Set a Check-in: a one-time reminder or wake-up at a moment you choose, with a note to your future self. It needs no approval " +
    "and fires once. Use it for a reminder (remind me on Friday), or to follow up later, like checking on Thursday whether someone replied. " +
    "Anything that repeats is a Routine instead.",
  inputSchema: z.object({
    at: z.iso
      .datetime({ offset: true, message: "at must be an ISO 8601 time with an offset" })
      .meta({
        description:
          'When to wake, with an explicit offset, like "2026-10-22T09:00:00+01:00". At least a minute from now.',
      }),
    note: z.string().trim().min(1, "note must not be empty").meta({
      description: "What you will want to remember when you wake, as a note to yourself.",
    }),
  }),
});

const cancelCheckInDefinition = toolDefinition({
  name: cancelCheckInToolName,
  description:
    "Cancel one of your pending Check-ins, by the id list_check_ins or set_check_in gave.",
  inputSchema: z.object({ id: z.uuid().meta({ description: "The Check-in id." }) }),
});

const listCheckInsDefinition = toolDefinition({
  name: listCheckInsToolName,
  description: "List your pending Check-ins, soonest first, so you do not set the same one twice.",
  inputSchema: z.object({}),
});

/** How a live Turn lists its tools: through its loop's `kit`, after its features' sections. */
export type LiveCatalogue = {
  kit: LoopKit;
  /** The sections the Turn's features gave its Prompt start, read before the tools. */
  sections: readonly FeatureSection[];
  /** The features' tools' clients (the Connector tools') stay open until it aborts. */
  signal: AbortSignal;
  /** Records a feature's listing as the Turn's activity, named for the feature. */
  record: <T>(featureId: string, list: () => Promise<T>) => Promise<T>;
};

/**
 * The tools of `turn`, listed once as it starts: nothing is kept from an earlier Turn. With `live`,
 * they run through the Turn's loop; without it, they are built only for their definitions, as an
 * away Summary's Prompt start lists them, and calling one throws.
 */
export async function forTurn(
  deps: BotSdkContext,
  turn: CatalogueTurn,
  live?: LiveCatalogue,
): Promise<TurnTools> {
  let ended = false;
  const kit: LoopKit = live?.kit ?? {
    liveActivity: definitionOnly,
    liveRequest: definitionOnly,
    computerCall: definitionOnly,
    signal: new AbortController().signal,
    computerTools: computerToolDefinitions.map((definition) => definition.server(definitionOnly)),
  };
  const coreTools = coreToolsOf(deps, turn, kit, {
    // The Computer's tools and Helpers, whenever the computer slot is set: the tool set never
    // changes mid-conversation.
    withComputer: Boolean(deps.computer),
    onLastMessage: live
      ? () => {
          ended = true;
        }
      : definitionOnly,
  });
  const fromFeatures = await featureTools(
    deps,
    featureTurnOf(turn),
    kit.liveRequest,
    takenNames(coreTools),
    live && {
      signal: live.signal,
      record: live.record,
      computerCall: kit.computerCall,
      sections: live.sections,
    },
  );
  const tools = [...coreTools, ...fromFeatures.tools];
  return {
    tools,
    searchTools: toolSearchTools(tools, fromFeatures.missing),
    connectorNames: fromFeatures.connectorNames,
    ended: () => ended,
  };
}

/**
 * The Bot's tools for a Turn, run through the loop's `kit`: SendToUser, the Routine and Check-in
 * tools, web search, and with `withComputer` the
 * Computer's tools and the Helper tools, and `watch_user` too with a feature Demonstrations teach. `onLastMessage` runs when SendToUser sends the Turn's last
 * Message.
 */
function coreToolsOf(
  deps: BotSdkContext,
  turn: CatalogueTurn,
  kit: LoopKit,
  { withComputer, onLastMessage }: { withComputer: boolean; onLastMessage: () => void },
): AnyServerTool[] {
  const { liveActivity } = kit;
  const sendToUser = sendToUserDefinition.server(
    async ({ text, endTurn: last, secret, files, choice, react }, context) => {
      if (react) {
        if (secret || files || choice || text.trim())
          return { error: "A reaction is sent alone, with no text, secret, files or choice." };
        const reacted = await liveActivity(sendToUserToolName, context?.toolCallId, async (tx) => {
          await lockConversation(tx, turn.conversationId);
          const [target] = await tx
            .select({ id: message.id })
            .from(message)
            .where(
              and(
                eq(message.id, react.messageId),
                eq(message.conversationId, turn.conversationId),
                eq(message.role, "user"),
              ),
            );
          if (!target) return { error: "No message of the user has that id." };
          const now = deps.clock();
          await setReaction(tx, target.id, "bot", react.emoji, now);
          await recordBotChange(
            tx,
            { conversationId: turn.conversationId },
            "message",
            target.id,
            now,
          );
          return { reacted: true };
        });
        if ("reacted" in reacted) {
          if (last) onLastMessage();
          await hintChanged(deps, turn.conversationId);
        }
        return reacted;
      }
      if ([secret, files, choice].filter(Boolean).length > 1)
        return { error: "A message carries one control: send the secret, files and choice apart." };
      // Copied to storage before the Message, so a missing path sends nothing. The copy is its own
      // Checkpoint, so a crash after it doesn't copy again.
      let control: RichControl | undefined =
        (secret && { kind: "secret", ...secret }) ||
        (choice && { kind: "choice", options: choice.options, other: choice.other ?? false });
      if (files && text.trim()) {
        if (!withComputer) return { error: "You have no computer, so you cannot send files." };
        const copied = await kit.computerCall(
          sendFilesActivity,
          context?.toolCallId,
          (computer, live) => copyFilesToStorage(deps, computer, turn.botId, files, live),
          { capped: false },
        );
        if ("error" in copied) return copied;
        control = { kind: "files", files: copied.files };
      }
      // The Message commits with its Checkpoint, so it is sent once across a crash.
      const result = await liveActivity(sendToUserToolName, context?.toolCallId, async (tx) => {
        if (!text.trim()) return { error: emptyTextError };
        await appendBotMessage(deps, tx, turn.conversationId, {
          parts: control ? controlParts(text, control) : textParts(text),
          createdAt: deps.clock(),
          turnId: turn.id,
        });
        return { sent: true };
      });
      if ("sent" in result) {
        if (last) onLastMessage();
        await hintChanged(deps, turn.conversationId);
      }
      return result;
    },
  );

  // The Turn carries on once the Routine is saved: the Approval is the Routine's, not the call's.
  const createRoutine = createRoutineDefinition.server(async (input, context) =>
    liveActivity(createRoutineToolName, context?.toolCallId, (tx) =>
      saveRoutine(deps, tx, {
        ...input,
        botId: turn.botId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        now: deps.clock(),
      }),
    ),
  );

  const updateRoutineTool = updateRoutineDefinition.server(async (input, context) =>
    liveActivity(updateRoutineToolName, context?.toolCallId, (tx) =>
      updateRoutine(deps, tx, {
        ...input,
        botId: turn.botId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        now: deps.clock(),
      }),
    ),
  );

  const deleteRoutineTool = deleteRoutineDefinition.server(async (input, context) =>
    liveActivity(deleteRoutineToolName, context?.toolCallId, (tx) =>
      deleteRoutine(deps, tx, {
        ...input,
        botId: turn.botId,
        conversationId: turn.conversationId,
      }),
    ),
  );

  const setCheckInTool = setCheckInDefinition.server(async ({ at, note }, context) =>
    liveActivity(setCheckInToolName, context?.toolCallId, (tx) =>
      saveCheckIn(deps, tx, {
        botId: turn.botId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        at: new Date(at),
        note,
        now: deps.clock(),
      }),
    ),
  );

  const cancelCheckInToolImpl = cancelCheckInDefinition.server(async ({ id }, context) =>
    liveActivity(cancelCheckInToolName, context?.toolCallId, (tx) =>
      cancelCheckInTool(deps, tx, { botId: turn.botId, conversationId: turn.conversationId, id }),
    ),
  );

  const listCheckInsTool = listCheckInsDefinition.server(async (_input, context) =>
    liveActivity(listCheckInsToolName, context?.toolCallId, async (tx) => ({
      checkIns: await pendingCheckIns(tx, turn.botId),
    })),
  );

  return [
    sendToUser,
    createRoutine,
    updateRoutineTool,
    deleteRoutineTool,
    setCheckInTool,
    cancelCheckInToolImpl,
    listCheckInsTool,
    webSearchTool(deps, turn.userId, kit.liveRequest),
    ...(withComputer ? [...kit.computerTools, ...helperTools(deps, turn, liveActivity)] : []),
    // Deferred, and listed on two Host settings, so the tool list never changes (spec #801).
    ...(withComputer && deps.models.hasHostImageModels
      ? [generateImageTool(deps, turn, kit.liveRequest)]
      : []),
    // A Demonstration teaches a Skill, so it comes with a feature that says so (spec #713).
    ...(withComputer && featuresDemonstrate(deps) ? [watchUserTool(deps, turn, kit)] : []),
  ];
}

/** Stands in for a tool built only for its definition, which is never called. */
const definitionOnly = (): never => {
  throw new Error("A tool built only for its definition was called");
};

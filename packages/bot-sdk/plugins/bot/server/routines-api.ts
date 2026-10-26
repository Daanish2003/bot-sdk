import { z } from "zod";

import type { BotSdkContext } from "../../../core/server/plugin";
import { parseInput } from "../../../core/server/rpc-error";
import { requireOwnedBot } from "./owned-bot";
import {
  approveRoutine,
  cancelCheckIn,
  declineRoutine,
  listCheckIns,
  listRoutines,
  pauseRoutine,
  removeRoutine,
  resumeRoutine,
  receiveRoutineWebhook,
  rotateWebhook,
} from "./routines";
import { botScopeInput, routineInput, checkInInput } from "../shared/contract";

/*
 * The `routines` and `checkIns` namespaces' domain methods (spec #873), taking the user's id as
 * `bots` does. Each input schema is the one its procedure validates with.
 */

type WithUser<Schema extends z.ZodType> = { userId: string } & z.input<Schema>;

/** The `routines` namespace over the core context. */
export function routinesApi(sdk: BotSdkContext) {
  return {
    /** One of the user's Bots' Routines, sorted by name, each with the Message its card follows. */
    list: async ({ userId, ...rest }: WithUser<typeof botScopeInput>) => {
      const { botId } = parseInput(botScopeInput, rest);
      await requireOwnedBot(sdk.db, userId, botId);
      return listRoutines(sdk.db, botId);
    },

    /** Approves a pending Routine: it turns `active`. Another user's is not found. */
    approve: async ({ userId, ...rest }: WithUser<typeof routineInput>) =>
      approveRoutine(sdk, userId, parseInput(routineInput, rest).routineId),

    /** Declines a pending Routine, which deletes it. Another user's is not found. */
    decline: async ({ userId, ...rest }: WithUser<typeof routineInput>) =>
      declineRoutine(sdk, userId, parseInput(routineInput, rest).routineId),

    /**
     * Pauses an active Routine: its queued fire is cancelled and its Triggers no Turn has taken yet
     * are dropped. Another user's is not found.
     */
    pause: async ({ userId, ...rest }: WithUser<typeof routineInput>) =>
      pauseRoutine(sdk, userId, parseInput(routineInput, rest).routineId),

    /** Resumes a paused Routine with no fresh OK: its next fire is queued. Another user's is not found. */
    resume: async ({ userId, ...rest }: WithUser<typeof routineInput>) =>
      resumeRoutine(sdk, userId, parseInput(routineInput, rest).routineId),

    /** Deletes a Routine in any state, and nothing of it fires again. Another user's is not found. */
    delete: async ({ userId, ...rest }: WithUser<typeof routineInput>) =>
      removeRoutine(sdk, userId, parseInput(routineInput, rest).routineId),

    /**
     * Gives an approved webhook Routine a new URL (ADR 0021): the new token comes back this once, and
     * the old URL answers 404 from then on. Another user's is not found.
     */
    rotate: async ({ userId, ...rest }: WithUser<typeof routineInput>) =>
      rotateWebhook(sdk, userId, parseInput(routineInput, rest).routineId),

    /**
     * A delivery to a webhook Routine's URL (ADR 0021), as a Host's own route receives it: `token`
     * is the URL's last segment, `body` the payload, and `headers` its `Idempotency-Key`, if any.
     * It needs no user: the token is the authentication. Returns `accepted` (the sender learns no
     * more), `notFound`, `payloadTooLarge` (over 64 KB) or `idempotencyKeyTooLong`; the HTTP
     * layer answers them 202, 404, 413 and 400.
     */
    receiveWebhook: (input: {
      token: string;
      body: string;
      headers?: Headers | Record<string, string>;
    }) => receiveRoutineWebhook(sdk, input),
  };
}

/** The `routines` namespace's domain methods. */
export type RoutinesApi = ReturnType<typeof routinesApi>;

/** The `checkIns` namespace over the core context. */
export function checkInsApi(sdk: BotSdkContext) {
  return {
    /** One of the user's Bots' Check-ins, soonest first, each with the Message its line follows. */
    list: async ({ userId, ...rest }: WithUser<typeof botScopeInput>) => {
      const { botId } = parseInput(botScopeInput, rest);
      await requireOwnedBot(sdk.db, userId, botId);
      return listCheckIns(sdk.db, botId);
    },

    /** Cancels a pending Check-in: it never fires. Another user's is not found. */
    cancel: async ({ userId, ...rest }: WithUser<typeof checkInInput>) =>
      cancelCheckIn(sdk, userId, parseInput(checkInInput, rest).checkInId),
  };
}

/** The `checkIns` namespace's domain methods. */
export type CheckInsApi = ReturnType<typeof checkInsApi>;

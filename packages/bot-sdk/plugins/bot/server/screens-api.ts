import { z } from "zod";

import type { BotSdkContext } from "../../../core/server/plugin";
import { parseInput } from "../../../core/server/rpc-error";
import { screenControl, screenView } from "./helpers";

/*
 * The Computer's Screen domain methods (spec #873), `sdk.computer` on the instance: the live view
 * of a Computer-use Helper's Screen (#597). Each takes one object with `userId`; the procedures are
 * one-line wrappers. Another user's Helper is not found.
 */

/** `computer.view`'s input, besides `userId`. */
export const screenViewInput = z.object({ helperId: z.uuid() });

/** `computer.control`'s input, besides `userId`. */
export const screenControlInput = z.object({
  helperId: z.uuid(),
  mode: z.enum(["view", "control"]),
});

type WithUser<Schema extends z.ZodType> = { userId: string } & z.input<Schema>;

/** The Screen methods over the core context. */
export function screensApi(sdk: BotSdkContext) {
  return {
    /**
     * A fresh live-view link to the Screen of one of the user's live Helpers, never stored. It wakes
     * the Computer and reopens the Screen when it isn't open, and the view starts view-only.
     * Refused, "This task was stopped.", once the Helper ended.
     */
    view: async ({ userId, ...rest }: WithUser<typeof screenViewInput>) =>
      screenView(sdk, userId, parseInput(screenViewInput, rest)),

    /** Take control (`control`) and give back (`view`): switches the Screen's x11vnc. */
    control: async ({ userId, ...rest }: WithUser<typeof screenControlInput>) => {
      const { helperId, mode } = parseInput(screenControlInput, rest);
      return screenControl(sdk, userId, helperId, mode);
    },
  };
}

/** The Computer's Screen domain methods. */
export type ScreensApi = ReturnType<typeof screensApi>;

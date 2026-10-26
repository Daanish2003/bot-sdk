import { z } from "zod";

import type { BotSdkContext } from "../../../core/server/plugin";
import { parseInput } from "../../../core/server/rpc-error";
import { deleteSkill, listSkills, readSkill, saveSkill, skillsAvailable } from "./manage";

/*
 * The `skills` namespace's domain methods (spec #873): what a Host calls in-process as
 * `sdk.skills`, with the user's id and no request. The procedures of `routers/index.ts` are
 * one-line wrappers that pass the signed-in user's id, validating with the same schemas.
 */

/** `skills.list`'s input, besides `userId`. */
export const listInput = z.object({ botId: z.uuid() });

/** The input of the methods that act on one Skill, besides `userId`. */
export const skillInput = z.object({ botId: z.uuid(), name: z.string() });

/** `skills.save`'s input, besides `userId`. */
export const saveInput = skillInput.extend({ content: z.string(), create: z.boolean().optional() });

type WithUser<Schema extends z.ZodType> = { userId: string } & z.input<Schema>;

/** The `skills` namespace over the core context. */
export function skillsApi(sdk: BotSdkContext) {
  return {
    /** Whether Bots can have Skills, which needs the `computer` plugin. Reads nothing. */
    status: () => ({ available: skillsAvailable(sdk) }),

    /** Bot `botId`'s Skills, waking the Computer. */
    list: async ({ userId, ...rest }: WithUser<typeof listInput>) =>
      listSkills(sdk, { userId, ...parseInput(listInput, rest) }),

    /** One Skill's raw SKILL.md. */
    read: async ({ userId, ...rest }: WithUser<typeof skillInput>) =>
      readSkill(sdk, { userId, ...parseInput(skillInput, rest) }),

    /** Saves a SKILL.md, creating or replacing it; the reply says why it is not usable, if so. */
    save: async ({ userId, ...rest }: WithUser<typeof saveInput>) =>
      saveSkill(sdk, { userId, ...parseInput(saveInput, rest) }),

    /** Deletes a Skill's whole folder. */
    remove: async ({ userId, ...rest }: WithUser<typeof skillInput>) => {
      await deleteSkill(sdk, { userId, ...parseInput(skillInput, rest) });
    },
  };
}

/** The `skills` feature's API (`sdk.skills`). */
export type SkillsApi = ReturnType<typeof skillsApi>;

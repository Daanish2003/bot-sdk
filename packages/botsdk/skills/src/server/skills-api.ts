import type { FeatureContext } from "@botsdk/bot/feature";

import { parseInput, type WithUser } from "@botsdk/bot/rpc-error";
import { deleteSkill, listSkills, readSkill, saveSkill, skillsAvailable } from "./manage";
import { listInput, saveInput, skillInput } from "../shared/contract";

/*
 * The `skills` namespace's domain methods (spec #873): what a Host calls in-process as
 * `sdk.skills`, with the user's id and no request. The HTTP layer serves the
 * feature's contract (`shared/contract.ts`) over them, passing the signed-in user's id.
 */

/** The `skills` namespace over the core context. */
export function skillsApi(sdk: FeatureContext<"computer">) {
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

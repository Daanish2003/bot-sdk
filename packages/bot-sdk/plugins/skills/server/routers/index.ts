import { z } from "zod";

import { protectedProcedure } from "../../../../core/server/procedures";
import { deleteSkill, listSkills, readSkill, saveSkill, skillsAvailable } from "../manage";

const skillInput = z.object({ botId: z.string(), name: z.string() });

/** The Skills procedures: a user's view of their Bots' Skills (spec #713). Only a Bot's own user may call them. */
export const skillsRouter = {
  /** Whether Bots can have Skills, which needs the `computer` plugin. Reads nothing. */
  status: protectedProcedure.handler(({ context }) => ({
    available: skillsAvailable(context.sdk),
  })),

  /** Bot `botId`'s Skills, waking the Computer. */
  list: protectedProcedure
    .input(z.object({ botId: z.string() }))
    .handler(({ context, input }) =>
      listSkills(context.sdk, { userId: context.user.id, ...input }),
    ),

  /** One Skill's raw SKILL.md. */
  read: protectedProcedure
    .input(skillInput)
    .handler(({ context, input }) => readSkill(context.sdk, { userId: context.user.id, ...input })),

  /** Saves a SKILL.md, creating or replacing it; the reply says why it is not usable, if so. */
  save: protectedProcedure
    .input(skillInput.extend({ content: z.string() }))
    .handler(({ context, input }) => saveSkill(context.sdk, { userId: context.user.id, ...input })),

  /** Deletes a Skill's whole folder. */
  remove: protectedProcedure.input(skillInput).handler(async ({ context, input }) => {
    await deleteSkill(context.sdk, { userId: context.user.id, ...input });
  }),
};

/** The `skills` plugin's routers, by key. */
export type SkillsRouter = { skills: typeof skillsRouter };

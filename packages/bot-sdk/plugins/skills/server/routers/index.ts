import { featureApi } from "../../../../core/server/feature";
import { protectedProcedure } from "../../../../core/server/procedures";
import { listInput, saveInput, skillInput, type SkillsApi } from "../skills-api";

/** The `skills` API (`sdk.skills`) the procedures call. */
const skills = (sdk: Parameters<typeof featureApi>[0]) => featureApi<SkillsApi>(sdk, "skills");

/** The Skills procedures: a user's view of their Bots' Skills (spec #713). Only a Bot's own user may call them. */
export const skillsRouter = {
  /** Whether Bots can have Skills, which needs the `computer` plugin. Reads nothing. */
  status: protectedProcedure.handler(({ context }) => skills(context.sdk).status()),

  /** Bot `botId`'s Skills, waking the Computer. */
  list: protectedProcedure
    .input(listInput)
    .handler(({ context, input }) =>
      skills(context.sdk).list({ userId: context.user.id, ...input }),
    ),

  /** One Skill's raw SKILL.md. */
  read: protectedProcedure
    .input(skillInput)
    .handler(({ context, input }) =>
      skills(context.sdk).read({ userId: context.user.id, ...input }),
    ),

  /** Saves a SKILL.md, creating or replacing it; the reply says why it is not usable, if so. */
  save: protectedProcedure
    .input(saveInput)
    .handler(({ context, input }) =>
      skills(context.sdk).save({ userId: context.user.id, ...input }),
    ),

  /** Deletes a Skill's whole folder. */
  remove: protectedProcedure
    .input(skillInput)
    .handler(({ context, input }) =>
      skills(context.sdk).remove({ userId: context.user.id, ...input }),
    ),
};

/** The `skills` plugin's routers, by key. */
export type SkillsRouter = { skills: typeof skillsRouter };

import type { BotSdkPlugin } from "../../../core/server/plugin";
import type { ComputerHandle } from "../../computer/server/plugin";
import { skillsRouter } from "./routers/index";
import { readBotSkills, type SkillLine, skillsPrompt } from "./skills";

/** The `skills` plugin's API (`sdk.plugin("skills")`): a Bot's Skills and its Skills block. */
export type SkillsApi = {
  /**
   * Bot `botId`'s Skills, read from its user's Computer, waking it: one line per Skill folder,
   * sorted by name, a broken one as `(not usable: <reason>)`. A Computer failure throws.
   */
  botSkills: (args: {
    botId: string;
    computer: ComputerHandle;
    signal?: AbortSignal;
  }) => Promise<SkillLine[]>;
  /** The Skills block of Bot `botId`'s Prompt start, listing `skills`. */
  prompt: (botId: string, skills: SkillLine[]) => string;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    skills: SkillsApi;
  }
}

export type SkillsPlugin = BotSdkPlugin<"skills", never, never>;

/**
 * The `skills` plugin (spec #713): each Bot's Skills, plain `SKILL.md` files in its folder on the
 * Computer, and the Skills block that points to them. It needs `computer`: without it, Bots have
 * no Skills. It doesn't follow the user's Memory switch.
 */
export function skills(): SkillsPlugin {
  return {
    id: "skills",
    uses: ["computer"],
    router: { skills: skillsRouter },
    init: () => ({
      api: {
        botSkills: ({ botId, computer, signal }) => readBotSkills(computer, botId, { signal }),
        prompt: skillsPrompt,
      } satisfies SkillsApi,
    }),
  };
}

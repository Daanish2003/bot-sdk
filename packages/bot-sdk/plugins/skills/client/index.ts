import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import type { SkillsRouter } from "../server/routers/index";

declare module "../../../core/client/plugin" {
  interface PluginRouters {
    skills: SkillsRouter;
  }
}

export type SkillsClientPlugin = BotSdkClientPlugin<"skills", SkillsRouter>;

/** The `skills` plugin's client: its router is `skills`. It adds no URLs. */
export function skillsClient(): SkillsClientPlugin {
  return { id: "skills" };
}

import { defineFeature } from "../../../core/server/feature";
import { skillChangeNotes } from "./changes";
import { skillsRouter } from "./routers/index";
import { readBotSkills, skillsPrompt } from "./skills";

/**
 * The `skills` feature (spec #713, #871): each Bot's Skills, plain `SKILL.md` files in its folder
 * on the Computer, and the Skills block that points to them. It needs the Computer: without one,
 * the factory throws. It doesn't follow the user's Memory switch. A Host turns it on with
 * `skills()` in `features`.
 */
export function skills() {
  return defineFeature({
    id: "skills",
    needs: ["computer"],
    demonstrations: true,
    router: { skills: skillsRouter },
    // Read once as a Turn starts: the section the Prompt start keeps, and what changed since.
    prompt: async (turn, { computer }) => {
      // A Computer that can't be read throws: the Turn goes on without a Skills section.
      const lines = await readBotSkills(computer.forUser(turn.userId), turn.botId, {
        signal: turn.signal,
      });
      return {
        section: skillsPrompt(turn.botId, lines),
        changeNotes: skillChangeNotes(turn.botId, turn.built, turn.earlier, lines),
      };
    },
  });
}

import { defineFeature } from "../../../core/server/feature";
import { isComputerFailure } from "../../computer/server/internal";
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
    prompt: async (turn, { computer, logger }) => {
      // A Computer that can't be woken or read leaves the Turn without a Skills section; any
      // other failure, or a Stop or the time limit, throws.
      let lines;
      try {
        lines = await readBotSkills(computer.forUser(turn.userId), turn.botId, {
          signal: turn.signal,
        });
      } catch (error) {
        if (turn.signal.aborted || !isComputerFailure(error)) throw error;
        logger.error(`Reading the Skills of Bot ${turn.botId} failed`, error);
        return null;
      }
      lines = lines.map(({ name, text }) => ({ name: turn.mask(name), text: turn.mask(text) }));
      return {
        section: skillsPrompt(turn.botId, lines),
        changeNotes: skillChangeNotes(turn.botId, turn.built, turn.earlier, lines),
      };
    },
  });
}

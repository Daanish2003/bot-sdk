import { defineFeature } from "../../../core/server/feature";
import { knowledgeNotes } from "./notes";
import { knowledgePrompt, readKnowledgePaths } from "./prompt";
import { knowledgeRouter } from "./routers/index";

/**
 * The `knowledge` feature (spec #737, ADR 0025, spec #871): a user's Knowledge as plain files in
 * `shared/knowledge/` on their Computer, with the routes that list, read, upload, delete and make
 * folders, and the Knowledge section every Bot of the user sees, with its Change notes. The Bot
 * reads and saves the files with its own file tools, so it adds no tools. It needs the Computer:
 * without one the Host's boot fails. It doesn't follow the user's Memory switch. A Host turns it on
 * with `knowledge()` in `features`.
 */
export function knowledge() {
  return defineFeature({
    id: "knowledge",
    needs: ["computer"],
    router: { knowledge: knowledgeRouter },
    // A Computer that can't be read throws: the Turn goes on without a Knowledge section.
    prompt: async (turn, { computer }) => {
      const paths = await readKnowledgePaths(computer.forUser(turn.userId), {
        signal: turn.signal,
      });
      return {
        section: knowledgePrompt(paths),
        changeNotes: knowledgeNotes(turn.botId, turn.built, turn.earlier, paths),
      };
    },
  });
}

import { defineFeature } from "@botsdk/bot/feature";
import { isComputerFailure } from "@botsdk/bot/computer/internal";
import { knowledgeApi } from "./knowledge-api";
import { knowledgeNotes } from "./notes";
import { knowledgePrompt, readKnowledgePaths } from "./prompt";
import { knowledgeContract } from "../shared/contract";

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
    contract: knowledgeContract,
    // The domain methods: `sdk.knowledge` (spec #873).
    api: (context) => knowledgeApi(context),
    // A Computer that can't be woken or read leaves the Turn without a Knowledge section; any
    // other failure, or a Stop or the time limit, throws.
    prompt: async (turn, { computer, logger }) => {
      let paths;
      try {
        paths = await readKnowledgePaths(computer.forUser(turn.userId), { signal: turn.signal });
      } catch (error) {
        if (turn.signal.aborted || !isComputerFailure(error)) throw error;
        logger.error(`Reading the Knowledge of user ${turn.userId} failed`, error);
        return null;
      }
      paths = paths.map(turn.mask);
      return {
        section: knowledgePrompt(paths),
        changeNotes: knowledgeNotes(turn.botId, turn.built, turn.earlier, paths),
      };
    },
  });
}

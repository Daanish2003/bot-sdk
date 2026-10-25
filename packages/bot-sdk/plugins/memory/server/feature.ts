import { toolDefinition } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { defineFeature } from "../../../core/server/feature";
import { botMemoryPassJob, enqueueBotMemoryPass } from "./bot-pass";
import { botMemorySnapshot, botsOf, exportBotMemory, memoryDirectory } from "./bot-memory";
import { memoryChangeNotes } from "./change-notes";
import { memorySettings } from "./db/settings";
import { memoryEnabledFor } from "./manage";
import { memoryRouter } from "./routers/index";
import { searchBotMemory } from "./search";

/** The tool that searches the Bot's memory files (ADR 0022). */
export const searchMemoryToolName = "search_memory";

const searchMemoryDefinition = toolDefinition({
  name: searchMemoryToolName,
  description:
    "Search your memory: your Profile, every Log month and your Notes, and all the Bots' " +
    "Profiles. Returns the 10 best matching lines with file and date. Use it for what the " +
    "memory in your prompt doesn't hold.",
  inputSchema: z.object({
    query: z.string().min(1).meta({ description: "What to look for in your memory" }),
  }),
});

/**
 * The Memory feature (ADR 0022): the Bots' file memory, its post-Turn pass, the Memory routers and
 * the user's Memory switch. A Host turns Memory on with `memory()` in `features`; it needs the
 * Computer, where the files live.
 */
export function memory() {
  return defineFeature({
    id: "memory",
    needs: ["computer"],
    schema: { memorySettings },
    api: (context) => ({
      /** The user's Memory switch: on for a user who never saved it. */
      isEnabled: (userId: string) => memoryEnabledFor(context, userId),
    }),
    // Sent on every call, by name (`isDirectTool`), only with the user's Memory on.
    tools: async (turn, context, kit) => {
      // Read once and recorded, so a replay lists what its attempt did, even if the switch moved.
      const enabled = () => memoryEnabledFor(context, turn.userId);
      if (!(await (kit ? kit.record(enabled) : enabled()))) return [];
      // Reads through the Computer like the snapshot: no snapshot this Turn, no search.
      if (kit && kit.section === null) return [];
      const search = searchMemoryDefinition.server(async ({ query }, options) => {
        // Only a Turn's tool list is called; a list read for its definitions never runs a tool.
        if (!kit) throw new Error("search_memory was called without a Turn");
        return kit.computerCall(
          searchMemoryToolName,
          options?.toolCallId,
          async (computer, live) => ({
            results: await searchBotMemory(computer, {
              botId: turn.botId,
              bots: await botsOf(context, turn.userId),
              query,
              now: context.clock(),
              signal: live.signal,
            }),
          }),
        );
      });
      return { tools: [search], computerTools: [searchMemoryToolName] };
    },
    // The memory block as a Turn starts, from the user's Computer; none with Memory off or when
    // the Computer can't be read, and the Turn goes on without it.
    prompt: async (turn, context) => {
      const off = { section: null, environment: "Memory: off." };
      if (!(await memoryEnabledFor(context, turn.userId))) return off;
      let block: string | null;
      try {
        block = await botMemorySnapshot(context, {
          userId: turn.userId,
          botId: turn.botId,
          now: turn.startedAt,
          computer: context.computer.forUser(turn.userId),
          signal: turn.signal,
        });
      } catch (error) {
        // A Stop or the time limit ends the Turn; it does not leave it without a memory block.
        turn.signal.throwIfAborted();
        context.logger.error(`Reading the memory of Bot ${turn.botId} failed`, error);
        return off;
      }
      if (block === null) return off;
      return {
        section: block,
        changeNotes: memoryChangeNotes(turn.botId, turn.built, turn.earlier, block),
        environment: `Memory: on. Your memory files are in ${memoryDirectory(turn.botId)}.`,
      };
    },
    afterTurn: (tx, turn, context) => enqueueBotMemoryPass(context, tx, turn.id),
    jobs: [botMemoryPassJob],
    userData: {
      delete: {
        before: async (tx, userId) => {
          await tx.delete(memorySettings).where(eq(memorySettings.userId, userId));
        },
      },
      export: async (tx, userId, context) => ({
        memoryEnabled: await memoryEnabledFor({ db: tx }, userId),
        botMemory: await exportBotMemory(context, tx, userId),
      }),
    },
    router: { memory: memoryRouter },
  });
}

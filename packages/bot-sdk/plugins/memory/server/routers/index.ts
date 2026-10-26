import { featureApi } from "../../../../core/server/feature";
import { protectedProcedure } from "../../../../core/server/procedures";
import {
  botAddLineInput,
  botDeleteLineInput,
  botEditLineInput,
  botListInput,
  botReadFileInput,
  botSaveFileInput,
  setEnabledInput,
  type MemoryApi,
} from "../memory-api";

/** The `memory` API (`sdk.memory`) the procedures call. */
const memory = (sdk: Parameters<typeof featureApi>[0]) => featureApi<MemoryApi>(sdk, "memory");

/** The Memory procedures: the switch and the Bots' memory files (ADR 0022). A Host without the `memory` plugin has none, and the page is hidden. */
export const memoryRouter = {
  /** The user's switch, and whether Bots can have memory. */
  status: protectedProcedure.handler(({ context }) =>
    memory(context.sdk).status({ userId: context.user.id }),
  ),

  /** Bot `botId`'s memory lines by tier, each with whether its Turn holds it now (ADR 0022). */
  botList: protectedProcedure
    .input(botListInput)
    .handler(({ context, input }) =>
      memory(context.sdk).botList({ userId: context.user.id, ...input }),
    ),

  /** Changes one line of a file of the user's Bots; refused when it no longer reads `current`. */
  botEditLine: protectedProcedure
    .input(botEditLineInput)
    .handler(({ context, input }) =>
      memory(context.sdk).botEditLine({ userId: context.user.id, ...input }),
    ),

  /** Deletes one line of a file of the user's Bots; refused when it no longer reads `current`. */
  botDeleteLine: protectedProcedure
    .input(botDeleteLineInput)
    .handler(({ context, input }) =>
      memory(context.sdk).botDeleteLine({ userId: context.user.id, ...input }),
    ),

  /** Adds a line to a Bot's Profile, to this month's Log or to its Notes. */
  botAddLine: protectedProcedure
    .input(botAddLineInput)
    .handler(({ context, input }) =>
      memory(context.sdk).botAddLine({ userId: context.user.id, ...input }),
    ),

  /** A Bot memory file's raw text. */
  botReadFile: protectedProcedure
    .input(botReadFileInput)
    .handler(({ context, input }) =>
      memory(context.sdk).botReadFile({ userId: context.user.id, ...input }),
    ),

  /** Saves a Bot memory file whole; refused when it no longer reads `expected`. */
  botSaveFile: protectedProcedure
    .input(botSaveFileInput)
    .handler(({ context, input }) =>
      memory(context.sdk).botSaveFile({ userId: context.user.id, ...input }),
    ),

  /** Turns the "Use and make Memories" switch on or off. */
  setEnabled: protectedProcedure
    .input(setEnabledInput)
    .handler(({ context, input }) =>
      memory(context.sdk).setEnabled({ userId: context.user.id, ...input }),
    ),
};

/** The `memory` plugin's routers, by key. */
export type MemoryRouter = { memory: typeof memoryRouter };

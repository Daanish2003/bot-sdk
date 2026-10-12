import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../procedures";
import { decodeCursor, searchMessages } from "../search/query";
import { minSearchLength } from "../../shared/search/text";

export const searchRouter = {
  /**
   * The caller's Messages containing `q` (2+ characters, case-insensitive), on every Branch,
   * newest first, in pages of 50. Pass the previous page's `nextCursor` for the next one.
   * Optional filters combine with AND: `model` and `provider` match the Model that wrote an
   * assistant Message; `from` (inclusive) and `to` (exclusive) are ISO instants on the Message's date;
   * `projectId` keeps only the Messages of that Project's Conversations (another user's Project matches nothing).
   */
  query: protectedProcedure
    .input(
      z.object({
        q: z.string().trim().min(minSearchLength).max(200),
        cursor: z.string().optional(),
        model: z.string().max(200).optional(),
        provider: z.string().max(200).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        projectId: z.uuid().optional(),
      }),
    )
    .handler(({ context, input }) => {
      const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
      if (input.cursor !== undefined && !cursor) {
        throw new ORPCError("BAD_REQUEST", { message: "Invalid cursor" });
      }
      return searchMessages(context.deps, context.user.id, input.q, cursor, {
        model: input.model,
        provider: input.provider,
        from: input.from === undefined ? undefined : new Date(input.from),
        to: input.to === undefined ? undefined : new Date(input.to),
        projectId: input.projectId,
      });
    }),
};

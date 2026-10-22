import { z } from "zod";

import { knowledgeLimitBytes } from "../../shared/folder";
import { protectedProcedure } from "../../../../core/server/procedures";
import {
  createKnowledgeFolder,
  deleteKnowledge,
  knowledgeAvailable,
  listKnowledge,
  readKnowledge,
  uploadKnowledge,
  uploadKnowledgeDocument,
} from "../files";

const pathInput = z.object({ path: z.string() });

/** The Knowledge procedures: a user's view of their shared Knowledge folder (spec #737). */
export const knowledgeRouter = {
  /** Whether the user can have Knowledge, which needs the `computer` plugin. Reads nothing. */
  status: protectedProcedure.handler(({ context }) => ({
    available: knowledgeAvailable(context.sdk),
  })),

  /** The tree with sizes, who saved each file, and the usage, waking the Computer. */
  list: protectedProcedure.handler(({ context }) =>
    listKnowledge(context.sdk, { userId: context.user.id }),
  ),

  /** One file's text. */
  read: protectedProcedure
    .input(pathInput)
    .handler(({ context, input }) =>
      readKnowledge(context.sdk, { userId: context.user.id, ...input }),
    ),

  /** Adds a text file to a folder; the same name there is refused unless `replace` is set. */
  upload: protectedProcedure
    .input(
      z.object({
        folder: z.string().optional(),
        name: z.string(),
        content: z.string().max(knowledgeLimitBytes),
        replace: z.boolean().optional(),
      }),
    )
    .handler(({ context, input }) =>
      uploadKnowledge(context.sdk, { userId: context.user.id, ...input }),
    ),

  /** Converts a PDF or DOCX and adds it with its readable copy; the same name is refused unless `replace` is set. */
  uploadDocument: protectedProcedure
    .input(
      z.object({ folder: z.string().optional(), file: z.file(), replace: z.boolean().optional() }),
    )
    .handler(({ context, input }) =>
      uploadKnowledgeDocument(context.sdk, { userId: context.user.id, ...input }),
    ),

  /** Deletes a file (a PDF or DOCX goes with its readable copy). */
  remove: protectedProcedure.input(pathInput).handler(async ({ context, input }) => {
    await deleteKnowledge(context.sdk, { userId: context.user.id, ...input });
  }),

  /** Creates a folder. */
  createFolder: protectedProcedure.input(pathInput).handler(async ({ context, input }) => {
    await createKnowledgeFolder(context.sdk, { userId: context.user.id, ...input });
  }),
};

/** The `knowledge` plugin's routers, by key. */
export type KnowledgeRouter = { knowledgeFiles: typeof knowledgeRouter };

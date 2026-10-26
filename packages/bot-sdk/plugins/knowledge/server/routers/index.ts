import { featureApi } from "../../../../core/server/feature";
import { protectedProcedure } from "../../../../core/server/procedures";
import { pathInput, uploadDocumentInput, uploadInput, type KnowledgeApi } from "../knowledge-api";

/** The `knowledge` API (`sdk.knowledge`) the procedures call. */
const knowledge = (sdk: Parameters<typeof featureApi>[0]) =>
  featureApi<KnowledgeApi>(sdk, "knowledge");

/** The Knowledge procedures: a user's view of their shared Knowledge folder (spec #737). */
export const knowledgeRouter = {
  /** Whether the user can have Knowledge, which needs the computer slot. Reads nothing. */
  status: protectedProcedure.handler(({ context }) => knowledge(context.sdk).status()),

  /** The tree with sizes, who saved each file, and the usage, waking the Computer. */
  list: protectedProcedure.handler(({ context }) =>
    knowledge(context.sdk).list({ userId: context.user.id }),
  ),

  /** One file's text. */
  read: protectedProcedure
    .input(pathInput)
    .handler(({ context, input }) =>
      knowledge(context.sdk).read({ userId: context.user.id, ...input }),
    ),

  /** Adds a text file to a folder; the same name there is refused unless `replace` is set. */
  upload: protectedProcedure
    .input(uploadInput)
    .handler(({ context, input }) =>
      knowledge(context.sdk).upload({ userId: context.user.id, ...input }),
    ),

  /** Converts a PDF or DOCX and adds it with its readable copy; the same name is refused unless `replace` is set. */
  uploadDocument: protectedProcedure
    .input(uploadDocumentInput)
    .handler(({ context, input }) =>
      knowledge(context.sdk).uploadDocument({ userId: context.user.id, ...input }),
    ),

  /** Deletes a file (a PDF or DOCX goes with its readable copy). */
  remove: protectedProcedure
    .input(pathInput)
    .handler(({ context, input }) =>
      knowledge(context.sdk).remove({ userId: context.user.id, ...input }),
    ),

  /** Creates a folder. */
  createFolder: protectedProcedure
    .input(pathInput)
    .handler(({ context, input }) =>
      knowledge(context.sdk).createFolder({ userId: context.user.id, ...input }),
    ),
};

/** The `knowledge` plugin's routers, by key. */
export type KnowledgeRouter = { knowledge: typeof knowledgeRouter };

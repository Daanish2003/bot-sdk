import { z } from "zod";

import type { BotSdkContext } from "../../../core/server/plugin";
import { parseInput } from "../../../core/server/rpc-error";
import { knowledgeLimitBytes } from "../shared/folder";
import {
  createKnowledgeFolder,
  deleteKnowledge,
  knowledgeAvailable,
  listKnowledge,
  readKnowledge,
  uploadKnowledge,
  uploadKnowledgeDocument,
} from "./files";

/*
 * The `knowledge` namespace's domain methods (spec #873): what a Host calls in-process as
 * `sdk.knowledge`, with the user's id and no request. The procedures of `routers/index.ts` are
 * one-line wrappers that pass the signed-in user's id, validating with the same schemas.
 */

/** The input of the methods that act on one path, besides `userId`. */
export const pathInput = z.object({ path: z.string() });

/** `knowledge.upload`'s input, besides `userId`. */
export const uploadInput = z.object({
  folder: z.string().optional(),
  name: z.string(),
  content: z.string().max(knowledgeLimitBytes),
  replace: z.boolean().optional(),
});

/** `knowledge.uploadDocument`'s input, besides `userId`. */
export const uploadDocumentInput = z.object({
  folder: z.string().optional(),
  file: z.file(),
  replace: z.boolean().optional(),
});

type WithUser<Schema extends z.ZodType> = { userId: string } & z.input<Schema>;

/** The `knowledge` namespace over the core context. */
export function knowledgeApi(sdk: BotSdkContext) {
  return {
    /** Whether the user can have Knowledge, which needs the computer slot. Reads nothing. */
    status: () => ({ available: knowledgeAvailable(sdk) }),

    /** The tree with sizes, who saved each file, and the usage, waking the Computer. */
    list: async ({ userId }: { userId: string }) => listKnowledge(sdk, { userId }),

    /** One file's text. */
    read: async ({ userId, ...rest }: WithUser<typeof pathInput>) =>
      readKnowledge(sdk, { userId, ...parseInput(pathInput, rest) }),

    /** Adds a text file to a folder; the same name there is refused unless `replace` is set. */
    upload: async ({ userId, ...rest }: WithUser<typeof uploadInput>) =>
      uploadKnowledge(sdk, { userId, ...parseInput(uploadInput, rest) }),

    /** Converts a PDF or DOCX and adds it with its readable copy; the same name is refused unless `replace` is set. */
    uploadDocument: async ({ userId, ...rest }: WithUser<typeof uploadDocumentInput>) =>
      uploadKnowledgeDocument(sdk, { userId, ...parseInput(uploadDocumentInput, rest) }),

    /** Deletes a file (a PDF or DOCX goes with its readable copy). */
    remove: async ({ userId, ...rest }: WithUser<typeof pathInput>) => {
      await deleteKnowledge(sdk, { userId, ...parseInput(pathInput, rest) });
    },

    /** Creates a folder. */
    createFolder: async ({ userId, ...rest }: WithUser<typeof pathInput>) => {
      await createKnowledgeFolder(sdk, { userId, ...parseInput(pathInput, rest) });
    },
  };
}

/** The `knowledge` feature's API (`sdk.knowledge`). */
export type KnowledgeApi = ReturnType<typeof knowledgeApi>;

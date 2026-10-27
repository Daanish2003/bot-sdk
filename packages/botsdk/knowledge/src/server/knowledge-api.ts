import type { FeatureContext } from "@botsdk/bot/feature";
import { parseInput, type WithUser } from "@botsdk/bot/rpc-error";
import { pathInput, uploadDocumentInput, uploadInput } from "../shared/contract";
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
 * `sdk.knowledge`, with the user's id and no request. The HTTP layer serves the
 * feature's contract (`shared/contract.ts`) over them, passing the signed-in user's id.
 */

/** The `knowledge` namespace over the core context. */
export function knowledgeApi(sdk: FeatureContext<"computer">) {
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

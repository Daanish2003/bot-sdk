import { z } from "zod";

import { knowledgeMediaType, maxKnowledgeFileBytes } from "../../shared/knowledge/kinds";
import { knowledgeOf, setKnowledgeModel, uploadKnowledgeFile } from "../knowledge/store";
import { protectedProcedure } from "../procedures";
import { rpcError } from "../rpc-error";

const maxMegabytes = maxKnowledgeFileBytes / (1024 * 1024);

export const knowledgeRouter = {
  /**
   * A Project's Knowledge: its embedding Model (stored, or the default before the first upload),
   * the embedding Models the user can use now, and its files, newest first.
   */
  list: protectedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .handler(async ({ context, input }) => {
      const knowledge = await knowledgeOf(context.deps, context.user.id, input.projectId);
      if (!knowledge) throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
      return knowledge;
    }),

  /**
   * Adds a Markdown or plain text file to a Project's Knowledge (ADR 0014): up to 20 MB, UTF-8,
   * and at most 100 files per Project. Its passages are made in the background.
   */
  upload: protectedProcedure
    .input(z.object({ projectId: z.uuid(), file: z.file() }))
    .handler(async ({ context, input: { projectId, file } }) => {
      if (file.size > maxKnowledgeFileBytes) {
        throw rpcError(
          "BAD_REQUEST",
          "error.knowledgeFileTooLarge",
          `"${file.name}" is larger than ${maxMegabytes} MB`,
          { name: file.name, max: maxMegabytes },
        );
      }
      const mediaType = knowledgeMediaType(file.type, file.name);
      if (!mediaType) {
        throw rpcError(
          "BAD_REQUEST",
          "error.knowledgeFileNotSupported",
          `"${file.name}" can't be a Knowledge file: only Markdown and text files can`,
          { name: file.name },
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isUtf8(bytes)) {
        throw rpcError(
          "BAD_REQUEST",
          "error.knowledgeFileNotUtf8",
          `"${file.name}" isn't a UTF-8 text file`,
          { name: file.name },
        );
      }
      return uploadKnowledgeFile(context.deps, context.user.id, projectId, {
        name: file.name,
        mediaType,
        bytes,
      });
    }),

  /** Sets the Project's embedding Model; refused once the Project has files. */
  setModel: protectedProcedure
    .input(z.object({ projectId: z.uuid(), model: z.string().min(1) }))
    .handler(async ({ context, input }) => {
      await setKnowledgeModel(context.deps, context.user.id, input.projectId, input.model);
    }),
};

function isUtf8(bytes: Uint8Array) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

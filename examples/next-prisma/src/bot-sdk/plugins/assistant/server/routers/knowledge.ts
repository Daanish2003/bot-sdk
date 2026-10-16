import { z } from "zod";

import {
  knowledgeFileExtensions,
  knowledgeMediaType,
  maxKnowledgeFileBytes,
} from "../../shared/knowledge/kinds";
import {
  deleteKnowledgeFile,
  knowledgeOf,
  retryKnowledgeFile,
  setKnowledgeModel,
  uploadKnowledgeFile,
} from "../knowledge/store";
import { protectedProcedure } from "../../../../core/server/procedures";
import { rpcError } from "../../../../core/server/rpc-error";

const maxMegabytes = maxKnowledgeFileBytes / (1024 * 1024);

export const knowledgeRouter = {
  /**
   * A Project's Knowledge: its embedding Model (stored, or the default before the first upload),
   * the embedding Models the user can use now, and its files, newest first.
   */
  list: protectedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .handler(async ({ context, input }) => {
      const knowledge = await knowledgeOf(context.sdk, context.user.id, input.projectId);
      if (!knowledge) throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
      return knowledge;
    }),

  /**
   * Adds a Knowledge file to a Project's Knowledge (ADR 0014): up to 20 MB, of a supported format,
   * and at most 100 files per Project. Text formats must be UTF-8. Its passages are made in the
   * background.
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
          `"${file.name}" can't be a Knowledge file: only ${knowledgeFileExtensions.join(", ")} files can`,
          { name: file.name, types: knowledgeFileExtensions.join(", ") },
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mediaType.startsWith("text/") && !isUtf8(bytes)) {
        throw rpcError(
          "BAD_REQUEST",
          "error.knowledgeFileNotUtf8",
          `"${file.name}" isn't a UTF-8 text file`,
          { name: file.name },
        );
      }
      return uploadKnowledgeFile(context.sdk, context.user.id, projectId, {
        name: file.name,
        mediaType,
        bytes,
      });
    }),

  /** Queues a Failed file's processing again, from its kept original. */
  retry: protectedProcedure
    .input(z.object({ projectId: z.uuid(), fileId: z.uuid() }))
    .handler(async ({ context, input }) => {
      await retryKnowledgeFile(context.sdk, context.user.id, input.projectId, input.fileId);
    }),

  /** Deletes a Knowledge file, its passages and its bytes, whatever its status. */
  delete: protectedProcedure
    .input(z.object({ projectId: z.uuid(), fileId: z.uuid() }))
    .handler(async ({ context, input }) => {
      await deleteKnowledgeFile(context.sdk, context.user.id, input.projectId, input.fileId);
    }),

  /** Sets the Project's embedding Model; refused once the Project has files. */
  setModel: protectedProcedure
    .input(z.object({ projectId: z.uuid(), model: z.string().min(1) }))
    .handler(async ({ context, input }) => {
      await setKnowledgeModel(context.sdk, context.user.id, input.projectId, input.model);
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

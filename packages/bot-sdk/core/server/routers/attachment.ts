import { z } from "zod";

import {
  attachmentKind,
  maxAttachmentBytes,
  normalizedMediaType,
} from "../../shared/attachments/kinds";
import { saveAttachment } from "../attachments/store";
import { protectedProcedure } from "../procedures";
import { rpcError } from "../rpc-error";

export const attachmentRouter = {
  /**
   * Stores a file to attach to a later Message; the chat command sends its id. Only images
   * (JPEG/PNG/GIF/WebP), PDFs and UTF-8 text files up to 5 MB.
   */
  upload: protectedProcedure
    .input(z.object({ file: z.file() }))
    .handler(async ({ context, input: { file } }) => {
      if (file.size > maxAttachmentBytes) {
        throw rpcError(
          "BAD_REQUEST",
          "error.attachmentTooLarge",
          `"${file.name}" is larger than 5 MB`,
          {
            name: file.name,
          },
        );
      }
      const kind = attachmentKind(file.type, file.name);
      if (!kind) {
        throw rpcError(
          "BAD_REQUEST",
          "error.attachmentNotSupported",
          `"${file.name}" can't be attached: only images, PDFs and text files can`,
          { name: file.name },
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (kind === "text" && !isUtf8(bytes)) {
        throw rpcError(
          "BAD_REQUEST",
          "error.attachmentNotUtf8",
          `"${file.name}" isn't a UTF-8 text file`,
          {
            name: file.name,
          },
        );
      }
      return saveAttachment(context.deps, context.user.id, {
        filename: file.name,
        mediaType: normalizedMediaType(file.type, file.name),
        bytes,
      });
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

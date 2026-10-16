import type { MessageRow } from "../db/schema";

import type { StoredAttachment } from "../../shared/chat/parts";
import type { CuratedModel } from "../../shared/chat/models";
import type { AppDeps } from "../deps";
import {
  acceptedKinds,
  attachmentKind,
  maxAttachmentBytes,
  maxBranchAttachmentBytes,
} from "../../shared/attachments/kinds";
import type { ErrorCode } from "../../shared/i18n";
import type { ErrorParams } from "../rpc-error";
import { attachmentsOfMessages, findOwnedAttachments, loadAttachmentBytes } from "./store";

type Deps = Pick<AppDeps, "db" | "blobStore">;

export type SendAttachments =
  | { error: { status: number; code: ErrorCode; params: ErrorParams } }
  | {
      error: null;
      /** The new Message's attachments, with their bytes. */
      added: StoredAttachment[];
      /** Each history Message's attachments, with their bytes; none for most. */
      ofHistory: (row: MessageRow) => StoredAttachment[];
    };

/**
 * Checks a send's `attachmentIds` and loads what the Provider needs: the user must own every
 * attachment, the Model must read its type, each file stays within 5 MB, and the Active Branch
 * (history plus the new files) within 20 MB.
 */
export async function attachmentsForSend(
  deps: Deps,
  {
    userId,
    model,
    attachmentIds,
    history,
  }: { userId: string; model: CuratedModel; attachmentIds: string[]; history: MessageRow[] },
): Promise<SendAttachments> {
  const added = await findOwnedAttachments(deps, userId, attachmentIds);
  if (added.length !== attachmentIds.length) {
    return { error: { status: 404, code: "error.attachmentNotFound", params: {} } };
  }
  const accepted = acceptedKinds(model);
  for (const file of added) {
    const kind = attachmentKind(file.mediaType, file.filename);
    if (!kind) {
      return {
        error: {
          status: 400,
          code: "error.attachmentNotSupported",
          params: { name: file.filename },
        },
      };
    }
    if (!accepted.includes(kind)) {
      return {
        error: { status: 400, code: "error.modelCantRead", params: { model: model.label, kind } },
      };
    }
    if (file.size > maxAttachmentBytes) {
      return {
        error: { status: 400, code: "error.attachmentTooLarge", params: { name: file.filename } },
      };
    }
  }

  const byMessage = await attachmentsOfMessages(
    deps,
    history.map((row) => row.id),
  );
  const onBranch = [...[...byMessage.values()].flat(), ...added];
  const branchBytes = onBranch.reduce((total, file) => total + file.size, 0);
  if (branchBytes > maxBranchAttachmentBytes) {
    return { error: { status: 400, code: "error.branchAttachmentsTooLarge", params: {} } };
  }

  const bytes = await loadAttachmentBytes(
    deps,
    onBranch.map((file) => file.id),
  );
  const withBytes = (files: typeof added): StoredAttachment[] =>
    files.map(({ id, filename, mediaType }) => {
      const stored = bytes.get(id);
      if (!stored) throw new Error(`Attachment ${id} has no bytes`);
      return { id, filename, mediaType, bytes: stored };
    });
  return {
    error: null,
    added: withBytes(added),
    ofHistory: (row) => withBytes(byMessage.get(row.id) ?? []),
  };
}

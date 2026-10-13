import type { MessageRow } from "../db/schema/chat";

import type { StoredAttachment } from "../../shared/chat/parts";
import type { CuratedModel } from "../../shared/chat/models";
import type { AppDeps } from "../deps";
import {
  acceptedKinds,
  attachmentKind,
  kindLabelPlural,
  maxAttachmentBytes,
  maxBranchAttachmentBytes,
} from "../../shared/attachments/kinds";
import { attachmentsOfMessages, findOwnedAttachments, loadAttachmentBytes } from "./store";

type Deps = Pick<AppDeps, "db" | "blobStore">;

export type SendAttachments =
  | { error: { status: number; message: string } }
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
    return { error: { status: 404, message: "Attachment not found" } };
  }
  const accepted = acceptedKinds(model);
  for (const file of added) {
    const kind = attachmentKind(file.mediaType, file.filename);
    if (!kind || !accepted.includes(kind)) {
      const what = kind ? kindLabelPlural(kind) : `"${file.filename}"`;
      return { error: { status: 400, message: `${model.label} can't read ${what}` } };
    }
    if (file.size > maxAttachmentBytes) {
      return { error: { status: 400, message: `"${file.filename}" is larger than 5 MB` } };
    }
  }

  const byMessage = await attachmentsOfMessages(
    deps,
    history.map((row) => row.id),
  );
  const onBranch = [...[...byMessage.values()].flat(), ...added];
  const branchBytes = onBranch.reduce((total, file) => total + file.size, 0);
  if (branchBytes > maxBranchAttachmentBytes) {
    return { error: { status: 400, message: "Attachments on this Branch would pass 20 MB" } };
  }

  const bytes = await loadAttachmentBytes(
    deps,
    onBranch.map((file) => file.id),
  );
  const withBytes = (files: typeof added): StoredAttachment[] =>
    files.map(({ id, filename, mediaType }) => {
      const stored = bytes.get(id);
      if (!stored) throw new Error(`Attachment ${id} has no bytes`);
      return { filename, mediaType, bytes: stored };
    });
  return {
    error: null,
    added: withBytes(added),
    ofHistory: (row) => withBytes(byMessage.get(row.id) ?? []),
  };
}

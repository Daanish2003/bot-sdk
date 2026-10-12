import type { AttachmentInfo } from "../attachments/kinds";
import type { MessageRecord } from "./message-record";
import type { SiblingPosition } from "./branches";
import { parseStoredParts, toUIParts } from "./parts";

/** A Message as the client sees it, with `useChat` parts. */
export function toClientMessage(row: MessageRecord, attachments: AttachmentInfo[] = []) {
  return {
    id: row.id,
    parentId: row.parentId,
    role: row.role,
    parts: toUIParts(parseStoredParts(row.parts)),
    /** The files the Message carries, as chips: never their bytes. */
    attachments,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    status: row.status,
    error: row.error,
    errorReason: row.errorReason,
    usage: row.usage,
    contextStartId: row.contextStartId,
    createdAt: row.createdAt,
  };
}

export type ClientMessage = ReturnType<typeof toClientMessage>;

/** A Message of the Active Branch as `conversation.get` returns it, with its ‹ n/m › position. */
export type ActiveBranchMessage = ClientMessage & { siblings: SiblingPosition };

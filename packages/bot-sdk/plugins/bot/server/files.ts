import { and, eq, inArray, sql } from "drizzle-orm";
import { posix } from "node:path";
import { z } from "zod";

import { conversation, message } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import type { ComputerHandle } from "../../computer/server/plugin";
import { maxFileBytes, maxFilesPerMessage, type SentFile } from "../shared/files";
import { resolvePath } from "./computer-tools";
import { botKind, controlOf } from "./store";

/** The blob key of a file the Bot sent. */
export const sentFileBlobKey = (fileId: string) => `bot-file/${fileId}`;

const mediaTypes: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

const mediaTypeOf = (name: string) =>
  mediaTypes[posix.extname(name).toLowerCase()] ?? "application/octet-stream";

/**
 * Copies the files at `paths` on the Computer to the blob store, for a `files` control: all are read
 * first, so a missing path, a directory, an empty list or a file over `maxFileBytes` is an error
 * and stores nothing.
 */
export async function copyFilesToStorage(
  deps: Pick<BotSdkContext, "blobStore">,
  computer: ComputerHandle,
  botId: string,
  paths: string[],
  options: { signal?: AbortSignal } = {},
): Promise<{ files: SentFile[] } | { error: string }> {
  if (paths.length > maxFilesPerMessage)
    return { error: `At most ${maxFilesPerMessage} files fit in one message.` };
  const read: { name: string; bytes: Uint8Array }[] = [];
  for (const given of paths) {
    const path = resolvePath(botId, given);
    let bytes: Uint8Array | null;
    try {
      bytes = await computer.readFile(path, options);
    } catch {
      return { error: `${path} is not a file on your computer, so the message was not sent.` };
    }
    if (!bytes) return { error: `${path} does not exist, so the message was not sent.` };
    if (bytes.byteLength > maxFileBytes) {
      return {
        error: `${path} is over ${maxFileBytes / 1024 / 1024} MB, so the message was not sent.`,
      };
    }
    read.push({ name: posix.basename(path), bytes });
  }
  const files: SentFile[] = [];
  for (const { name, bytes } of read) {
    const file = { id: uuidv7(), name, size: bytes.byteLength, mediaType: mediaTypeOf(name) };
    await deps.blobStore.put(sentFileBlobKey(file.id), bytes, { contentType: file.mediaType });
    files.push(file);
  }
  return { files };
}

/**
 * One file the Bot sent the user, its bytes from the blob store, always as a download. Another
 * user's file, an unknown id or an id that isn't one is 404.
 */
export async function sentFileResponse(
  deps: BotSdkContext,
  userId: string,
  id: string,
): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404 });
  if (!z.uuid().safeParse(id).success) return notFound();
  const holding = JSON.stringify({
    parts: [{ type: "control", control: { kind: "files", files: [{ id }] } }],
  });
  const [row] = await deps.db
    .select({ parts: message.parts })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(
      and(
        eq(conversation.userId, userId),
        eq(conversation.kind, botKind),
        sql`${message.parts} @> ${holding}::jsonb`,
      ),
    )
    .limit(1);
  const file = row && controlOf(row.parts, "files")?.files.find((sent) => sent.id === id);
  const bytes = file ? await deps.blobStore.get(sentFileBlobKey(id)) : null;
  if (!file || !bytes) return notFound();
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": file.mediaType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The blob keys of every file sent in Conversations `conversationIds`, read before they are deleted. */
export async function sentFileKeys(tx: Transaction, conversationIds: string[]): Promise<string[]> {
  const rows = await tx
    .select({ parts: message.parts })
    .from(message)
    .where(
      and(
        inArray(message.conversationId, conversationIds),
        sql`${message.parts} @> '{"parts":[{"type":"control","control":{"kind":"files"}}]}'::jsonb`,
      ),
    );
  return rows.flatMap((row) =>
    (controlOf(row.parts, "files")?.files ?? []).map((file) => sentFileBlobKey(file.id)),
  );
}

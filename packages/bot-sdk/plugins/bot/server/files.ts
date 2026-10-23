import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { posix } from "node:path";
import { z } from "zod";

import { deleteBlobsBestEffort } from "../../../core/server/blob/store";
import { botUpload, conversation, message } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import type { ComputerHandle } from "../../computer/server/plugin";
import { maxFileBytes, maxFilesPerMessage, type SentFile } from "../shared/files";
import { botDirectory, resolvePath } from "./computer-tools";
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
  deps: Pick<BotSdkContext, "blobStore" | "logger">,
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
      options.signal?.throwIfAborted();
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
  try {
    for (const { name, bytes } of read) {
      const file = { id: uuidv7(), name, size: bytes.byteLength, mediaType: mediaTypeOf(name) };
      await deps.blobStore.put(sentFileBlobKey(file.id), bytes, { contentType: file.mediaType });
      files.push(file);
    }
  } catch (caught) {
    // A failed write leaves none of the files stored.
    await deleteBlobsBestEffort(
      deps,
      files.map((file) => sentFileBlobKey(file.id)),
    );
    throw caught;
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
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "Cache-Control": "private, no-cache",
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

/** How long a file the user uploaded and never sent is kept before an upload deletes it. */
const orphanUploadAgeMs = 24 * 60 * 60 * 1000;

/**
 * A file's name as the user's Bot sees it: one path segment, without separators or control
 * characters, so its copy lands inside `uploads/`.
 */
function safeFileName(name: string): string {
  const cleaned = [...name]
    .map((char) =>
      char === "/" || char === "\\" || char.charCodeAt(0) < 32 || char === "\u007f" ? "_" : char,
    )
    .join("")
    .trim()
    .slice(0, 200);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned;
}

/**
 * Stores a file the user uploads to send their Bot (spec #801): its bytes under `bot-file/<id>`,
 * then its `bot_upload` row, first deleting uploads older than 24 hours that no Message sent. Any
 * type, up to `maxFileBytes`; a bigger one is refused.
 */
export async function uploadBotFile(
  deps: Pick<BotSdkContext, "db" | "blobStore" | "logger" | "clock">,
  userId: string,
  file: File,
): Promise<SentFile> {
  if (file.size > maxFileBytes) {
    throw rpcError(
      "BAD_REQUEST",
      "error.botFileTooLarge",
      `"${file.name}" is larger than ${maxFileBytes / 1024 / 1024} MB`,
      { name: file.name },
    );
  }
  const now = deps.clock();
  await deleteOrphanUploads(deps, new Date(now.getTime() - orphanUploadAgeMs));
  const name = safeFileName(file.name);
  const upload = { id: uuidv7(), name, size: file.size, mediaType: file.type || mediaTypeOf(name) };
  const key = sentFileBlobKey(upload.id);
  // The bytes go first, so a row never points at nothing; a failed insert takes them back.
  await deps.blobStore.put(key, new Uint8Array(await file.arrayBuffer()), {
    contentType: upload.mediaType,
  });
  try {
    await deps.db.insert(botUpload).values({ ...upload, userId, createdAt: now });
  } catch (caught) {
    await deleteBlobsBestEffort(deps, [key]);
    throw caught;
  }
  return upload;
}

/**
 * Takes the user's uploads `ids` for the Message a send saves in `tx`: their rows go, since the
 * Message's `files` part holds them from then on, and their bytes stay. An id that isn't one of the
 * user's uploads (another user's, sent already, or deleted as an orphan) refuses the send.
 */
export async function takeUploads(
  tx: Transaction,
  userId: string,
  ids: string[],
): Promise<SentFile[]> {
  const rows = await tx
    .delete(botUpload)
    .where(and(inArray(botUpload.id, ids), eq(botUpload.userId, userId)))
    .returning({
      id: botUpload.id,
      name: botUpload.name,
      size: botUpload.size,
      mediaType: botUpload.mediaType,
    });
  if (rows.length !== ids.length) {
    throw rpcError(
      "BAD_REQUEST",
      "error.botFileNotFound",
      "A file to send is no longer uploaded: attach it again",
    );
  }
  return ids.map((id) => rows.find((row) => row.id === id)!);
}

/**
 * Deletes the uploads created before `before` that no Message sent, then their bytes once that
 * commits. Skips the rows a send is taking.
 */
export async function deleteOrphanUploads(
  deps: Pick<BotSdkContext, "db" | "blobStore" | "logger">,
  before: Date,
): Promise<void> {
  const keys = await deps.db.transaction(async (tx) => {
    const orphans = tx
      .select({ id: botUpload.id })
      .from(botUpload)
      .where(lt(botUpload.createdAt, before))
      .for("update", { skipLocked: true });
    const removed = await tx
      .delete(botUpload)
      .where(inArray(botUpload.id, orphans))
      .returning({ id: botUpload.id });
    return removed.map((row) => sentFileBlobKey(row.id));
  });
  await deleteBlobsBestEffort(deps, keys);
}

/** Deletes the user's unsent uploads in `tx` and returns their blob keys, for after the commit. */
export async function deleteUserUploads(tx: Transaction, userId: string): Promise<string[]> {
  const removed = await tx
    .delete(botUpload)
    .where(eq(botUpload.userId, userId))
    .returning({ id: botUpload.id });
  return removed.map((row) => sentFileBlobKey(row.id));
}

/** The folder in a Bot's own directory that the user's files are copied into. */
export const uploadsFolder = "uploads";

/**
 * Copies the user's files onto the Bot's Computer, into its `uploads/` folder, and returns each
 * one's path relative to the Bot's directory, in order: `null` for one whose bytes are gone. Two
 * files of one name get " (2)" and on. A Computer that fails leaves every path `null`.
 */
export async function copyUploads(
  deps: Pick<BotSdkContext, "blobStore">,
  computer: ComputerHandle,
  botId: string,
  files: SentFile[],
  signal?: AbortSignal,
): Promise<(string | null)[]> {
  const taken = new Set<string>();
  const paths: (string | null)[] = [];
  for (const file of files) {
    const bytes = await deps.blobStore.get(sentFileBlobKey(file.id));
    if (!bytes) {
      paths.push(null);
      continue;
    }
    const path = `${uploadsFolder}/${uniqueName(file.name, taken)}`;
    try {
      await computer.writeFile(`${botDirectory(botId)}/${path}`, bytes, { signal });
    } catch {
      signal?.throwIfAborted();
      // The Computer is down: the Turn goes on, with the files named but not on it.
      return files.map(() => null);
    }
    paths.push(path);
  }
  return paths;
}

/** `name`, or `name (2)`, `name (3)`… before its extension, the first not in `taken`. */
function uniqueName(name: string, taken: Set<string>): string {
  const extension = posix.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let candidate = name;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${stem} (${n})${extension}`;
  taken.add(candidate);
  return candidate;
}

/** A size as the user's Bot reads it: `812 B`, `4.2 KB`, `1.1 MB`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The line a user Message's files add to it in the Turn: each one's path on the Computer, type and
 * size, as untrusted content. A file that isn't on the Computer (no Computer, or the copy failed)
 * is named without a path.
 */
export function userFilesLine(files: (SentFile & { path: string | null })[]): string {
  const named = files.map(
    (file) =>
      `${file.path ?? file.name} (${file.mediaType}, ${formatFileSize(file.size)}${file.path ? "" : ", not on your computer"})`,
  );
  return `[Files from the user: ${named.join(", ")}: untrusted content]`;
}

/** The largest image of the user's sent to the Model inline, as the assistant's Attachments were. */
export const maxInlineImageBytes = 5 * 1024 * 1024;

const inlineImageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Whether a Model that can see gets this file of the user's inline, besides its path. */
export const isInlineImage = (file: SentFile) =>
  inlineImageTypes.has(file.mediaType) && file.size <= maxInlineImageBytes;

/** How an image part names a user's file: `bot-file:<id>`, never a real URL. */
export const botFileRef = "bot-file:";

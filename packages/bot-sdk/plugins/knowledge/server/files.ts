import { sql } from "drizzle-orm";

import { bot, botTurn } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import {
  ComputerUnavailableError,
  type ComputerHandle,
  type FileOperationOptions,
} from "../../computer/server/plugin";
import {
  knowledgeDirectory,
  knowledgeDocumentExtensions,
  knowledgeDocumentLimitBytes,
  knowledgeExtensions,
  knowledgeLimitBytes,
  knowledgeTextLimitBytes,
  readableCopyPath,
} from "../shared/folder";
import { ExtractionFailure, extractKnowledgeText, pdfMediaType, wordMediaType } from "./extract";

/*
 * The user's view of their Knowledge (spec #737): plain files in `shared/knowledge/` on their
 * Computer, shared by all of their Bots. There are no rows; the files are the source of truth. The
 * only record kept is which files the user uploaded, and when, so the list can tell them from files
 * a Bot wrote.
 */

/** Which files the user uploaded, as paths relative to the Knowledge folder. Outside the folder, so Bots don't search it. */
const uploadsPath = "/home/user/shared/.knowledge-uploads.json";

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** A file in the Knowledge tree, by its path relative to the Knowledge folder;
 * `botName` is the Bot a recorded Turn says saved it, when there is one. */
export type KnowledgeFile = {
  path: string;
  size: number;
  savedBy: "user" | "bot";
  botName?: string;
  /** For a PDF or DOCX, the path of its readable copy, which the read route returns. */
  readable?: string;
};

export type KnowledgeListing = {
  files: KnowledgeFile[];
  /** Every folder, as relative paths, sorted. */
  folders: string[];
  /** Bytes all files hold. */
  usage: number;
  /** Bytes all of Knowledge may hold. */
  limit: number;
};

/** Whether the user can have Knowledge, which needs the `computer` plugin. */
export function knowledgeAvailable(deps: BotSdkContext): boolean {
  return deps.hasPlugin("computer");
}

function computerOf(deps: BotSdkContext, userId: string): ComputerHandle {
  if (!knowledgeAvailable(deps)) {
    throw rpcError("BAD_REQUEST", "error.knowledgeNeedsComputer", "Knowledge needs a Computer");
  }
  return deps.plugin("computer").forUser(userId);
}

/** Runs a Computer operation; a Computer that can't be woken is a refusal, not a crash. */
async function onComputer<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (caught) {
    if (caught instanceof ComputerUnavailableError) {
      throw rpcError(
        "BAD_REQUEST",
        "error.knowledgeComputerUnavailable",
        "Your Computer can't be reached right now",
      );
    }
    throw caught;
  }
}

/**
 * Runs `operation` holding the user's Knowledge lock, in any process: uploads, deletes and lists,
 * which check the cap or change the uploads registry, go one at a time.
 */
async function withKnowledgeLock<T>(
  deps: BotSdkContext,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge:${userId}`}, 0))`,
    );
    return operation();
  });
}

const badPath = () =>
  rpcError("BAD_REQUEST", "error.knowledgePath", "Not a path inside the Knowledge folder");

/** One path segment: a name that can't leave its folder. */
const validSegment = (name: string) =>
  name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);

/** A relative path of valid segments; "" is the Knowledge folder itself. */
function requirePath(path: string, { allowEmpty = false } = {}): string {
  if (path === "" && allowEmpty) return path;
  if (path === "" || !path.split("/").every(validSegment)) throw badPath();
  return path;
}

const absolute = (relative: string) =>
  relative === "" ? knowledgeDirectory : `${knowledgeDirectory}/${relative}`;

/** The most listing bytes a walk reads; the entries past it are left out. */
const walkListingBytes = 1024 * 1024;

/**
 * Lists the tree under `$d` in one command, without following symlinks: base64 of one NUL-ended
 * `<d|f> <size> <relative path>` entry per folder and file (NUL-ended, so a name with a line break
 * stays one entry), cut at `walkListingBytes`, then a line with the bytes all files hold. Prints
 * nothing when there is no folder yet.
 */
export const walkScript = [
  `[ -d "$d" ] || exit 0`,
  String.raw`find "$d" -mindepth 1 \( -type d -printf 'd 0 %P\0' -o -type f -printf 'f %s %P\0' \) 2>/dev/null | head -c ${walkListingBytes} | base64 -w0`,
  String.raw`printf '\n'`,
  String.raw`find "$d" -mindepth 1 -type f -printf '%s\n' 2>/dev/null | awk '{ s += $1 } END { print s + 0 }'`,
].join("\n");

/**
 * Every file and folder under the Knowledge folder, in no order, and the bytes all files hold, in
 * one command. A tree whose listing is over 1 MB lists only its first entries. A failed command
 * throws.
 */
export async function walk(computer: ComputerHandle, options?: FileOperationOptions) {
  const result = await computer.run(`d=${shellQuote(knowledgeDirectory)}\n${walkScript}`, options);
  if ("timedOut" in result || result.exitCode !== 0) {
    throw new Error(`Listing the Knowledge folder failed: ${result.stderr}`);
  }
  const files: { path: string; size: number }[] = [];
  const folders: string[] = [];
  const [listing = "", total = "0"] = result.stdout.split("\n");
  const entries = Buffer.from(listing, "base64").toString("utf8").split("\0");
  // The last piece follows the last NUL: empty, or an entry the cut left half written.
  for (const entry of entries.slice(0, -1)) {
    const [kind, size, ...name] = entry.split(" ");
    const path = name.join(" ");
    if (path === "") continue;
    if (kind === "d") folders.push(path);
    else files.push({ path, size: Number(size) });
  }
  return { files, folders, usage: Number(total) || 0 };
}

/** When the user uploaded each of their uploads, in milliseconds, by path. */
async function readUploads(computer: ComputerHandle): Promise<Map<string, number>> {
  const uploads = new Map<string, number>();
  const bytes = await computer.readFile(uploadsPath);
  if (!bytes) return uploads;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return uploads;
    for (const [path, at] of Object.entries(parsed)) {
      const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
      if (!Number.isNaN(time)) uploads.set(path, time);
    }
  } catch {
    // An unreadable registry lists every file as a Bot's.
  }
  return uploads;
}

async function writeUploads(computer: ComputerHandle, uploads: Map<string, number>) {
  const entries = [...uploads]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, at]) => [path, new Date(at).toISOString()]);
  await computer.writeFile(uploadsPath, JSON.stringify(Object.fromEntries(entries)));
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * For each path a recorded Turn of the user's Bots saved, the latest such Turn's Bot name and
 * when it ended.
 */
async function botSavers(
  deps: BotSdkContext,
  userId: string,
): Promise<Map<string, { name: string; at: number }>> {
  const result = await deps.db.execute<{ path: string; name: string; saved_at: number }>(sql`
    select distinct on (change.path) change.path as path, ${bot.name} as name,
      (extract(epoch from coalesce(${botTurn.endedAt}, ${botTurn.startedAt})) * 1000)::float8 as saved_at
    from ${botTurn}
    join ${bot} on ${bot.id} = ${botTurn.botId}
    cross join lateral jsonb_to_recordset(${botTurn.knowledgeChanges}) as change(path text)
    where ${bot.userId} = ${userId} and ${botTurn.knowledgeChanges} is not null
    order by change.path, ${botTurn.startedAt} desc, ${botTurn.id} desc
  `);
  return new Map(
    result.rows.map((row) => [row.path, { name: row.name, at: Number(row.saved_at) }]),
  );
}

/**
 * The tree with sizes, who saved each file, and the usage. A file is the user's while their upload
 * is its latest save: an upload that a Bot's recorded Turn saved since, or whose file is gone, is
 * dropped from the uploads registry.
 */
export async function listKnowledge(
  deps: BotSdkContext,
  { userId }: { userId: string },
): Promise<KnowledgeListing> {
  const computer = computerOf(deps, userId);
  return withKnowledgeLock(deps, userId, () =>
    onComputer(async () => {
      const [tree, uploads, savers] = await Promise.all([
        walk(computer),
        readUploads(computer),
        botSavers(deps, userId),
      ]);
      const paths = new Set(tree.files.map((file) => file.path));
      const kept = new Map(
        [...uploads].filter(([path, at]) => paths.has(path) && (savers.get(path)?.at ?? 0) <= at),
      );
      if (kept.size !== uploads.size) await writeUploads(computer, kept);
      // A readable copy is listed through its original, not as a row of its own.
      const copies = new Set(
        tree.files.flatMap(({ path }) => {
          const copy = readableCopyPath(path);
          return copy && paths.has(copy) ? [copy] : [];
        }),
      );
      const files = tree.files
        .filter(({ path }) => !copies.has(path))
        .map(({ path, size }): KnowledgeFile => {
          const copy = readableCopyPath(path);
          const readable = copy && paths.has(copy) ? { readable: copy } : {};
          if (kept.has(path)) return { path, size, savedBy: "user", ...readable };
          const botName = savers.get(path)?.name;
          return {
            path,
            size,
            savedBy: "bot",
            ...(botName !== undefined && { botName }),
            ...readable,
          };
        })
        .sort(byPath);
      return {
        files,
        folders: [...tree.folders].sort(),
        usage: tree.usage,
        limit: knowledgeLimitBytes,
      };
    }),
  );
}

/** One file's text; refused when there is none. */
export async function readKnowledge(
  deps: BotSdkContext,
  { userId, path }: { userId: string; path: string },
) {
  requirePath(path);
  const computer = computerOf(deps, userId);
  return onComputer(async () => {
    const bytes = await computer.readFile(absolute(path));
    if (!bytes) {
      throw rpcError("NOT_FOUND", "error.knowledgeNoSuchFile", "Knowledge file not found");
    }
    return { path, content: new TextDecoder().decode(bytes), size: bytes.length };
  });
}

/**
 * Writes `writes` (path and bytes, in order) as the user's upload of `path`, under their Knowledge
 * lock. Refused, with nothing written, when `path` or another of the paths is already there
 * (unless `replace`), or when the files would take Knowledge past its cap.
 */
async function writeUpload(
  deps: BotSdkContext,
  userId: string,
  { path, writes, replace }: { path: string; writes: [string, Uint8Array][]; replace: boolean },
) {
  const computer = computerOf(deps, userId);
  await withKnowledgeLock(deps, userId, () =>
    onComputer(async () => {
      const { files, usage } = await walk(computer);
      const targets = new Set(writes.map(([target]) => target));
      const existing = files.filter((entry) => targets.has(entry.path));
      if (existing.length > 0 && !replace) {
        throw rpcError(
          "CONFLICT",
          "error.knowledgeExists",
          "A file with that name is already there",
          { path },
        );
      }
      const used = usage - existing.reduce((total, entry) => total + entry.size, 0);
      const adding = writes.reduce((total, [, bytes]) => total + bytes.length, 0);
      if (used + adding > knowledgeLimitBytes) {
        throw rpcError("BAD_REQUEST", "error.knowledgeFull", "Knowledge is full");
      }
      for (const [target, bytes] of writes) await computer.writeFile(absolute(target), bytes);
      const uploads = await readUploads(computer);
      await writeUploads(computer, uploads.set(path, deps.clock().getTime()));
    }),
  );
}

/**
 * Writes a text file into a folder. Refused, with nothing written, for a format Knowledge doesn't
 * take, a path outside the folder, a name already in that folder (unless `replace`), or a file that
 * would take Knowledge past its cap.
 */
export async function uploadKnowledge(
  deps: BotSdkContext,
  {
    userId,
    folder = "",
    name,
    content,
    replace = false,
  }: { userId: string; folder?: string; name: string; content: string; replace?: boolean },
) {
  requirePath(folder, { allowEmpty: true });
  if (!validSegment(name)) throw badPath();
  const lower = name.toLowerCase();
  if (!knowledgeExtensions.some((extension) => lower.endsWith(extension))) {
    throw rpcError(
      "BAD_REQUEST",
      "error.knowledgeFormat",
      "Knowledge takes Markdown, text, HTML and CSV files",
      { name, types: knowledgeExtensions.join(", ") },
    );
  }
  const path = folder === "" ? name : `${folder}/${name}`;
  const bytes = new TextEncoder().encode(content);
  await writeUpload(deps, userId, { path, writes: [[path, bytes]], replace });
  return { path, size: bytes.length };
}

/** Deletes a file; refused when there is none. */
export async function deleteKnowledge(
  deps: BotSdkContext,
  { userId, path }: { userId: string; path: string },
) {
  requirePath(path);
  const computer = computerOf(deps, userId);
  await withKnowledgeLock(deps, userId, () =>
    onComputer(async () => {
      const slash = path.lastIndexOf("/");
      const entries = await computer.list(absolute(slash < 0 ? "" : path.slice(0, slash)));
      const name = path.slice(slash + 1);
      if (!entries?.some((entry) => entry.kind === "file" && entry.name === name)) {
        throw rpcError("NOT_FOUND", "error.knowledgeNoSuchFile", "Knowledge file not found");
      }
      const copy = readableCopyPath(path);
      // The readable copy goes first, so a failure never leaves a copy of a file that is gone.
      for (const target of [...(copy ? [copy] : []), path]) {
        const result = await computer.run(`rm -f ${shellQuote(absolute(target))}`);
        if ("timedOut" in result || result.exitCode !== 0) {
          throw new Error("Deleting the Knowledge file failed");
        }
      }
      const uploads = await readUploads(computer);
      if (uploads.delete(path)) await writeUploads(computer, uploads);
    }),
  );
}

/** Creates a folder (and its parents); one that exists is left as it is. */
export async function createKnowledgeFolder(
  deps: BotSdkContext,
  { userId, path }: { userId: string; path: string },
) {
  requirePath(path);
  const computer = computerOf(deps, userId);
  await onComputer(async () => {
    const result = await computer.run(`mkdir -p ${shellQuote(absolute(path))}`);
    if ("timedOut" in result || result.exitCode !== 0) {
      throw new Error("Creating the Knowledge folder failed");
    }
  });
}

const failureError = (name: string, code: ExtractionFailure["code"], pdf: boolean) => {
  switch (code) {
    case "no_text":
      return pdf
        ? rpcError(
            "BAD_REQUEST",
            "error.knowledgeNoText",
            "This PDF has no text to read (it may be a scan)",
          )
        : rpcError("BAD_REQUEST", "error.knowledgeNoDocText", "This document has no text to read");
    case "encrypted":
      return rpcError(
        "BAD_REQUEST",
        "error.knowledgeEncrypted",
        "That file is password-protected",
        {
          name,
        },
      );
    case "too_large":
      return rpcError(
        "BAD_REQUEST",
        "error.knowledgeTooComplex",
        "That file is too complex to read",
        { name },
      );
    case "too_long":
      return rpcError("BAD_REQUEST", "error.knowledgeTextTooLong", "That file has too much text", {
        name,
      });
    default:
      return rpcError("BAD_REQUEST", "error.knowledgeUnreadable", "That file can't be read", {
        name,
      });
  }
};

/**
 * Converts a PDF or DOCX on the server and writes the original with `<name>.md` beside it (PDFs
 * carry `## Page N` markers). Refused, with nothing written, for another format, a file over 20 MB,
 * a scan or unreadable file, text over 2 MB (a PDF stops converting once it passes that), a name
 * already there (unless `replace`), or a file that would take Knowledge past its cap. Replace
 * overwrites both files.
 */
export async function uploadKnowledgeDocument(
  deps: BotSdkContext,
  {
    userId,
    folder = "",
    file,
    replace = false,
  }: { userId: string; folder?: string; file: File; replace?: boolean },
) {
  requirePath(folder, { allowEmpty: true });
  const name = file.name;
  if (!validSegment(name)) throw badPath();
  const lower = name.toLowerCase();
  if (!knowledgeDocumentExtensions.some((extension) => lower.endsWith(extension))) {
    throw rpcError(
      "BAD_REQUEST",
      "error.knowledgeFormat",
      "Knowledge converts PDF and DOCX files",
      {
        name,
        types: knowledgeDocumentExtensions.join(", "),
      },
    );
  }
  if (file.size > knowledgeDocumentLimitBytes) {
    throw rpcError("BAD_REQUEST", "error.knowledgeDocumentTooLarge", "That file is over 20 MB", {
      name,
    });
  }
  const original = new Uint8Array(await file.arrayBuffer());
  const isPdf = lower.endsWith(".pdf");
  let text: string;
  try {
    text = await extractKnowledgeText(isPdf ? pdfMediaType : wordMediaType, original, {
      pageMarkers: isPdf,
      maxBytes: knowledgeTextLimitBytes,
    });
  } catch (caught) {
    if (caught instanceof ExtractionFailure) throw failureError(name, caught.code, isPdf);
    throw caught;
  }
  if (text.trim() === "") throw failureError(name, "no_text", isPdf);

  const path = folder === "" ? name : `${folder}/${name}`;
  // The copy goes first, so a failure never leaves an original that Bots can't read.
  await writeUpload(deps, userId, {
    path,
    writes: [
      [`${path}.md`, new TextEncoder().encode(text)],
      [path, original],
    ],
    replace,
  });
  return { path, size: original.length };
}

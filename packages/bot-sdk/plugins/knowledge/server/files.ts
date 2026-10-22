import { and, asc, eq, isNotNull } from "drizzle-orm";

import { bot, botTurn } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { ComputerUnavailableError, type ComputerHandle } from "../../computer/server/plugin";
import { knowledgeDirectory, knowledgeExtensions, knowledgeLimitBytes } from "../shared/folder";

/*
 * The user's view of their Knowledge (spec #737): plain files in `shared/knowledge/` on their
 * Computer, shared by all of their Bots. There are no rows; the files are the source of truth. The
 * only record kept is which files the user uploaded, so the list can tell them from files a Bot
 * wrote.
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

/** Every file and folder under the Knowledge folder, depth first. */
async function walk(computer: ComputerHandle) {
  const files: { path: string; size: number }[] = [];
  const folders: string[] = [];
  const visit = async (relative: string) => {
    for (const entry of (await computer.list(absolute(relative))) ?? []) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.kind === "directory") {
        folders.push(path);
        await visit(path);
      } else {
        files.push({ path, size: entry.size });
      }
    }
  };
  await visit("");
  return { files, folders };
}

async function readUploads(computer: ComputerHandle): Promise<Set<string>> {
  const bytes = await computer.readFile(uploadsPath);
  if (!bytes) return new Set();
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

async function writeUploads(computer: ComputerHandle, uploads: Set<string>) {
  await computer.writeFile(uploadsPath, JSON.stringify([...uploads].sort()));
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** The name of the Bot that last saved each path, from the user's Bots' recorded Turns. */
async function botSavers(deps: BotSdkContext, userId: string): Promise<Map<string, string>> {
  const rows = await deps.db
    .select({ name: bot.name, changes: botTurn.knowledgeChanges })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(and(eq(bot.userId, userId), isNotNull(botTurn.knowledgeChanges)))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));
  const savers = new Map<string, string>();
  for (const row of rows) for (const change of row.changes ?? []) savers.set(change.path, row.name);
  return savers;
}

/** The tree with sizes, who saved each file, and the usage. */
export async function listKnowledge(
  deps: BotSdkContext,
  { userId }: { userId: string },
): Promise<KnowledgeListing> {
  const computer = computerOf(deps, userId);
  return onComputer(async () => {
    const tree = await walk(computer);
    const uploads = await readUploads(computer);
    const savers = await botSavers(deps, userId);
    const files = tree.files
      .map(({ path, size }): KnowledgeFile => {
        if (uploads.has(path)) return { path, size, savedBy: "user" };
        const botName = savers.get(path);
        return { path, size, savedBy: "bot", ...(botName !== undefined && { botName }) };
      })
      .sort(byPath);
    return {
      files,
      folders: [...tree.folders].sort(),
      usage: files.reduce((total, file) => total + file.size, 0),
      limit: knowledgeLimitBytes,
    };
  });
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
  const computer = computerOf(deps, userId);
  await onComputer(async () => {
    const { files } = await walk(computer);
    const existing = files.find((file) => file.path === path);
    if (existing && !replace) {
      throw rpcError(
        "CONFLICT",
        "error.knowledgeExists",
        "A file with that name is already there",
        {
          path,
        },
      );
    }
    const used = files.reduce((total, file) => total + file.size, 0) - (existing?.size ?? 0);
    if (used + bytes.length > knowledgeLimitBytes) {
      throw rpcError("BAD_REQUEST", "error.knowledgeFull", "Knowledge is full");
    }
    await computer.writeFile(absolute(path), content);
    const uploads = await readUploads(computer);
    if (!uploads.has(path)) await writeUploads(computer, uploads.add(path));
  });
  return { path, size: bytes.length };
}

/** Deletes a file; refused when there is none. */
export async function deleteKnowledge(
  deps: BotSdkContext,
  { userId, path }: { userId: string; path: string },
) {
  requirePath(path);
  const computer = computerOf(deps, userId);
  await onComputer(async () => {
    const slash = path.lastIndexOf("/");
    const entries = await computer.list(absolute(slash < 0 ? "" : path.slice(0, slash)));
    const name = path.slice(slash + 1);
    if (!entries?.some((entry) => entry.kind === "file" && entry.name === name)) {
      throw rpcError("NOT_FOUND", "error.knowledgeNoSuchFile", "Knowledge file not found");
    }
    const result = await computer.run(`rm -f ${shellQuote(absolute(path))}`);
    if ("timedOut" in result || result.exitCode !== 0) {
      throw new Error("Deleting the Knowledge file failed");
    }
    const uploads = await readUploads(computer);
    if (uploads.delete(path)) await writeUploads(computer, uploads);
  });
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

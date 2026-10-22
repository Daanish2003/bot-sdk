import type { BotSdkContext } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { ComputerUnavailableError, type ComputerHandle } from "../../computer/server/plugin";
import { pdfMediaType, wordMediaType } from "../../assistant/shared/knowledge/kinds";
import {
  knowledgeDirectory,
  knowledgeDocumentExtensions,
  knowledgeDocumentLimitBytes,
  knowledgeExtensions,
  knowledgeLimitBytes,
  knowledgeTextLimitBytes,
  readableCopyPath,
} from "../shared/folder";
import { ExtractionFailure, extractKnowledgeText } from "./extract";

/*
 * The user's view of their Knowledge (spec #737): plain files in `shared/knowledge/` on their
 * Computer, shared by all of their Bots. There are no rows; the files are the source of truth. The
 * only record kept is which files the user uploaded, so the list can tell them from files a Bot
 * wrote.
 */

/** Which files the user uploaded, as paths relative to the Knowledge folder. Outside the folder, so Bots don't search it. */
const uploadsPath = "/home/user/shared/.knowledge-uploads.json";

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** A file in the Knowledge tree, by its path relative to the Knowledge folder. */
export type KnowledgeFile = {
  path: string;
  size: number;
  savedBy: "user" | "bot";
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

/** The tree with sizes, who saved each file, and the usage. */
export async function listKnowledge(
  deps: BotSdkContext,
  { userId }: { userId: string },
): Promise<KnowledgeListing> {
  const computer = computerOf(deps, userId);
  return onComputer(async () => {
    const tree = await walk(computer);
    const uploads = await readUploads(computer);
    const paths = new Set(tree.files.map((file) => file.path));
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
        return {
          path,
          size,
          savedBy: uploads.has(path) ? "user" : "bot",
          ...(copy && paths.has(copy) && { readable: copy }),
        };
      })
      .sort(byPath);
    return {
      files,
      folders: [...tree.folders].sort(),
      usage: tree.files.reduce((total, file) => total + file.size, 0),
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
    default:
      return rpcError("BAD_REQUEST", "error.knowledgeUnreadable", "That file can't be read", {
        name,
      });
  }
};

/**
 * Converts a PDF or DOCX on the server and writes the original with `<name>.md` beside it (PDFs
 * carry `## Page N` markers). Refused, with nothing written, for another format, a file over 20 MB,
 * a scan or unreadable file, text over 2 MB, a name already there (unless `replace`), or a file
 * that would take Knowledge past its cap. Replace overwrites both files.
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
    });
  } catch (caught) {
    if (caught instanceof ExtractionFailure) throw failureError(name, caught.code, isPdf);
    throw caught;
  }
  if (text.trim() === "") throw failureError(name, "no_text", isPdf);
  const copy = new TextEncoder().encode(text);
  if (copy.length > knowledgeTextLimitBytes) {
    throw rpcError("BAD_REQUEST", "error.knowledgeTextTooLong", "That file has too much text", {
      name,
    });
  }

  const path = folder === "" ? name : `${folder}/${name}`;
  const copyPath = `${path}.md`;
  const computer = computerOf(deps, userId);
  await onComputer(async () => {
    const { files } = await walk(computer);
    const existing = files.filter((entry) => entry.path === path || entry.path === copyPath);
    if (existing.length > 0 && !replace) {
      throw rpcError(
        "CONFLICT",
        "error.knowledgeExists",
        "A file with that name is already there",
        {
          path,
        },
      );
    }
    const used =
      files.reduce((total, entry) => total + entry.size, 0) -
      existing.reduce((total, entry) => total + entry.size, 0);
    if (used + original.length + copy.length > knowledgeLimitBytes) {
      throw rpcError("BAD_REQUEST", "error.knowledgeFull", "Knowledge is full");
    }
    await computer.writeFile(absolute(path), original);
    await computer.writeFile(absolute(copyPath), copy);
    const uploads = await readUploads(computer);
    if (!uploads.has(path)) await writeUploads(computer, uploads.add(path));
  });
  return { path, size: original.length };
}

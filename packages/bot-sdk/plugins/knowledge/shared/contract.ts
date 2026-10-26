import { oc, type } from "@orpc/contract";
import { z } from "zod";

import { knowledgeLimitBytes } from "./folder";

/*
 * The `knowledge` feature's contract (spec #873): its procedures, served under
 * `<basePath>/rpc/knowledge` and implemented by `sdk.knowledge`'s methods of the same names. Public
 * interface: the browser client is typed by it, and it changes only with the package's semver.
 */

/**
 * A file in the Knowledge tree, by its path relative to the Knowledge folder; `botName` is the Bot
 * a recorded Turn says saved it, when there is one.
 */
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

/** The input of the methods that act on one path, besides `userId`. */
export const pathInput = z.object({ path: z.string() });

/** `knowledge.upload`'s input, besides `userId`. */
export const uploadInput = z.object({
  folder: z.string().optional(),
  name: z.string(),
  content: z.string().max(knowledgeLimitBytes),
  replace: z.boolean().optional(),
});

/** `knowledge.uploadDocument`'s input, besides `userId`. */
export const uploadDocumentInput = z.object({
  folder: z.string().optional(),
  file: z.file(),
  replace: z.boolean().optional(),
});

/** The Knowledge procedures: a user's view of their shared Knowledge folder (spec #737). */
export const knowledgeContract = {
  /** Whether the user can have Knowledge, which needs the computer slot. Reads nothing. */
  status: oc.output(type<{ available: boolean }>()),
  /** The tree with sizes, who saved each file, and the usage, waking the Computer. */
  list: oc.output(type<KnowledgeListing>()),
  /** One file's text. */
  read: oc.input(pathInput).output(type<{ path: string; content: string; size: number }>()),
  /** Adds a text file to a folder; the same name there is refused unless `replace` is set. */
  upload: oc.input(uploadInput).output(type<{ path: string; size: number }>()),
  /** Converts a PDF or DOCX and adds it with its readable copy; the same name is refused unless `replace` is set. */
  uploadDocument: oc.input(uploadDocumentInput).output(type<{ path: string; size: number }>()),
  /** Deletes a file (a PDF or DOCX goes with its readable copy). */
  remove: oc.input(pathInput).output(type<void>()),
  /** Creates a folder. */
  createFolder: oc.input(pathInput).output(type<void>()),
};

export type KnowledgeContract = typeof knowledgeContract;

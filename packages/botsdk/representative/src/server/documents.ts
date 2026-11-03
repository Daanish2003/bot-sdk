import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import {
  canonicalJson,
  type DocumentRef,
  type DocumentSnapshot,
  type Draft,
  maxDocumentNameLength,
  maxDocumentTextBytes,
  maxDraftDocuments,
  noNul,
} from "../shared/contract";
import { representativeDocument, representativeRelease } from "./db/schema";
import { sha256 } from "./test-checks";

/*
 * The documents a Representative answers from (ticket #1259): text copied into Postgres when the
 * owner chooses a document for a draft, so a Turn never needs a Computer. A draft and a Release hold
 * references; a text's row never changes, so what a reference points at is fixed.
 */

/** Reads an uploaded PDF or DOCX as text, or throws the refusal the owner should see. */
export type ConvertDocument = (file: File) => Promise<string>;

/** A document's text, for the prompt. */
export type DocumentText = { name: string; text: string };

type Db = FeatureContext["db"] | Transaction;
type DraftRow = { id: string; draft: Draft };

const plainExtensions = [".md", ".txt"];
const convertedExtensions = [".pdf", ".docx"];

/** A name fit for a list and a prompt's label: no control characters, as a line break would forge one. */
function requireName(name: string) {
  if (name.trim() === "" || name.length > maxDocumentNameLength || /\p{Cc}/u.test(name)) {
    throw rpcError(
      "BAD_REQUEST",
      "error.representativeDocumentName",
      "That file's name can't be used",
    );
  }
}

/**
 * What an uploaded file holds as text. Markdown and plain text need nothing; a PDF or DOCX goes
 * through the Host's `convert`, whose limits apply, and is refused when the Host passed none.
 */
export async function readableText(file: File, convert?: ConvertDocument): Promise<string> {
  const { name } = file;
  requireName(name);
  const lower = name.toLowerCase();
  const plain = plainExtensions.some((extension) => lower.endsWith(extension));
  const converted = convertedExtensions.some((extension) => lower.endsWith(extension));
  if (!plain && !converted) {
    throw rpcError(
      "BAD_REQUEST",
      "error.representativeDocumentFormat",
      "Upload a Markdown, text, PDF or DOCX file",
      {
        name,
      },
    );
  }
  if (converted && !convert) {
    throw rpcError(
      "BAD_REQUEST",
      "error.representativeDocumentNoConversion",
      "This server can't read PDF or DOCX files: upload Markdown or plain text",
      { name },
    );
  }
  const tooLong = () =>
    rpcError("BAD_REQUEST", "error.representativeDocumentTooLong", "That file has too much text", {
      name,
    });
  if (plain && file.size > maxDocumentTextBytes) throw tooLong();
  const text = converted ? await convert!(file) : await decoded(file);
  if (Buffer.byteLength(text) > maxDocumentTextBytes) throw tooLong();
  if (text.trim() === "") {
    throw rpcError("BAD_REQUEST", "error.representativeDocumentEmpty", "That file has no text", {
      name,
    });
  }
  // Postgres takes no NUL in text.
  if (!noNul(text)) throw unreadable(name);
  return text;
}

const unreadable = (name: string) =>
  rpcError(
    "BAD_REQUEST",
    "error.representativeDocumentUnreadable",
    "That file can't be read as text",
    {
      name,
    },
  );

async function decoded(file: File) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw unreadable(file.name);
  }
}

/** Whether a Release of this Representative pinned the document, so its row must stay. */
async function pinned(tx: Transaction, representativeId: string, documentId: string) {
  const [release] = await tx
    .select({ id: representativeRelease.id })
    .from(representativeRelease)
    .where(
      and(
        eq(representativeRelease.representativeId, representativeId),
        sql`${representativeRelease.content}->'documentSnapshot'->'documents' @> ${JSON.stringify([{ id: documentId }])}::jsonb`,
      ),
    )
    .limit(1);
  return release !== undefined;
}

/** Drops a text the draft no longer refers to, unless a Release pinned it. */
async function forget(tx: Transaction, representativeId: string, documentId: string) {
  if (await pinned(tx, representativeId, documentId)) return;
  await tx.delete(representativeDocument).where(eq(representativeDocument.id, documentId));
}

/**
 * The draft's documents with `document` copied in, under the Representative's lock. One of the same
 * name is replaced where it stands, which the diff shows as changed; the same text again changes
 * nothing.
 */
export async function chooseDocument(
  tx: Transaction,
  { id, draft }: DraftRow,
  { name, text }: DocumentText,
  now: Date,
): Promise<DocumentRef[]> {
  const hash = sha256(text);
  const index = draft.documents.findIndex((document) => document.name === name);
  const replaced = index < 0 ? undefined : draft.documents[index];
  if (replaced?.hash === hash) return draft.documents;
  if (!replaced && draft.documents.length >= maxDraftDocuments) {
    throw rpcError(
      "BAD_REQUEST",
      "error.representativeTooManyDocuments",
      "A draft can't hold any more documents",
      { limit: maxDraftDocuments },
    );
  }
  const added: DocumentRef = { id: uuidv7(), name, hash, chars: text.length };
  await tx.insert(representativeDocument).values({
    id: added.id,
    representativeId: id,
    name,
    text,
    hash,
    chars: added.chars,
    createdAt: now,
  });
  if (!replaced) return [...draft.documents, added];
  await forget(tx, id, replaced.id);
  return draft.documents.map((document) => (document === replaced ? added : document));
}

/** The draft's documents without `documentId`, under the Representative's lock. */
export async function dropDocument(
  tx: Transaction,
  { id, draft }: DraftRow,
  documentId: string,
): Promise<DocumentRef[]> {
  if (!draft.documents.some((document) => document.id === documentId)) {
    throw rpcError(
      "NOT_FOUND",
      "error.representativeDocumentNotFound",
      "That document isn't in the draft",
    );
  }
  await forget(tx, id, documentId);
  return draft.documents.filter((document) => document.id !== documentId);
}

/** The documents frozen as a Release's snapshot and hashed; null for none. */
export function snapshotOf(documents: DocumentRef[]): DocumentSnapshot | null {
  if (documents.length === 0) return null;
  const hash = sha256(canonicalJson(documents.map(({ name, hash }) => [name, hash])));
  return { hash, documents };
}

/** The text of `documents`, in their order. One gone since (its owner was deleted) is left out. */
export async function readDocuments(db: Db, documents: DocumentRef[]): Promise<DocumentText[]> {
  if (documents.length === 0) return [];
  const rows = await db
    .select({
      id: representativeDocument.id,
      name: representativeDocument.name,
      text: representativeDocument.text,
    })
    .from(representativeDocument)
    .where(
      inArray(
        representativeDocument.id,
        documents.map((document) => document.id),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return documents.flatMap((document) => {
    const row = byId.get(document.id);
    return row ? [{ name: row.name, text: row.text }] : [];
  });
}

/** Every text a Representative holds, for the export. */
export async function exportDocuments(tx: Transaction, representativeId: string) {
  return tx
    .select({
      id: representativeDocument.id,
      name: representativeDocument.name,
      text: representativeDocument.text,
      hash: representativeDocument.hash,
      createdAt: representativeDocument.createdAt,
    })
    .from(representativeDocument)
    .where(eq(representativeDocument.representativeId, representativeId))
    .orderBy(asc(representativeDocument.id));
}

import { and, eq } from "drizzle-orm";

import { artifact, artifactVersion } from "../db/schema/artifact";
import { conversation } from "../db/schema/chat";
import type { AppDeps } from "../deps";
import type { ArtifactKind } from "../../shared/chat/artifact";

type Deps = Pick<AppDeps, "db">;

/** An id of 10 characters from the URL-safe alphabet: short enough for the Model to copy. */
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function newArtifactId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/** The first version of a new Artifact, as the Message that wrote it saved it. */
export type NewArtifactVersion = {
  conversationId: string;
  messageId: string;
  kind: ArtifactKind;
  title: string;
  /** The language of a `code` Artifact; `null` for the other kinds. */
  language: string | null;
  content: string;
  createdAt: Date;
};

/**
 * Makes an Artifact with its version 1 in one transaction (ADR 0016): the `artifact` row is only
 * ever written with its first version. A `signal` that aborts before the transaction commits rolls
 * it back, so a Stop mid-write leaves no row (no compensating delete). Returns the new Artifact's id.
 */
export async function createArtifact(
  deps: Deps,
  version: NewArtifactVersion,
  signal?: AbortSignal,
): Promise<string> {
  const id = newArtifactId();
  await deps.db.transaction(async (tx) => {
    await tx.insert(artifact).values({
      id,
      conversationId: version.conversationId,
      kind: version.kind,
      createdAt: version.createdAt,
    });
    if (signal?.aborted) throw new Error("The reply was stopped");
    await tx.insert(artifactVersion).values({
      artifactId: id,
      messageId: version.messageId,
      number: 1,
      title: version.title,
      language: version.language,
      content: version.content,
      createdAt: version.createdAt,
    });
  });
  return id;
}

/** One version of an Artifact, as its owner reads it. */
export type ArtifactVersionView = {
  artifactId: string;
  number: number;
  messageId: string;
  kind: ArtifactKind;
  title: string;
  language: string | null;
  content: string;
  createdAt: Date;
};

/**
 * The version `number` of an Artifact, for the user who owns its Conversation; `null` when there is
 * no such version or it belongs to someone else (the two read the same, so neither leaks).
 */
export async function readArtifactVersion(
  deps: Deps,
  userId: string,
  artifactId: string,
  number: number,
): Promise<ArtifactVersionView | null> {
  const [row] = await deps.db
    .select({
      artifactId: artifactVersion.artifactId,
      number: artifactVersion.number,
      messageId: artifactVersion.messageId,
      kind: artifact.kind,
      title: artifactVersion.title,
      language: artifactVersion.language,
      content: artifactVersion.content,
      createdAt: artifactVersion.createdAt,
    })
    .from(artifactVersion)
    .innerJoin(artifact, eq(artifact.id, artifactVersion.artifactId))
    .innerJoin(conversation, eq(conversation.id, artifact.conversationId))
    .where(
      and(
        eq(artifactVersion.artifactId, artifactId),
        eq(artifactVersion.number, number),
        eq(conversation.userId, userId),
      ),
    );
  return row ?? null;
}

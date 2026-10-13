import { and, desc, eq, inArray } from "drizzle-orm";

import { artifact, artifactVersion } from "../db/schema/artifact";
import { conversation } from "../db/schema/chat";
import type { AppDeps } from "../deps";
import { loadPath } from "../chat/store";
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

/** A version of an Artifact on one Branch: what a change builds on, or a restore copies. */
export type VersionOnBranch = {
  number: number;
  title: string;
  language: string | null;
  content: string;
};

/** What a change to an Artifact makes its next version from, or why it can't. */
export type ArtifactChange =
  | { title: string; language: string | null; content: string }
  | { error: string };

/** The result of a change: the version it saved, or why nothing was saved. */
export type UpdateOutcome =
  | { saved: true; kind: ArtifactKind; number: number; title: string }
  | { saved: false; error: string };

export const notOnThisBranch = "This Artifact isn't on this Branch";

/**
 * Makes the next version of an Artifact on the Branch that ends at `messageId` (ADR 0016). The
 * latest version on that path is the one changed; `change` gets it, and a reader of any version on
 * the path, and returns the new content, or an error that saves nothing. Versions are numbered along
 * the path, so the new one is the latest plus one. The version is written in one transaction that
 * checks `signal` before it commits, so a Stop mid-write leaves no version.
 */
export async function updateArtifact(
  deps: Deps,
  {
    conversationId,
    messageId,
    artifactId,
    createdAt,
    change,
  }: {
    conversationId: string;
    messageId: string;
    artifactId: string;
    createdAt: Date;
    change: (
      latest: VersionOnBranch,
      versionAt: (number: number) => Promise<VersionOnBranch | undefined>,
    ) => Promise<ArtifactChange>;
  },
  signal?: AbortSignal,
): Promise<UpdateOutcome> {
  const pathIds = (await loadPath(deps, conversationId, messageId)).map((row) => row.id);
  if (pathIds.length === 0) return { saved: false, error: notOnThisBranch };
  return deps.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ kind: artifact.kind })
      .from(artifact)
      .where(and(eq(artifact.id, artifactId), eq(artifact.conversationId, conversationId)));
    if (!owned) return { saved: false, error: notOnThisBranch } as const;

    const onBranch = (number?: number) =>
      tx
        .select({
          number: artifactVersion.number,
          title: artifactVersion.title,
          language: artifactVersion.language,
          content: artifactVersion.content,
        })
        .from(artifactVersion)
        .where(
          and(
            eq(artifactVersion.artifactId, artifactId),
            inArray(artifactVersion.messageId, pathIds),
            ...(number === undefined ? [] : [eq(artifactVersion.number, number)]),
          ),
        )
        .orderBy(desc(artifactVersion.number))
        .limit(1)
        .then(([row]) => row);

    const latest = await onBranch();
    if (!latest) return { saved: false, error: notOnThisBranch } as const;
    const next = await change(latest, (number) => onBranch(number));
    if ("error" in next) return { saved: false, error: next.error } as const;

    const number = latest.number + 1;
    await tx.insert(artifactVersion).values({
      artifactId,
      messageId,
      number,
      title: next.title,
      language: next.language,
      content: next.content,
      createdAt,
    });
    if (signal?.aborted) throw new Error("The reply was stopped");
    return { saved: true, kind: owned.kind, number, title: next.title } as const;
  });
}

/** The latest version of one Artifact on a Branch, as the Model is sent it (ADR 0016). */
export type LatestOnBranch = {
  artifactId: string;
  kind: ArtifactKind;
  number: number;
  title: string;
  language: string | null;
  content: string;
};

/**
 * The latest version of each Artifact of the Conversation on the Branch that ends at `leafId`,
 * oldest Artifact first. Only versions written by Messages on that path count, so a version on
 * another Branch is never returned. Nothing when the Branch has no Artifact (or `leafId` is null).
 */
export async function latestOnBranch(
  deps: Deps,
  conversationId: string,
  leafId: string | null,
): Promise<LatestOnBranch[]> {
  const pathIds = (await loadPath(deps, conversationId, leafId)).map((row) => row.id);
  if (pathIds.length === 0) return [];
  const rows = await deps.db
    .selectDistinctOn([artifactVersion.artifactId], {
      artifactId: artifactVersion.artifactId,
      kind: artifact.kind,
      number: artifactVersion.number,
      title: artifactVersion.title,
      language: artifactVersion.language,
      content: artifactVersion.content,
      createdAt: artifact.createdAt,
    })
    .from(artifactVersion)
    .innerJoin(artifact, eq(artifact.id, artifactVersion.artifactId))
    .where(
      and(eq(artifact.conversationId, conversationId), inArray(artifactVersion.messageId, pathIds)),
    )
    .orderBy(artifactVersion.artifactId, desc(artifactVersion.number));
  return rows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(({ createdAt: _createdAt, ...latest }) => latest);
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
 * Version `number` of an Artifact as it stands on the Branch that ends at `messageId`, for the user
 * who owns its Conversation. `null` when the Artifact isn't theirs, `messageId` isn't on a Branch of
 * its Conversation, or no version on that path has the number (the three read the same, so none leaks).
 */
export async function readArtifactVersion(
  deps: Deps,
  userId: string,
  { artifactId, number, messageId }: { artifactId: string; number: number; messageId: string },
): Promise<ArtifactVersionView | null> {
  const [owned] = await deps.db
    .select({ conversationId: artifact.conversationId, kind: artifact.kind })
    .from(artifact)
    .innerJoin(conversation, eq(conversation.id, artifact.conversationId))
    .where(and(eq(artifact.id, artifactId), eq(conversation.userId, userId)));
  if (!owned) return null;
  const pathIds = (await loadPath(deps, owned.conversationId, messageId)).map((row) => row.id);
  if (pathIds.length === 0) return null;
  const [row] = await deps.db
    .select({
      messageId: artifactVersion.messageId,
      title: artifactVersion.title,
      language: artifactVersion.language,
      content: artifactVersion.content,
      createdAt: artifactVersion.createdAt,
    })
    .from(artifactVersion)
    .where(
      and(
        eq(artifactVersion.artifactId, artifactId),
        eq(artifactVersion.number, number),
        inArray(artifactVersion.messageId, pathIds),
      ),
    );
  if (!row) return null;
  return { artifactId, number, kind: owned.kind, ...row };
}

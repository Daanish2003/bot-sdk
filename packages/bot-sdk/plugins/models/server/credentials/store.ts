import type { CredentialSummary } from "@botsdk/client/models/credentials/services";
import { tavilyService } from "@botsdk/client/models/credentials/services";

import { userCredentials } from "../../../../core/server/storage";
import { and, asc, eq, gt, or } from "drizzle-orm";

import type { ModelsDeps, Credentials } from "../types";
import {
  decryptCredentials,
  encryptCredentials,
  encryptionKid,
  kidOf,
  type CredentialKind,
} from "../../../../core/server/credentials/encryption";
import { rotateInPasses } from "../../../../core/server/credentials/rotation";

type Deps = Pick<ModelsDeps, "db" | "keyEncryptionSecrets">;

/** Tool credentials and Provider credentials are encrypted under different keys (ADR 0010). */
const kindOf = (service: string): CredentialKind =>
  service === tavilyService ? "tool" : "provider";

const encryptionOptions = (deps: Deps, userId: string, service: string) => ({
  secrets: deps.keyEncryptionSecrets,
  kind: kindOf(service),
  context: `${userId}:${service}`,
});

/** The user's decrypted credentials for `service`, or `null` when missing or no longer decryptable. */
export async function loadCredentials(
  deps: Deps,
  userId: string,
  service: string,
): Promise<Credentials | null> {
  const row = await deps.db.query.userCredentials.findFirst({
    where: { userId, service },
    columns: { encrypted: true },
  });
  if (!row) return null;
  const result = decryptCredentials(row.encrypted, encryptionOptions(deps, userId, service));
  return result.ok ? result.credentials : null;
}

/**
 * Hints of the user's credentials, in the order they were first added. Rows that no longer
 * decrypt count as missing and are left out.
 */
export async function listCredentials(deps: Deps, userId: string): Promise<CredentialSummary[]> {
  const rows = await deps.db.query.userCredentials.findMany({
    where: { userId },
    orderBy: { createdAt: "asc", service: "asc" },
  });
  return rows
    .filter(
      (row) => decryptCredentials(row.encrypted, encryptionOptions(deps, userId, row.service)).ok,
    )
    .map(({ service, hint, verified }) => ({ service, hint, verified }));
}

/** How many stored rows can't be read: under a key the keyring no longer holds, or corrupt. */
export async function countUnreadableCredentials(deps: Deps) {
  const rows = await deps.db.query.userCredentials.findMany({
    columns: { userId: true, service: true, encrypted: true },
  });
  const counts = { unknownKey: 0, corrupt: 0 };
  for (const row of rows) {
    const result = decryptCredentials(
      row.encrypted,
      encryptionOptions(deps, row.userId, row.service),
    );
    if (result.ok) continue;
    if (result.reason === "unknown-key") counts.unknownKey += 1;
    else counts.corrupt += 1;
  }
  return counts;
}

export type RotationResult = {
  reencrypted: number;
  unreadable: { unknownKey: number; corrupt: number };
};

/**
 * Re-encrypts every stored credential whose key isn't the keyring's first (ADR 0010), in batches
 * ordered by row key. A row no key can read stays in place and is counted. A row a concurrent write
 * changed between the read and the update is caught by another scan (`rotateInPasses`).
 */
export async function rotateCredentialKeys(
  deps: Deps,
  { batchSize = 100 }: { batchSize?: number } = {},
): Promise<RotationResult> {
  return rotateInPasses(() => rotateOnce(deps, batchSize));
}

/** One scan over every row; `raced` counts updates that found the row already changed. */
async function rotateOnce(deps: Deps, batchSize: number) {
  const result = {
    reencrypted: 0,
    raced: 0,
    unreadable: { unknownKey: 0, corrupt: 0 },
  };
  let after: { userId: string; service: string } | undefined;
  for (;;) {
    const rows = await deps.db
      .select({
        userId: userCredentials.userId,
        service: userCredentials.service,
        encrypted: userCredentials.encrypted,
      })
      .from(userCredentials)
      .where(
        after &&
          or(
            gt(userCredentials.userId, after.userId),
            and(
              eq(userCredentials.userId, after.userId),
              gt(userCredentials.service, after.service),
            ),
          ),
      )
      .orderBy(asc(userCredentials.userId), asc(userCredentials.service))
      .limit(batchSize);
    for (const row of rows) {
      const options = encryptionOptions(deps, row.userId, row.service);
      const decrypted = decryptCredentials(row.encrypted, options);
      if (!decrypted.ok) {
        if (decrypted.reason === "unknown-key") result.unreadable.unknownKey += 1;
        else result.unreadable.corrupt += 1;
        continue;
      }
      if (kidOf(row.encrypted) === encryptionKid(options.secrets, options.kind)) continue;
      const encrypted = encryptCredentials(decrypted.credentials, options);
      const updated = await deps.db
        .update(userCredentials)
        .set({ encrypted })
        .where(
          and(
            eq(userCredentials.userId, row.userId),
            eq(userCredentials.service, row.service),
            eq(userCredentials.encrypted, row.encrypted),
          ),
        )
        .returning({ service: userCredentials.service });
      if (updated.length === 0) result.raced += 1;
      result.reencrypted += updated.length;
    }
    const last = rows.at(-1);
    if (!last || rows.length < batchSize) return result;
    after = { userId: last.userId, service: last.service };
  }
}

/** Inserts or replaces the user's credentials for `service`. */
export async function saveCredentials(
  deps: Deps,
  userId: string,
  { service, fields, hint, verified }: CredentialSummary & { fields: Credentials },
) {
  const encrypted = encryptCredentials(fields, encryptionOptions(deps, userId, service));
  await deps.db
    .insert(userCredentials)
    .values({ userId, service, encrypted, hint, verified })
    .onConflictDoUpdate({
      target: [userCredentials.userId, userCredentials.service],
      set: { encrypted, hint, verified, updatedAt: new Date() },
    });
}

export async function deleteCredentials(deps: Deps, userId: string, service: string) {
  await deps.db
    .delete(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.service, service)));
}

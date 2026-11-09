import { and, asc, eq, inArray, isNull, not, or, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import { isUniqueViolation } from "@botsdk/bot/lib/unique-violation";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { rpcError } from "@botsdk/bot/rpc-error";
import type { Transaction } from "@botsdk/bot/plugin";
import {
  type FixedProfileField,
  fixedProfileFields,
  type ProfileFieldView,
  type ProfileSource,
  type ProfileStatus,
  isTimeZone,
  maxProfileValueLength,
  type ProfileValueView,
} from "../shared/contract";
import { grouped } from "./customers";
import {
  representativeCustomerIdentity,
  representativeCustomerMerge,
  representativeProfileField,
  representativeProfileValue,
  representativeThreadMessage,
} from "./db/schema";

/*
 * A Customer's typed profile (ticket #1280): the fixed fields and the owner's own, each value with
 * its source, status and date. Every read and write starts from the owner's id, and a Customer or
 * field of someone else's is "not found".
 *
 * A merge leaves the absorbed Customer's values where they are (ticket #1286), and the survivor reads
 * both: `combinedProfilesOf` is that read, and `profilesOf` each Customer's own. An owner clearing a
 * value that a merge could bring back stores it empty: that hides what the merge brought, older than
 * it, and is no value to anyone reading.
 */

type Context = Pick<FeatureContext, "db">;
type Db = Context["db"] | Transaction;

const fieldNameIndex = "representative_profile_field_name";

const fieldNotFound = () =>
  rpcError("NOT_FOUND", "error.profileFieldNotFound", "Profile field not found");
const fieldTaken = () =>
  rpcError("CONFLICT", "error.profileFieldTaken", "You already have a profile field of that name");

const isFixed = (field: string): field is FixedProfileField =>
  (fixedProfileFields as readonly string[]).includes(field);

/** A Customer's name among their profile values; null without one. */
export const nameIn = (profile: ProfileValueView[] | undefined) =>
  profile?.find(({ field }) => field === "name")?.value ?? null;

type ValueRow = typeof representativeProfileValue.$inferSelect;

const fieldOf = (row: ValueRow) => (row.fixedField ?? row.fieldId)!;

/** The row an owner's clearing leaves where a merge could bring the value back. It reads as nothing. */
const isCleared = (row: { value: string }) => row.value === "";

const viewOf = (row: ValueRow): ProfileValueView => ({
  field: fieldOf(row),
  value: row.value,
  source: row.source,
  status: row.status,
  recordedAt: row.recordedAt,
});

/** The rows of `userId`'s Customers named by `customerIds`, oldest first, what's cleared too. */
const valueRowsOf = (db: Db, userId: string, customerIds: string[]) =>
  db
    .select()
    .from(representativeProfileValue)
    .where(
      and(
        eq(representativeProfileValue.userId, userId),
        inArray(representativeProfileValue.customerId, customerIds),
      ),
    )
    .orderBy(asc(representativeProfileValue.recordedAt), asc(representativeProfileValue.id));

/** Each Customer's own profile values, oldest first, whatever is merged into it. */
export async function profilesOf(db: Db, userId: string, customerIds: string[]) {
  const rows = await valueRowsOf(db, userId, customerIds);
  const byCustomer = grouped(
    rows.filter((row) => !isCleared(row)),
    (row) => row.customerId,
  );
  return new Map([...byCustomer].map(([id, values]) => [id, values.map(viewOf)] as const));
}

type StandingMerge = {
  absorbedId: string;
  survivorId: string;
  mergedAt: Date;
  threadIds: string[];
  identityIds: string[];
};

/** The owner's merges that stand, which make each survivor's tree of Customers. */
export const standingMergesOf = (db: Db, userId: string): Promise<StandingMerge[]> =>
  db
    .select({
      absorbedId: representativeCustomerMerge.absorbedCustomerId,
      survivorId: representativeCustomerMerge.survivorCustomerId,
      mergedAt: representativeCustomerMerge.createdAt,
      threadIds: representativeCustomerMerge.threadIds,
      identityIds: representativeCustomerMerge.identityIds,
    })
    .from(representativeCustomerMerge)
    .where(
      and(
        eq(representativeCustomerMerge.userId, userId),
        isNull(representativeCustomerMerge.undoneAt),
      ),
    );

/** A Customer and everyone merged into it, by the merges that stand, however many steps away. */
export function memberIds(merges: StandingMerge[], customerId: string): string[] {
  const absorbed = merges.filter((each) => each.survivorId === customerId);
  return [customerId, ...absorbed.flatMap((each) => memberIds(merges, each.absorbedId))];
}

/**
 * The values a Customer can read, its own first. A value it cleared hides what its absorbed Customers
 * hold of that field, unless they were merged in after it, or it is `confirmed` since. A claim can't
 * bring it back. It hides nothing of a Customer this one was itself merged into.
 */
function valuesReadBy(
  merges: StandingMerge[],
  rows: Map<string, ValueRow[]>,
  customerId: string,
): ValueRow[] {
  const own = rows.get(customerId) ?? [];
  const clearedAt = new Map(own.filter(isCleared).map((row) => [fieldOf(row), row.recordedAt]));
  const absorbed = merges
    .filter((each) => each.survivorId === customerId)
    .flatMap(({ absorbedId, mergedAt }) =>
      valuesReadBy(merges, rows, absorbedId).filter((row) => {
        const at = clearedAt.get(fieldOf(row));
        return !at || mergedAt > at || (row.recordedAt > at && row.status === "confirmed");
      }),
    );
  return [...own.filter((row) => !isCleared(row)), ...absorbed];
}

/** One value per field: `confirmed` beats `claimed`, then the newest, then the first given. */
function winners(rows: ValueRow[]) {
  const byField = new Map<string, ValueRow>();
  for (const row of rows) {
    const best = byField.get(fieldOf(row));
    const beats =
      !best ||
      (row.status === best.status ? row.recordedAt > best.recordedAt : row.status === "confirmed");
    if (beats) byField.set(fieldOf(row), row);
  }
  return [...byField.values()].sort(
    (one, other) => one.recordedAt.getTime() - other.recordedAt.getTime(),
  );
}

/**
 * What each of the owner's Customers named by `customerIds` reads as its profile, by Customer: its own
 * values and those of everyone merged into it, one per field, oldest first. It is the read for a
 * Customer as it stands today: the owner's view and a Turn's memory both use it.
 */
export async function combinedProfilesOf(db: Db, userId: string, customerIds: string[]) {
  const merges = await standingMergesOf(db, userId);
  const members = customerIds.flatMap((id) => memberIds(merges, id));
  const rows = grouped(await valueRowsOf(db, userId, members), (row) => row.customerId);
  return new Map(
    customerIds.map((id) => [id, winners(valuesReadBy(merges, rows, id)).map(viewOf)] as const),
  );
}

/**
 * Every value held of a Customer as it stands today, and the Customers it is made of: its own and
 * those merged into it, however many steps away, winners and losers alike, and what the survivor
 * corrected too. A lesson is checked against all of it (ticket #1289). The Customers are returned so
 * that the addresses a merge moved can be read as well.
 */
export async function knownValuesOf(db: Db, userId: string, customerId: string) {
  const merges = await standingMergesOf(db, userId);
  const members = memberIds(merges, survivorOf(merges, customerId));
  const rows = await valueRowsOf(db, userId, members);
  return {
    customerIds: members,
    values: rows.filter((row) => !isCleared(row)).map((row) => row.value),
  };
}

/**
 * The Customer something a merge moved came from: where it goes back to when each merge that moved it
 * is undone. `moved` says whether a merge moved it.
 */
function originalCustomerOf(
  merges: StandingMerge[],
  customerId: string,
  moved: (merge: StandingMerge) => boolean,
): string {
  const step = merges.find((each) => each.survivorId === customerId && moved(each));
  return step ? originalCustomerOf(merges, step.absorbedId, moved) : customerId;
}

/** The survivor a Customer has been merged into, however many steps up, or the Customer itself. */
function survivorOf(merges: StandingMerge[], customerId: string): string {
  const merged = merges.find((each) => each.absorbedId === customerId);
  return merged ? survivorOf(merges, merged.survivorId) : customerId;
}

/**
 * Sets a value of a Customer the caller already holds as `confirmed` by the owner, over whatever was
 * there, or clears it when empty. An own field is held too, so a concurrent removal can't lose it.
 * With a Customer merged into this one, clearing keeps the row, empty, so that what's merged in doesn't
 * show through. It is the survivor's correction, so an undo leaves it.
 */
export async function setOwnerValue(
  tx: Transaction,
  now: Date,
  userId: string,
  customerId: string,
  field: string,
  value: string,
) {
  const fixed = isFixed(field);
  if (!fixed) {
    const [own] = await tx
      .select({ id: representativeProfileField.id })
      .from(representativeProfileField)
      .where(
        and(
          eq(representativeProfileField.id, field),
          eq(representativeProfileField.userId, userId),
        ),
      )
      .for("share");
    if (!own) throw fieldNotFound();
  }
  const column = fixed ? representativeProfileValue.fixedField : representativeProfileValue.fieldId;
  if (value === "") {
    const merges = await standingMergesOf(tx, userId);
    if (!merges.some((each) => each.survivorId === customerId)) {
      await tx
        .delete(representativeProfileValue)
        .where(and(eq(representativeProfileValue.customerId, customerId), eq(column, field)));
      return;
    }
  }
  const written = { value, source: "owner", status: "confirmed", recordedAt: now } as const;
  await tx
    .insert(representativeProfileValue)
    .values({
      id: uuidv7(),
      userId,
      customerId,
      ...(fixed ? { fixedField: field } : { fieldId: field }),
      ...written,
    })
    .onConflictDoUpdate({ target: [representativeProfileValue.customerId, column], set: written });
}

/** The owner's own fields, oldest first. */
export function listProfileFields({ db }: Context, userId: string): Promise<ProfileFieldView[]> {
  return db
    .select({ id: representativeProfileField.id, name: representativeProfileField.name })
    .from(representativeProfileField)
    .where(eq(representativeProfileField.userId, userId))
    .orderBy(asc(representativeProfileField.id));
}

/** Fixed fields are named in the Customer view by these, so an own field can't take one. */
const refuseFixedName = (name: string) => {
  if (isFixed(name.toLowerCase().replaceAll(" ", "_"))) throw fieldTaken();
};

export async function addProfileField({ db }: Context, userId: string, name: string) {
  refuseFixedName(name);
  try {
    const [field] = await db
      .insert(representativeProfileField)
      .values({ id: uuidv7(), userId, name })
      .returning({ id: representativeProfileField.id, name: representativeProfileField.name });
    return field!;
  } catch (error) {
    if (isUniqueViolation(error, fieldNameIndex)) throw fieldTaken();
    throw error;
  }
}

export async function renameProfileField(
  { db }: Context,
  userId: string,
  { id, name }: { id: string; name: string },
) {
  refuseFixedName(name);
  try {
    const [field] = await db
      .update(representativeProfileField)
      .set({ name })
      .where(
        and(eq(representativeProfileField.id, id), eq(representativeProfileField.userId, userId)),
      )
      .returning({ id: representativeProfileField.id, name: representativeProfileField.name });
    if (!field) throw fieldNotFound();
    return field;
  } catch (error) {
    if (isUniqueViolation(error, fieldNameIndex)) throw fieldTaken();
    throw error;
  }
}

/** Removes the field; every Customer's value of it goes with it (the foreign key cascades). */
export async function removeProfileField({ db }: Context, userId: string, id: string) {
  const removed = await db
    .delete(representativeProfileField)
    .where(
      and(eq(representativeProfileField.id, id), eq(representativeProfileField.userId, userId)),
    )
    .returning({ id: representativeProfileField.id });
  if (removed.length === 0) throw fieldNotFound();
}

export function exportProfileFields(tx: Transaction, userId: string) {
  return tx
    .select({
      id: representativeProfileField.id,
      name: representativeProfileField.name,
      createdAt: representativeProfileField.createdAt,
    })
    .from(representativeProfileField)
    .where(eq(representativeProfileField.userId, userId))
    .orderBy(asc(representativeProfileField.id));
}

export async function deleteProfileFields(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(representativeProfileField).where(eq(representativeProfileField.userId, userId));
}

/**
 * Which stored value a pass's write may replace, in one statement, so a row that committed after the
 * pass last read still counts. A `confirmed` owner value stays, and any `confirmed` value against a
 * claim. An owner's clearing is written over, except by a claim on a survivor: it would stop hiding
 * what's merged in, which that claim might lose to.
 */
function passMayReplace(status: ProfileStatus, onSurvivor: boolean): SQL {
  const value = representativeProfileValue;
  const confirmed = eq(value.status, "confirmed");
  if (status === "claimed") {
    return onSurvivor ? not(confirmed) : or(eq(value.value, ""), not(confirmed))!;
  }
  return or(eq(value.value, ""), not(and(confirmed, eq(value.source, "owner"))!))!;
}

/** What the pass proposed for one profile value: a field by name, its value, and the line it cites. */
export type ProfileOperation = { field: string; value: string; line: number };

const profileOperation = z.object({
  field: z.string(),
  value: z.string(),
  line: z.number().int(),
});

/** The most operations one thread's reply can carry; the rest are dropped. */
const maxPassOperations = 20;

/** Reads the Model's JSON array of operations. A reply that isn't one, and any entry that isn't one, gives nothing. */
export function parseProfileOperations(text: string): ProfileOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, maxPassOperations).flatMap((entry) => {
    const result = profileOperation.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

/**
 * Writes what the pass proposed, holding the thread and its Customer, as the caller does. Code decides every
 * value's status, not the Model: `confirmed` only if the line it cites has a Customer as its author
 * that message was verified, and it says the value (a row's `verified` means something else on an owner's, and is true by
 * default). A line that isn't in the thread, or a field that isn't there, drops
 * the operation. A `confirmed` owner value is never overwritten, nor any `confirmed` value by a `claimed` one.
 *
 * A merge moves threads and identities, not what was said, so each value goes where undoing would leave
 * it: to the Customer the cited line's sender came from, or for a line with no such sender, the one the
 * thread came from. An owner's `confirmed` value that the survivor reads can't be beaten through a merge
 * either, and nor can a claim bring back what the owner cleared on a survivor.
 */
export async function writePassValues(
  tx: Transaction,
  {
    userId,
    customerId,
    threadId,
    now,
    operations,
  }: {
    userId: string;
    customerId: string;
    threadId: string;
    now: Date;
    operations: ProfileOperation[];
  },
) {
  if (operations.length === 0) return;
  const own = await tx
    .select({ id: representativeProfileField.id, name: representativeProfileField.name })
    .from(representativeProfileField)
    .where(eq(representativeProfileField.userId, userId))
    .for("share");
  const lines = await tx
    .select({
      position: representativeThreadMessage.position,
      author: representativeThreadMessage.author,
      verified: representativeThreadMessage.verified,
      text: representativeThreadMessage.text,
      channel: representativeThreadMessage.channel,
      externalId: representativeThreadMessage.externalId,
    })
    .from(representativeThreadMessage)
    .where(
      and(
        eq(representativeThreadMessage.threadId, threadId),
        inArray(representativeThreadMessage.author, ["customer", "representative", "owner"]),
      ),
    );
  const merges = await standingMergesOf(tx, userId);
  const threadCustomer = originalCustomerOf(merges, customerId, (each) =>
    each.threadIds.includes(threadId),
  );
  const identities = await tx
    .select({
      id: representativeCustomerIdentity.id,
      customerId: representativeCustomerIdentity.customerId,
      channel: representativeCustomerIdentity.channel,
      externalId: representativeCustomerIdentity.externalId,
    })
    .from(representativeCustomerIdentity)
    .where(eq(representativeCustomerIdentity.userId, userId));
  for (const operation of operations) {
    const name = operation.field.trim().toLowerCase();
    const fixed = fixedProfileFields.find((each) => each === name.replaceAll(" ", "_"));
    const ownField = fixed ? undefined : own.find((each) => each.name.toLowerCase() === name);
    const line = lines.find((each) => each.position === operation.line);
    const value = operation.value.replaceAll("\0", "").trim().slice(0, maxProfileValueLength);
    if ((!fixed && !ownField) || !line || !value) continue;
    // A zone the gate can't read would only be ignored there.
    if (fixed === "time_zone" && !isTimeZone(value)) continue;
    // The Model chooses the line it cites, so the line must also say the value: a verified line can't vouch for a value it doesn't hold.
    // The query above keeps only these three authors, which are the sources a line can give: a
    // phone Call's transcript, which may be mis-heard, gives none.
    const says = line.text.toLowerCase().includes(value.toLowerCase());
    const status = line.author === "customer" && line.verified && says ? "confirmed" : "claimed";
    const column = fixed
      ? representativeProfileValue.fixedField
      : representativeProfileValue.fieldId;
    const key = fixed ?? ownField!.id;
    const sender =
      line.author === "customer"
        ? identities.find(
            (each) => each.channel === line.channel && each.externalId === line.externalId,
          )
        : undefined;
    const valueCustomer = sender
      ? originalCustomerOf(merges, sender.customerId, (each) =>
          each.identityIds.includes(sender.id),
        )
      : threadCustomer;
    const survivorId = survivorOf(merges, valueCustomer);
    const combined = (await combinedProfilesOf(tx, userId, [survivorId])).get(survivorId)!;
    if (
      combined.some(
        (each) => each.field === key && each.source === "owner" && each.status === "confirmed",
      )
    ) {
      continue;
    }
    const written = {
      value,
      source: line.author as ProfileSource,
      status,
      recordedAt: now,
    } as const;
    await tx
      .insert(representativeProfileValue)
      .values({
        id: uuidv7(),
        userId,
        customerId: valueCustomer,
        ...(fixed ? { fixedField: fixed } : { fieldId: key }),
        ...written,
      })
      .onConflictDoUpdate({
        target: [representativeProfileValue.customerId, column],
        set: written,
        // Here and not read first: a row another thread of this Customer has yet to commit isn't seen.
        setWhere: passMayReplace(
          status,
          merges.some((each) => each.survivorId === valueCustomer),
        ),
      });
  }
}

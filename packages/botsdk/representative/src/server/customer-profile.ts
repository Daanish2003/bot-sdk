import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
  maxProfileValueLength,
  type ProfileValueView,
} from "../shared/contract";
import {
  representativeProfileField,
  representativeProfileValue,
  representativeThreadMessage,
} from "./db/schema";

/*
 * A Customer's typed profile (ticket #1280): the fixed fields and the owner's own, each value with
 * its source, status and date. Every read and write starts from the owner's id, and a Customer or
 * field of someone else's is "not found".
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

/**
 * A Customer's name, from their profile, as a column of a query that joins tables: only then does
 * Drizzle qualify `customerId`, which a single-table select leaves to match the subquery's own.
 */
export const customerNameQuery = (customerId: AnyPgColumn) =>
  sql<
    string | null
  >`(select ${representativeProfileValue.value} from ${representativeProfileValue} where ${representativeProfileValue.customerId} = ${customerId} and ${representativeProfileValue.fixedField} = 'name')`;

/** A Customer's name among their profile values; null without one. */
export const nameIn = (profile: ProfileValueView[] | undefined) =>
  profile?.find(({ field }) => field === "name")?.value ?? null;

/** The profile values of `userId`'s Customers named by `customerIds`, oldest first, by Customer. */
export async function profilesOf(db: Db, userId: string, customerIds: string[]) {
  const rows = await db
    .select()
    .from(representativeProfileValue)
    .where(
      and(
        eq(representativeProfileValue.userId, userId),
        inArray(representativeProfileValue.customerId, customerIds),
      ),
    )
    .orderBy(asc(representativeProfileValue.recordedAt), asc(representativeProfileValue.id));
  const byCustomer = new Map<string, ProfileValueView[]>();
  for (const row of rows) {
    const value: ProfileValueView = {
      field: (row.fixedField ?? row.fieldId)!,
      value: row.value,
      source: row.source,
      status: row.status,
      recordedAt: row.recordedAt,
    };
    const values = byCustomer.get(row.customerId);
    if (values) values.push(value);
    else byCustomer.set(row.customerId, [value]);
  }
  return byCustomer;
}

/**
 * Sets a value of a Customer the caller already holds as `confirmed` by the owner, over whatever was
 * there, or clears it when empty. An own field is held too, so a concurrent removal can't lose it.
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
    await tx
      .delete(representativeProfileValue)
      .where(and(eq(representativeProfileValue.customerId, customerId), eq(column, field)));
    return;
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
 * Writes what the pass proposed, under the thread's lock, which the caller holds. Code decides every
 * value's status, not the Model: `confirmed` only if the line it cites has a Customer as its author
 * and that message was verified (a row's `verified` means something else on an owner's, and is true by
 * default). A line that isn't in the thread as the Model saw it, or a field that isn't there, drops
 * the operation. A `confirmed` owner value is never overwritten, nor any `confirmed` value by a `claimed` one.
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
    })
    .from(representativeThreadMessage)
    .where(
      and(
        eq(representativeThreadMessage.threadId, threadId),
        inArray(representativeThreadMessage.author, ["customer", "representative", "owner"]),
      ),
    );
  for (const operation of operations) {
    const name = operation.field.trim().toLowerCase();
    const fixed = fixedProfileFields.find((each) => each === name.replaceAll(" ", "_"));
    const ownField = fixed ? undefined : own.find((each) => each.name.toLowerCase() === name);
    const line = lines.find((each) => each.position === operation.line);
    const value = operation.value.replaceAll("\0", "").trim().slice(0, maxProfileValueLength);
    if ((!fixed && !ownField) || !line || !value) continue;
    const status = line.author === "customer" && line.verified ? "confirmed" : "claimed";
    const column = fixed
      ? representativeProfileValue.fixedField
      : representativeProfileValue.fieldId;
    const key = fixed ?? ownField!.id;
    const [existing] = await tx
      .select({
        source: representativeProfileValue.source,
        status: representativeProfileValue.status,
      })
      .from(representativeProfileValue)
      .where(and(eq(representativeProfileValue.customerId, customerId), eq(column, key)));
    if (existing?.status === "confirmed" && (existing.source === "owner" || status === "claimed")) {
      continue;
    }
    const written = { value, source: "customer", status, recordedAt: now } as const;
    await tx
      .insert(representativeProfileValue)
      .values({
        id: uuidv7(),
        userId,
        customerId,
        ...(fixed ? { fixedField: fixed } : { fieldId: key }),
        ...written,
      })
      .onConflictDoUpdate({
        target: [representativeProfileValue.customerId, column],
        set: written,
      });
  }
}

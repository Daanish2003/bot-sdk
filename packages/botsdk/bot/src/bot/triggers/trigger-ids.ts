import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

/*
 * The ids of the Triggers a Routine's or a Check-in's fire hands the Router, which are also their
 * jobs' keys. They live here, below the routines module, so the Router can tell whose a Trigger is.
 */

/**
 * How every fire key of Routine `routineId` starts (a scheduled slot's or a webhook delivery's);
 * given a column, the SQL that builds it from the column's value.
 */
export function fireKeyPrefix(routineId: string): string;
export function fireKeyPrefix(routineId: SQLWrapper): SQL;
export function fireKeyPrefix(routineId: string | SQLWrapper): string | SQL {
  return typeof routineId === "string"
    ? `routine:${routineId}:`
    : sql`'routine:' || ${routineId} || ':'`;
}

/** The Routine a fire's key (see `fireKeyPrefix`) belongs to. */
export function routineOfFireKey(key: string): string {
  return key.split(":")[1]!;
}

/** The key of a Check-in's job, which is also the ID of the Trigger it hands the Router. */
export const checkInKey = (checkInId: string) => `check_in:${checkInId}`;

/** The Check-in whose key (see `checkInKey`) `key` is, or `undefined` when it is none. */
export function checkInOfKey(key: string): string | undefined {
  return key.startsWith("check_in:") ? key.slice("check_in:".length) : undefined;
}

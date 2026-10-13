/** What a banned user sees when they try to sign in, by email or OAuth (spec #277): nothing more. */
export const suspendedMessage = "This account is suspended.";

/**
 * Whether a user's Ban holds at `now` (spec #277): banned, and not past its end date. A Ban with
 * no end date holds until it is lifted.
 */
export function isBanActive(
  user: { banned: boolean | null; banExpires: Date | null },
  now: Date,
): boolean {
  return (
    user.banned === true && (user.banExpires === null || user.banExpires.getTime() > now.getTime())
  );
}

/**
 * The moment a Ban ends for an end date the Admin picked (`YYYY-MM-DD`, UTC): the start of the next
 * day, so the Ban covers the whole chosen day. `null` (no date) is a Ban for good.
 */
export function banEndsAt(endsOn: string | null): Date | null {
  if (endsOn === null) return null;
  return new Date(Date.parse(`${endsOn}T00:00:00Z`) + 24 * 60 * 60 * 1000);
}

/** Whether `value` is a real calendar date in `YYYY-MM-DD` form (`2026-02-31` is not). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

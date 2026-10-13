/** One row of the Admin users table: a user, with this window's spend against their Quota. */
export type AdminUser = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  signInMethods: string[];
  role: string | null;
  /** Whether a Ban holds now (spec #277): a Ban past its end date no longer counts. */
  banned: boolean;
  /** When the Ban that holds ends (ISO), or `null` for no end date or no Ban. */
  banExpires: string | null;
  /** Whether two-factor sign-in is on (spec #277): the Admin can turn it off for a lost authenticator. */
  twoFactorEnabled: boolean;
  spentMicros: number;
  /** `null` when the user's Quota is unlimited. */
  budgetMicros: number | null;
};

export type UserQuery = {
  /** Matches a part of the email, ignoring case. */
  search?: string;
  sort: "email" | "spend";
  /** Only users whose spend has reached their budget. */
  atQuota: boolean;
};

/** The users the table shows for a query: filtered, then sorted (spend highest first). */
export function selectUsers(users: AdminUser[], query: UserQuery): AdminUser[] {
  const search = query.search?.trim().toLowerCase() ?? "";
  const matching = users.filter(
    (candidate) =>
      candidate.email.toLowerCase().includes(search) && (!query.atQuota || isAtQuota(candidate)),
  );
  return matching.sort((a, b) =>
    query.sort === "spend" ? b.spentMicros - a.spentMicros : a.email.localeCompare(b.email),
  );
}

/** Spend has reached a budget. An unlimited user is never at Quota. */
export function isAtQuota(candidate: AdminUser): boolean {
  return candidate.budgetMicros !== null && candidate.spentMicros >= candidate.budgetMicros;
}

/** The UTC day or calendar month `now` falls in, from its first instant (the Quota window). */
export function windowStart(window: "day" | "month", now: Date): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return window === "day"
    ? new Date(Date.UTC(year, month, now.getUTCDate()))
    : new Date(Date.UTC(year, month, 1));
}

/** Millionths of a dollar, as dollars with cents. */
export function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

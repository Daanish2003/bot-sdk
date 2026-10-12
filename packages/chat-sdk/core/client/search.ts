import type { AppRouterClient } from "../server/routers/index";

export type SearchHit = Awaited<ReturnType<AppRouterClient["search"]["query"]>>["hits"][number];

/** A hit's snippet cut into the text before, of and after the match, for a plain-text `<mark>`. */
export function splitSnippet({ text, match }: SearchHit["snippet"]) {
  return {
    before: text.slice(0, match.start),
    match: text.slice(match.start, match.end),
    after: text.slice(match.end),
  };
}

/**
 * The palette's Recent group: the newest 6 Conversations, or with a query, up to 20 whose title
 * contains it (case-insensitive; an untitled one is "Untitled").
 */
export function recentConversations<T extends { title: string | null }>(
  conversations: T[],
  q: string,
) {
  const needle = q.trim().toLowerCase();
  if (!needle) return conversations.slice(0, 6);
  return conversations
    .filter((c) => (c.title ?? "Untitled").toLowerCase().includes(needle))
    .slice(0, 20);
}

/**
 * The search's date filter as ISO instants, from the picked days (`YYYY-MM-DD`, the user's local
 * time zone). `from` is local midnight of the first day; `to` is local midnight after the last day,
 * since the server's `to` is exclusive. A missing end stays open.
 */
export function localDayRange(
  fromDay: string | undefined,
  toDay: string | undefined,
): { from?: string; to?: string } {
  const range: { from?: string; to?: string } = {};
  if (fromDay) range.from = localMidnight(fromDay, 0).toISOString();
  if (toDay) range.to = localMidnight(toDay, 1).toISOString();
  return range;
}

/** Local midnight of the `YYYY-MM-DD` day, moved forward by `dayOffset` days. */
function localMidnight(day: string, dayOffset: number) {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date + dayOffset);
}

/**
 * What opening a search hit does next: highlight the Message once it's on screen, wait while the
 * Active Branch has it but the screen doesn't yet, or switch to the Branch through it.
 */
export function focusStep(
  target: string,
  onScreen: string[],
  activeBranch: string[],
): "highlight" | "wait" | "switch" {
  if (onScreen.includes(target)) return "highlight";
  if (activeBranch.includes(target)) return "wait";
  return "switch";
}

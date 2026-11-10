import { z } from "zod";

/** How urgent a Page is: only an emergency may wake the user. */
export const pageUrgencies = ["routine", "emergency"] as const;

export type PageUrgency = (typeof pageUrgencies)[number];

/** A Page (ticket #1300) as the RPCs return it: one the user hasn't acknowledged. */
export type PageRow = {
  id: string;
  /** What raised it, in the words of whoever raised it, such as `assignment_overdue`. */
  cause: string;
  urgency: PageUrgency;
  title: string;
  text: string;
  /** Where in the Host app it leads. */
  path: string;
  createdAt: Date;
};

/** Names one of the user's Pages. */
export const pageIdInput = z.object({ id: z.uuid() });

/** What `pages.list` returns: the Pages shown, and whether more waited than it shows. */
export type PagesList = { pages: PageRow[]; truncated: boolean };

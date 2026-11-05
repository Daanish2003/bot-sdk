import { type PageRow, pageIdInput, type PageUrgency } from "@botsdk/client/bot/pages";
import { oneLine } from "@botsdk/client/message-format";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { uuidv7 } from "../lib/uuidv7";
import type { BotSdkContext, Transaction } from "../plugin";
import { parseInput, rpcError, type WithUser } from "../rpc-error";
import { page } from "../storage";

/*
 * Pages (ticket #1300, ADR 0029's amendment): a direct alert to the owner outside the app. A feature
 * raises one through the `pages` core service, and the owner reads and acknowledges it through the
 * `pages` namespace. Raising one needs no Conversation, makes no model call and never looks at the
 * Quota, so it still goes out when the Quota is what went wrong.
 */

type PageInput = {
  userId: string;
  /** What raised it, such as `assignment_overdue`, kept on the Page. */
  cause: string;
  urgency: PageUrgency;
  /** A push's title and an email's subject: its first line, cut to 120 characters. */
  title: string;
  /** Markdown, as a Bot Message's text is, cut to 2,000 characters. */
  text: string;
  /** Where in the Host app it leads, from the root: anything else throws. */
  path: string;
};

/** What a feature's `needs: ["pages"]` gives it. */
export type PagesService = {
  /**
   * Raises a Page for `userId`, in the caller's transaction, so it goes out only if that commits.
   * It goes at once to web push and the user's Linked identities, then to email after 10 minutes if
   * it is still not acknowledged.
   */
  send: (tx: Transaction, input: PageInput) => Promise<{ id: string }>;
  /**
   * `send`, unless a Page of this cause went to `userId` in the last day, acknowledged or not: then
   * null, and nothing goes. Sends racing for one cause wait for each other until `tx` ends.
   */
  sendDaily: (tx: Transaction, input: PageInput) => Promise<{ id: string } | null>;
};

/**
 * The longest a Page's title and text are. Cut rather than refused, so a long name can't stop an
 * alert. Short enough for a push's small payload, and for one message on a messaging Channel: a Page
 * is never split, so a failed send never leaves part of one out for the retry to repeat.
 */
const maxTitleLength = 120;
const maxTextLength = 2000;

const cut = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

const dayMs = 24 * 60 * 60_000;

/** The `pages` service. */
export function pagesService(deps: BotSdkContext): PagesService {
  const send: PagesService["send"] = async (tx, { userId, title, text, path, ...input }) => {
    // Channels put it straight after the app's URL, where anything else could change the host.
    if (!path.startsWith("/")) throw new Error(`A Page's path must be from the app's root`);
    const id = uuidv7();
    await tx.insert(page).values({
      id,
      userId,
      ...input,
      title: cut(oneLine(title), maxTitleLength),
      text: cut(text, maxTextLength),
      path,
      createdAt: deps.clock(),
    });
    await deps.channels.pageIn(tx, { id, userId, urgency: input.urgency });
    return { id };
  };
  return {
    send,
    sendDaily: async (tx, input) => {
      const { userId, cause } = input;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`page:${userId}:${cause}`}, 0))`,
      );
      const since = new Date(deps.clock().getTime() - dayMs);
      const [recent] = await tx
        .select({ id: page.id })
        .from(page)
        .where(and(eq(page.userId, userId), eq(page.cause, cause), gt(page.createdAt, since)))
        .limit(1);
      return recent ? null : send(tx, input);
    },
  };
}

/** The most Pages the list shows. */
const maxListed = 50;

/** The `pages` namespace over the core context. */
export function pagesApi(sdk: BotSdkContext) {
  return {
    /**
     * The user's Pages they haven't acknowledged, emergencies first and each newest first, so the
     * limit never takes an emergency for the sake of newer routine ones.
     */
    list: async ({ userId }: { userId: string }): Promise<PageRow[]> =>
      sdk.db
        .select({
          id: page.id,
          cause: page.cause,
          urgency: page.urgency,
          title: page.title,
          text: page.text,
          path: page.path,
          createdAt: page.createdAt,
        })
        .from(page)
        .where(and(eq(page.userId, userId), isNull(page.acknowledgedAt)))
        .orderBy(
          sql`case when ${page.urgency} = 'emergency' then 0 else 1 end`,
          desc(page.createdAt),
          desc(page.id),
        )
        .limit(maxListed),

    /**
     * Acknowledges the user's Page, which stops whatever it hasn't sent yet. Repeating it changes
     * nothing; another user's Page is NOT_FOUND.
     */
    acknowledge: async ({ userId, ...rest }: WithUser<typeof pageIdInput>): Promise<void> => {
      const { id } = parseInput(pageIdInput, rest);
      const [row] = await sdk.db
        .update(page)
        .set({
          acknowledgedAt: sql`coalesce(${page.acknowledgedAt}, ${sql.param(sdk.clock(), page.acknowledgedAt)})`,
        })
        .where(and(eq(page.id, id), eq(page.userId, userId)))
        .returning({ id: page.id });
      if (!row) throw rpcError("NOT_FOUND", "error.pageNotFound", "Page not found");
    },
  };
}

/** The `pages` namespace's domain methods. */
export type PagesApi = ReturnType<typeof pagesApi>;

/** The user's Pages in their export, oldest first, acknowledged or not. */
export async function exportPages(tx: Transaction, userId: string) {
  return tx
    .select({
      id: page.id,
      cause: page.cause,
      urgency: page.urgency,
      title: page.title,
      text: page.text,
      path: page.path,
      createdAt: page.createdAt,
      acknowledgedAt: page.acknowledgedAt,
    })
    .from(page)
    .where(eq(page.userId, userId))
    .orderBy(asc(page.createdAt), asc(page.id));
}

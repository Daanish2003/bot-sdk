import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { OutboundMail } from "@botsdk/bot/channel/internal";
import type { FeatureContext, PublicRoute } from "@botsdk/bot/feature";
import { type ChannelOf, signed, signedByKeyring } from "./customer-proof";
import { holdThreadCustomer } from "./customers";
import { representative, representativeCustomerIdentity, representativeThread } from "./db/schema";
import { markOptedOut, optOut } from "./opt-out";
import type { ViaChannel } from "./outbound-gate";

/*
 * A Customer unsubscribes from a Representative's email (ticket #1349). Every mail to one carries a
 * `List-Unsubscribe` header with one-click POST (RFC 8058) and a footer link, both to a public route
 * that takes a token signed for the Customer's email identity and the Representative. Using it opts the
 * identity out, as a keyword would, and the Outbound gate's opt-out rule does the rest.
 */

const emailChannel = "email";
const unsubscribePath = "/representative/unsubscribe/:token";

const tokenOf = (secret: string, identityId: string, representativeId: string) =>
  `${identityId}.${representativeId}.${signed(secret, "unsubscribe", `${identityId}.${representativeId}`)}`;

/**
 * `mail` with the unsubscribe headers and footer for its recipient, who must have an email identity
 * under the Representative's owner and the Host must have given `linkUrl`; otherwise it is returned as it is.
 */
export async function withUnsubscribe(
  { db, keyring, linkUrl }: Pick<FeatureContext, "db" | "keyring"> & { linkUrl?: string },
  representativeId: string,
  mail: OutboundMail,
): Promise<OutboundMail> {
  const base = linkUrl?.replace(/\/+$/, "");
  if (!base) return mail;
  const [found] = await db
    .select({ id: representativeCustomerIdentity.id })
    .from(representativeCustomerIdentity)
    .innerJoin(representative, eq(representative.userId, representativeCustomerIdentity.userId))
    .where(
      and(
        eq(representative.id, representativeId),
        eq(representativeCustomerIdentity.channel, emailChannel),
        eq(representativeCustomerIdentity.externalId, mail.to),
      ),
    );
  if (!found) return mail;
  const url = `${base}${unsubscribePath.replace(":token", tokenOf(keyring[0]!, found.id, representativeId))}`;
  return {
    ...mail,
    text: `${mail.text}\n\n--\nDon't want these emails? Unsubscribe: ${url}`,
    headers: {
      ...mail.headers,
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * Opts out the identity a token was signed for, as its Customer's `STOP` would. False for a forged,
 * altered or otherwise unreadable token, and for an identity or Representative gone. An identity out
 * already is a success.
 */
export async function unsubscribe(
  {
    db,
    keyring,
    clock,
    jobs,
    channel,
  }: Pick<FeatureContext, "db" | "keyring" | "clock" | "jobs"> & ViaChannel,
  token: string,
): Promise<boolean> {
  const [rawIdentity, rawRepresentative, signature, extra] = token.split(".");
  const identityId = z.uuid().safeParse(rawIdentity);
  const representativeId = z.uuid().safeParse(rawRepresentative);
  if (!identityId.success || !representativeId.success || !signature || extra !== undefined) {
    return false;
  }
  if (
    !signedByKeyring(
      keyring,
      "unsubscribe",
      `${identityId.data}.${representativeId.data}`,
      signature,
    )
  ) {
    return false;
  }
  const now = clock();
  return db.transaction(async (tx) => {
    // The Representative's row, then the Customer's and the identity's, and the thread's last: the
    // order a Customer's message takes them in.
    const [owner] = await tx
      .select({ userId: representative.userId })
      .from(representative)
      .where(eq(representative.id, representativeId.data))
      .for("key share");
    if (!owner) return false;
    const [identity] = await tx
      .select({
        customerId: representativeCustomerIdentity.customerId,
        externalId: representativeCustomerIdentity.externalId,
      })
      .from(representativeCustomerIdentity)
      .where(
        and(
          eq(representativeCustomerIdentity.id, identityId.data),
          eq(representativeCustomerIdentity.userId, owner.userId),
          eq(representativeCustomerIdentity.channel, emailChannel),
        ),
      );
    if (!identity) return false;
    const heard = { channel: emailChannel, externalId: identity.externalId };
    const [thread] = await tx
      .select({ id: representativeThread.id })
      .from(representativeThread)
      .where(
        and(
          eq(representativeThread.customerId, identity.customerId),
          eq(representativeThread.representativeId, representativeId.data),
        ),
      )
      .orderBy(desc(representativeThread.updatedAt))
      .limit(1);
    if (thread && (await holdThreadCustomer(tx, thread.id))) {
      await optOut({ jobs, channel }, tx, {
        userId: owner.userId,
        threadId: thread.id,
        heard,
        verified: false,
        source: "link",
        now,
      });
    } else {
      await markOptedOut(tx, owner.userId, heard, "link", now);
    }
    return true;
  });
}

const page = (status: number, body: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Unsubscribe</title>${body}`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

/**
 * The unsubscribe link's page. Opening it asks for a click, as a mail scanner follows every link; the
 * click, or a mail client's one-click POST, opts out.
 */
export const unsubscribeRoutes = (channelOf: ChannelOf): PublicRoute<"channelAccounts">[] => [
  {
    method: "GET",
    path: unsubscribePath,
    handle: async () =>
      page(
        200,
        '<p>Stop getting emails from this business?</p><form method="post"><button>Unsubscribe</button></form>',
      ),
  },
  {
    method: "POST",
    path: unsubscribePath,
    handle: async (_request, { context, params }) =>
      (await unsubscribe({ ...context, channel: channelOf(context) }, params.token ?? ""))
        ? page(200, "<p>You're unsubscribed. You won't get any more emails from this business.</p>")
        : page(410, "<p>This link isn't valid.</p>"),
  },
];

/** Sends `mail` to a Customer of the Representative, with the unsubscribe headers and footer (every mail to one has them). */
export async function sendCustomerMail(
  context: Pick<FeatureContext<"channelAccounts">, "db" | "keyring" | "channelAccounts"> & {
    linkUrl?: string;
  },
  representativeId: string,
  mail: OutboundMail,
) {
  await context.channelAccounts.sendEmail(await withUnsubscribe(context, representativeId, mail));
}

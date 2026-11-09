import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { channelAccount } from "@botsdk/bot/storage";
import { rpcError } from "@botsdk/bot/rpc-error";
import { defaultVoiceGreeting, type VoiceAccountSecret } from "../shared/contract";
import { channelAccountsView, connectChannelAccount, type Context } from "./channel-accounts";
import { representativeChannelAccount } from "./db/schema";
import { requireOwned } from "./representatives";
import { voiceNumber, voicePlatform } from "./voice-adapter";

/*
 * A Representative's voice account (ticket #1381, ADR 0036): a Channel account on the `voice`
 * platform, held like any other. Its credentials are the number Customers call, the greeting, and the
 * secret the Voice agent's hooks send as a bearer token. The secret is made here, returned once, and
 * kept only in the account's encrypted credentials, under the ADR 0010 keyring.
 */

const newSecret = () => randomBytes(32).toString("base64url");

/**
 * Connects a voice account for the number, or replaces the owner's account on it, with a new secret.
 * A badly formed number is refused before anything is saved. Returns the owner's view and the secret,
 * which nothing shows again.
 */
export async function connectVoiceAccount(
  context: Context,
  input: {
    userId: string;
    representativeId: string;
    number: string;
    greeting?: string;
    linkUrl?: string;
  },
): Promise<VoiceAccountSecret> {
  const { userId, representativeId, linkUrl } = input;
  const number = voiceNumber(input.number);
  if (!number) {
    throw rpcError(
      "BAD_REQUEST",
      "error.voiceNumberInvalid",
      "The number isn't in E.164 format, such as +15551234567",
    );
  }
  const secret = newSecret();
  await connectChannelAccount(context, {
    userId,
    representativeId,
    platform: voicePlatform,
    credentials: { number, greeting: input.greeting || defaultVoiceGreeting, secret },
  });
  return { secret, view: await channelAccountsView(context, userId, representativeId, linkUrl) };
}

/**
 * Replaces a voice account's secret at once, keeping its number and greeting. Refused when the
 * Representative doesn't hold such an account.
 */
export async function regenerateVoiceSecret(
  context: Context,
  input: { userId: string; representativeId: string; channelAccountId: string; linkUrl?: string },
): Promise<VoiceAccountSecret> {
  const { userId, representativeId, channelAccountId, linkUrl } = input;
  await requireOwned(context.db, userId, representativeId);
  const [held] = await context.db
    .select({ id: channelAccount.id })
    .from(representativeChannelAccount)
    .innerJoin(channelAccount, eq(channelAccount.id, representativeChannelAccount.channelAccountId))
    .where(
      and(
        eq(representativeChannelAccount.representativeId, representativeId),
        eq(channelAccount.id, channelAccountId),
        eq(channelAccount.platform, voicePlatform),
      ),
    );
  const credentials = held && (await context.channelAccounts.credentialsOf(held.id));
  if (!credentials) {
    throw rpcError("NOT_FOUND", "error.voiceAccountNotFound", "No such voice account");
  }
  const secret = newSecret();
  await connectChannelAccount(context, {
    userId,
    representativeId,
    platform: voicePlatform,
    credentials: { number: credentials.number!, greeting: credentials.greeting!, secret },
  });
  return { secret, view: await channelAccountsView(context, userId, representativeId, linkUrl) };
}

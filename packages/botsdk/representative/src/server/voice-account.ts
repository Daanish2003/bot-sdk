import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { channelAccount } from "@botsdk/bot/storage";
import { rpcError } from "@botsdk/bot/rpc-error";
import {
  defaultVoiceGreeting,
  type ChannelAccountsView,
  type VoiceAccountSecret,
} from "../shared/contract";
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

/** Thrown inside a save to start it over: the credentials aren't the ones it read. */
const credentialsMoved = new Error("The voice account's credentials changed");

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
 * The credentials of the Representative's voice account and the stored form they were read from,
 * after checking the owner has it; else NOT_FOUND.
 */
async function heldVoiceCredentials(
  context: Context,
  input: { userId: string; representativeId: string; channelAccountId: string },
) {
  const { userId, representativeId, channelAccountId } = input;
  await requireOwned(context.db, userId, representativeId);
  const [held] = await context.db
    .select({ id: channelAccount.id, encrypted: channelAccount.encrypted })
    .from(representativeChannelAccount)
    .innerJoin(channelAccount, eq(channelAccount.id, representativeChannelAccount.channelAccountId))
    .where(
      and(
        eq(representativeChannelAccount.representativeId, representativeId),
        eq(channelAccount.id, channelAccountId),
        eq(channelAccount.platform, voicePlatform),
      ),
    );
  const credentials = held && (await context.channelAccounts.credentialsOf(held.id, voicePlatform));
  if (!credentials) {
    throw rpcError("NOT_FOUND", "error.voiceAccountNotFound", "No such voice account");
  }
  return {
    encrypted: held.encrypted,
    credentials: {
      number: credentials.number ?? "",
      greeting: credentials.greeting ?? defaultVoiceGreeting,
      secret: credentials.secret ?? "",
    },
  };
}

/**
 * Writes what `change` makes of the account's credentials. Every change writes the whole set, so a
 * write from an old read could bring back a secret a regenerate has replaced, or an account just
 * removed: the write holds the account's row and starts over if the set isn't the one it read.
 */
async function changeCredentials(
  context: Context,
  input: { userId: string; representativeId: string; channelAccountId: string },
  change: (credentials: Record<string, string>) => Record<string, string>,
) {
  const { userId, representativeId, channelAccountId } = input;
  for (;;) {
    const { encrypted, credentials } = await heldVoiceCredentials(context, input);
    try {
      await connectChannelAccount(context, {
        userId,
        representativeId,
        platform: voicePlatform,
        credentials: change(credentials),
        check: async (tx) => {
          const [row] = await tx
            .select({ encrypted: channelAccount.encrypted })
            .from(channelAccount)
            .where(eq(channelAccount.id, channelAccountId))
            .for("update");
          if (row?.encrypted !== encrypted) throw credentialsMoved;
        },
      });
      return;
    } catch (error) {
      if (error !== credentialsMoved) throw error;
    }
  }
}

/**
 * Replaces a voice account's secret at once, keeping its number and greeting. Refused when the
 * Representative doesn't hold such an account.
 */
export async function regenerateVoiceSecret(
  context: Context,
  input: { userId: string; representativeId: string; channelAccountId: string; linkUrl?: string },
): Promise<VoiceAccountSecret> {
  const { userId, representativeId, linkUrl } = input;
  const secret = newSecret();
  await changeCredentials(context, input, (credentials) => ({ ...credentials, secret }));
  return { secret, view: await channelAccountsView(context, userId, representativeId, linkUrl) };
}

/**
 * Changes a voice account's greeting, with no new approval: its number and secret stay, so a running
 * Voice agent keeps working. An empty greeting is the default, as when connecting. Refused when the
 * Representative doesn't hold such an account.
 */
export async function setVoiceGreeting(
  context: Context,
  input: {
    userId: string;
    representativeId: string;
    channelAccountId: string;
    greeting: string;
    linkUrl?: string;
  },
): Promise<ChannelAccountsView> {
  const { userId, representativeId, linkUrl } = input;
  await changeCredentials(context, input, (credentials) => ({
    ...credentials,
    greeting: input.greeting || defaultVoiceGreeting,
  }));
  return channelAccountsView(context, userId, representativeId, linkUrl);
}

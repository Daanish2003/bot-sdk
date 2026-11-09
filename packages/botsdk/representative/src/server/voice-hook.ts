import { createHash, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { CoreService, FeatureContext, PublicRoute } from "@botsdk/bot/feature";
import { defaultVoiceGreeting, noNul } from "../shared/contract";
import { representativeChannelAccount } from "./db/schema";
import { voicePlatform } from "./voice-adapter";
import { parsedBody } from "./web-chat";

/*
 * The routes a Voice agent calls (ADR 0036), one per hook, under the voice account's URL. Each carries
 * the account's secret as a bearer token; one that's wrong answers 401, as does an account that isn't
 * a voice account, so the answer says nothing of what exists.
 */

/** A vendor's call id, which the Voice agent names the Call by on every hook. */
export const callIdField = z.string().min(1).max(255).refine(noNul);

/** The voice account a hook is for. */
export type VoiceHookAccount = {
  id: string;
  representativeId: string;
  number: string;
  greeting: string;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/** The voice account whose secret `request` carries, or null. */
async function voiceHookAccount(
  { db, channelAccounts }: Pick<FeatureContext<"channelAccounts">, "db" | "channelAccounts">,
  request: Request,
  accountId: string,
): Promise<VoiceHookAccount | null> {
  if (!z.uuid().safeParse(accountId).success) return null;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const [held] = await db
    .select({ representativeId: representativeChannelAccount.representativeId })
    .from(representativeChannelAccount)
    .where(eq(representativeChannelAccount.channelAccountId, accountId));
  if (!held) return null;
  const credentials = await channelAccounts.credentialsOf(accountId, voicePlatform);
  if (!credentials?.secret) return null;
  // Compared as digests, so the length of the secret doesn't show either.
  if (!timingSafeEqual(sha256(header.slice("Bearer ".length)), sha256(credentials.secret))) {
    return null;
  }
  return {
    id: accountId,
    representativeId: held.representativeId,
    number: credentials.number ?? "",
    greeting: credentials.greeting ?? defaultVoiceGreeting,
  };
}

/**
 * The route of one Voice agent hook, `POST /representative/voice/:accountId/<hook>`: it checks the
 * secret, then reads the body as `schema` has it (400 otherwise) and answers with what `handle`
 * returns, as JSON.
 */
export const voiceHookRoute = <Needs extends CoreService, Body>(
  hook: "start" | "request" | "end",
  schema: { safeParse: (value: unknown) => { success: true; data: Body } | { success: false } },
  handle: (
    context: FeatureContext<Needs>,
    account: VoiceHookAccount,
    body: Body,
  ) => Promise<unknown>,
): PublicRoute<Needs | "channelAccounts"> => ({
  method: "POST",
  path: `/representative/voice/:accountId/${hook}`,
  handle: async (request, { context, params }) => {
    const account = await voiceHookAccount(context, request, params.accountId!);
    if (!account) return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = await parsedBody(request, schema);
    if (body === null) return Response.json({ error: "invalid" }, { status: 400 });
    return Response.json(await handle(context as FeatureContext<Needs>, account, body));
  },
});

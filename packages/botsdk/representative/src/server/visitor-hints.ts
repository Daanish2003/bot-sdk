import type { FeatureContext } from "@botsdk/bot/feature";

import { webChatChannel } from "./customer-proof";

/** The pub/sub channel of one web chat session: its identity is new with each session. */
export const visitorChannel = (externalId: string) => `representative:web-chat:${externalId}`;

/**
 * Tells the web chat session at `to` that what it reads has changed, so it re-reads. Any other Channel
 * has nobody listening. Call it after the commit, or a re-read finds nothing new. Never throws: a page
 * that reconnects re-reads what a lost hint would have told it.
 */
export async function hintVisitor(
  { pubsub, logger }: Pick<FeatureContext<"pubsub">, "pubsub" | "logger">,
  to: { channel: string; externalId: string },
) {
  if (to.channel !== webChatChannel) return;
  try {
    await pubsub.publish(visitorChannel(to.externalId), JSON.stringify({ type: "changed" }));
  } catch (caught) {
    logger.error("Publishing a web chat session's change failed", caught);
  }
}

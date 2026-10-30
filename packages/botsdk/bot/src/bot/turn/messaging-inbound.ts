import type { BotSdkContext } from "../../plugin";
import type { MessagingAccount, MessagingUpdate } from "../../channel/internal";

/**
 * The core's one entry point for a messaging update (spec #1044): a Channel account's listener, or
 * a later platform's webhook route, hands it each normalised update of that account. It resolves
 * once the update is stored or dropped, and only then does the listener confirm it to the
 * platform. No sender is known yet, so every update is dropped: Linked identities (#1046) and the
 * Bot's wake (#1047) fill this in.
 */
export async function receiveMessaging(
  _sdk: BotSdkContext,
  _account: MessagingAccount & { platform: string },
  _update: MessagingUpdate,
): Promise<void> {}

import type { BotSdkContext } from "../../plugin";
import {
  CredentialsRejectedError,
  type MessagingAccount,
  type MessagingAdapter,
  type MessagingUpdate,
} from "../../channel/internal";
import { linkFromCode } from "../conversation";

/** The system notice sent on a Channel once a sender is linked. It is not a Message. */
const linkedNotice = "Linked to your account.";

/**
 * The core's one entry point for a messaging update (spec #1044): a Channel account's listener, or
 * a later platform's webhook route, hands it each normalised update of that account. It resolves
 * once the update is stored or dropped, and only then does the listener confirm it to the
 * platform. A sender who sends a valid link code is linked (#1046) and told so by a system notice;
 * any other update is dropped silently. The Bot's wake for its Linked identity fills in (#1047).
 */
export async function receiveMessaging(
  sdk: BotSdkContext,
  adapter: MessagingAdapter,
  account: MessagingAccount & { platform: string },
  update: MessagingUpdate,
): Promise<void> {
  if (!(await linkFromCode(sdk, account.platform, account.botId, update))) return;
  try {
    await adapter.send(
      account,
      { chatId: update.chat.id, text: linkedNotice },
      { fetch: sdk.fetch },
    );
  } catch (error) {
    // The sender is linked already; a failed notice is not retried.
    if (error instanceof CredentialsRejectedError) throw error;
    sdk.logger.error("Sending the Linked notice failed", error);
  }
}

import { z } from "zod";

import { platformSchema } from "./channel-account";

/** Unlinks the user's Linked identity on a platform. */
export const unlinkIdentityInput = z.object({ platform: platformSchema });

/** A Linked identity (spec #1044) as the RPCs return it: the platform and the account's handle. */
export type LinkedIdentityRow = {
  platform: string;
  /** The account's display handle when it was linked, such as `@ada`. */
  handle: string;
  linkedAt: Date;
};

/** A link code with the links that open a chat with the user's Bots carrying it. */
export type LinkCode = {
  /** The 6-digit code, sent as a whole message (or Telegram's `/start <code>`) to any of the Bots. */
  code: string;
  expiresAt: Date;
  /** One per active Channel account of the user's Bots whose platform has a deep link. */
  links: { platform: string; botId: string; botName: string; handle: string; url: string }[];
};

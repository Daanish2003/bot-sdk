import { botsMessages } from "./bots";
import { chatMessages } from "./chat";
import { errorMessages } from "./errors";
import { pagesMessages } from "./pages";
import { settingsMessages } from "./settings";
import { shellMessages } from "./shell";

/**
 * The English dictionary: the default for every key, and the source of the `Messages` type. Each
 * area lives in its own file here and is spread in below, so adding keys touches one area file.
 */
export const en = {
  ...shellMessages,
  ...chatMessages,
  ...pagesMessages,
  ...settingsMessages,
  ...botsMessages,
  ...errorMessages,
};

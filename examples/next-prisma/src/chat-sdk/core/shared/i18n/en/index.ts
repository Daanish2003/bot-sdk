import { timeMessages } from "./time";

/**
 * The English dictionary: the default for every key, and the source of the `Messages` type. Each
 * area lives in its own file here and is spread in below, so adding keys touches one area file.
 */
export const en = {
  ...timeMessages,
};

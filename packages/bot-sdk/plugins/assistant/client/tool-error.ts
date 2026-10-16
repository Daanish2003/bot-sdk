import { en, type I18n } from "../../../core/shared/i18n";
import type { ToolError } from "../shared/message-parts";
import { formatParams } from "../../../core/client/rpc-error";

/**
 * The text a failed tool call shows: the dictionary's text for the code the part stores, with its
 * params formatted in the locale. A code the dictionary doesn't have shows the generic failure.
 */
export function toolErrorText({ t, locale }: I18n, error: ToolError): string {
  if (!Object.hasOwn(en, error.code)) return t("chat.errorGeneric");
  const params = formatParams(locale, error.params ?? {});
  return (t as (key: string, params?: unknown) => string)(error.code, params);
}

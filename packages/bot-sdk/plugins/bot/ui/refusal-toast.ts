import { toast } from "sonner";

import { useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";

/** Runs a user's action; a refusal says why in a toast. */
export function useRefusalToast() {
  const i18n = useI18n();
  return (action: Promise<unknown>) => {
    action.catch((refusal) => toast.error(serverErrorText(i18n, refusal)));
  };
}

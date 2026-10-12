import { useQuery } from "@tanstack/react-query";

import { useOrpc } from "./provider";

/**
 * Whether the user may bring their own Provider credentials (`byok`, ADR 0007). `false` until the
 * server has answered, so a prompt to add a key never shows on a Host that doesn't allow it.
 */
export function useByok(): boolean {
  const orpc = useOrpc();
  return useQuery(orpc.credentials.mode.queryOptions()).data?.byok === true;
}

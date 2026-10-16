import { useQuery } from "@tanstack/react-query";

import { useOrpc } from "../../../../core/client/react/provider";

/** The caller's Quota (`quota.read`): `null` when unlimited. Refetched after each Run (ADR 0007). */
export function useQuota() {
  const orpc = useOrpc();
  return useQuery(orpc.quota.read.queryOptions());
}

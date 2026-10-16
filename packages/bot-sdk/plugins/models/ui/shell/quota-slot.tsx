import { createContext, type ReactNode, useContext } from "react";

const QuotaSlotContext = createContext<ReactNode>(null);

/** Gives the composer's out-of-Quota banner the host app's `quotaExceeded` slot (ADR 0007). */
export function QuotaSlotProvider({ slot, children }: { slot: ReactNode; children: ReactNode }) {
  return <QuotaSlotContext value={slot}>{children}</QuotaSlotContext>;
}

export function useQuotaSlot(): ReactNode {
  return useContext(QuotaSlotContext);
}

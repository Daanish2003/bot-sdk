import type { FeatureClient } from "@botsdk/client";

import { memoryContract, type MemoryContract } from "../shared/contract";

export type { MemoryContract };

export type MemoryFeatureClient = FeatureClient<"memory", MemoryContract>;

/** The `memory` feature's client part: its contract, served under `memory`. It adds no URLs. */
export function memoryClient(): MemoryFeatureClient {
  return { id: "memory", contract: memoryContract };
}

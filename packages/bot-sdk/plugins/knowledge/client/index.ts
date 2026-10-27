import type { FeatureClient } from "@botsdk/client";

import { knowledgeContract, type KnowledgeContract } from "../shared/contract";

export type { KnowledgeContract };

export type KnowledgeFeatureClient = FeatureClient<"knowledge", KnowledgeContract>;

/** The `knowledge` feature's client part: its contract, served under `knowledge`. It adds no URLs. */
export function knowledgeClient(): KnowledgeFeatureClient {
  return { id: "knowledge", contract: knowledgeContract };
}

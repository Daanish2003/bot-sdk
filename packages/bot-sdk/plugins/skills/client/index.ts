import type { FeatureClient } from "@botsdk/client";

import { skillsContract, type SkillsContract } from "../shared/contract";

export type { SkillsContract };

export type SkillsFeatureClient = FeatureClient<"skills", SkillsContract>;

/** The `skills` feature's client part: its contract, served under `skills`. It adds no URLs. */
export function skillsClient(): SkillsFeatureClient {
  return { id: "skills", contract: skillsContract };
}

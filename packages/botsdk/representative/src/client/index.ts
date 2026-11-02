import type { FeatureClient } from "@botsdk/client";

import { representativeContract, type RepresentativeContract } from "../shared/contract";

export type { RepresentativeContract };

export type RepresentativeFeatureClient = FeatureClient<"representative", RepresentativeContract>;

/** The `representative` feature's client part: its contract, served under `representative`. It adds no URLs. */
export function representativeClient(): RepresentativeFeatureClient {
  return { id: "representative", contract: representativeContract };
}

export {
  type Draft,
  type Expectation,
  type DraftChange,
  type DraftDiff,
  type ReleaseContent,
  type ReleaseSummary,
  type ReleaseView,
  type RepresentativeSummary,
  type RepresentativeTool,
  type RepresentativeView,
  type TestCheck,
  type TestConversation,
  type TestResultStatus,
  type TestResultView,
  type TestStatus,
  type TranscriptEntry,
  representativeTools,
} from "../shared/contract";

import type { FeatureClient } from "@botsdk/client";

import { representativeContract, type RepresentativeContract } from "../shared/contract";
export type { ReplyKind, ReplyProof, ReplySource } from "../shared/replies";

export type { RepresentativeContract };

export type RepresentativeFeatureClient = FeatureClient<"representative", RepresentativeContract>;

/** The `representative` feature's client part: its contract, served under `representative`. It adds no URLs. */
export function representativeClient(): RepresentativeFeatureClient {
  return { id: "representative", contract: representativeContract };
}

export {
  type CustomerIdentityView,
  type CustomerMergeView,
  type CustomerView,
  type DocumentRef,
  type DocumentSnapshot,
  type Draft,
  type FactLogView,
  type FactSnapshot,
  type FactType,
  type FactView,
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
  type ThreadHolder,
  type ThreadMessageView,
  type ThreadSummary,
  type ThreadView,
  type ThreadWaitingOn,
  type TranscriptEntry,
  canonicalJson,
  documentChars,
  maxReleaseDocumentChars,
  factTypes,
  isInEffect,
  representativeTools,
} from "../shared/contract";

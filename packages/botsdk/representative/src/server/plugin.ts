import { defineFeature } from "@botsdk/bot/feature";

import { representativeContract } from "../shared/contract";
import { representativeApi } from "./api";
import { botDraftTools } from "./bot-draft";
import {
  representative,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeCustomerMerge,
  representativeDocument,
  representativeFact,
  representativeFactLog,
  representativeGap,
  representativeFactProposal,
  representativeHandOff,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeProfileField,
  representativeProfileValue,
  representativeRelease,
  representativeTestResult,
  representativeThread,
  representativeThreadMessage,
  representativeTopic,
  representativeCustomerSummary,
  representativeVerification,
} from "./db/schema";
import { threadExpiryJob } from "./expiry";
import { threadIdleJob } from "./idle";
import { exportMerges } from "./customer-merge";
import { deleteProfileFields, exportProfileFields } from "./customer-profile";
import { type CustomerChannel, noCustomerChannel, proofLinkRoutes } from "./customer-proof";
import { deleteCustomers, exportCustomers } from "./customers";
import { dropProposalsOfBot, factProposalTools } from "./fact-proposals";
import { deleteFacts, exportFacts } from "./facts";
import { deleteGaps, exportGaps } from "./gaps";
import representativeMigrations from "./migrations.json" with { type: "json" };
import { heldReleaseJob } from "./held-messages";
import { customerDeliveryJob, exportOutboundDecisions } from "./outbound-gate";
import {
  deleteRepresentatives,
  dropApprovalsOfBot,
  exportRepresentatives,
} from "./representatives";
import type { ConvertDocument, KnowledgeFiles } from "./documents";
import { representativeTestJob } from "./tests";
import { deleteTopics, exportTopics } from "./topics";
import { exportCustomerSummaries, customerSummaryJob } from "./customer-summary";
import { stopUserTurns } from "./thread-turns";
import { handOffEndedJob, limitCheckJob, representativeTurnJob } from "./turn";

export type RepresentativeOptions = {
  /**
   * At most this many Representative Turns run at once in one process; 50 by default. Size it to at
   * least arrivals per second × Turn length in seconds.
   */
  concurrency?: number;
  /**
   * Reads an uploaded PDF or DOCX as text, refusing what it can't, as `convertDocument` from
   * `@botsdk/knowledge/convert` does with Knowledge's limits. Without it, documents upload as Markdown
   * or plain text only. Asked of the Host because the feature has no Computer and no other use for
   * the parsers.
   */
  convertDocument?: ConvertDocument;
  /**
   * Lets the owner pick Knowledge files for a draft: `sdk.knowledge`'s `list` and `read`, passed by a
   * Host that has the Knowledge feature (and so a Computer). The Computer is used only while the owner
   * picks. Without it the picker isn't offered and uploads still work.
   */
  knowledgeFiles?: KnowledgeFiles;
};

/**
 * The `representative` feature (spec #1167): restricted agents that speak for the owner's
 * business, each served only through an approved, unchangeable Release. It has no Computer, and
 * Auto-review and Custom Rules, which belong to Bots, don't reach it. A Host turns it on with
 * `representative()` in `features`. `channel` is how messages reach a Customer: not an option a Host has, since no
 * real Channel reaches a Customer until the specs for them, so `src/index.ts` doesn't pass it on.
 */
export function representativeFeature(
  options: RepresentativeOptions = {},
  channel: CustomerChannel = noCustomerChannel,
) {
  return defineFeature({
    id: "representative",
    needs: [
      "assignments",
      "factApprovals",
      "models",
      "pages",
      "releaseApprovals",
      "representativeLoop",
      "threads",
    ],
    schema: {
      tables: {
        representative,
        representativeCustomer,
        representativeCustomerIdentity,
        representativeCustomerMerge,
        representativeDocument,
        representativeFact,
        representativeFactLog,
        representativeGap,
        representativeFactProposal,
        representativeHandOff,
        representativeHeldMessage,
        representativeOutboundDecision,
        representativeProfileField,
        representativeProfileValue,
        representativeRelease,
        representativeTestResult,
        representativeThread,
        representativeThreadMessage,
        representativeTopic,
        representativeCustomerSummary,
        representativeVerification,
      },
      migrations: representativeMigrations,
    },
    contract: representativeContract,
    api: (context) => representativeApi(context, options.convertDocument, options.knowledgeFiles),
    tools: (turn, context) => [
      ...botDraftTools(turn, context),
      ...factProposalTools(turn, context),
    ],
    resetBot: async (botId, userId, context) => {
      await dropApprovalsOfBot(context, botId, userId);
      await dropProposalsOfBot(context, botId, userId);
    },
    stopTurns: (userId, context) => stopUserTurns(context, userId),
    publicRoutes: proofLinkRoutes,
    jobs: [
      representativeTurnJob(options.concurrency, channel),
      customerDeliveryJob(channel),
      heldReleaseJob,
      handOffEndedJob,
      limitCheckJob,
      representativeTestJob,
      threadIdleJob,
      threadExpiryJob,
      customerSummaryJob,
    ],
    userData: {
      delete: {
        before: async (tx, userId) => {
          // Representatives first: a Turn receiving a message holds its Representative's row, so once
          // this has passed it, no new Customer can appear behind the delete below.
          await deleteRepresentatives(tx, userId);
          await deleteCustomers(tx, userId);
          await deleteProfileFields(tx, userId);
          await deleteFacts(tx, userId);
          await deleteGaps(tx, userId);
          await deleteTopics(tx, userId);
        },
      },
      export: async (tx, userId) => ({
        representatives: await exportRepresentatives(tx, userId),
        customers: await exportCustomers(tx, userId),
        customerMerges: await exportMerges(tx, userId),
        outboundDecisions: await exportOutboundDecisions(tx, userId),
        customerSummaries: await exportCustomerSummaries(tx, userId),
        profileFields: await exportProfileFields(tx, userId),
        ...(await exportFacts(tx, userId)),
        ...(await exportGaps(tx, userId)),
        topics: await exportTopics(tx, userId),
      }),
    },
  });
}

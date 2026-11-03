import { defineFeature } from "@botsdk/bot/feature";

import { representativeContract } from "../shared/contract";
import { representativeApi } from "./api";
import { botDraftTools } from "./bot-draft";
import {
  representative,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeCustomerMerge,
  representativeHandOff,
  representativeRelease,
  representativeTestResult,
  representativeThread,
  representativeThreadMessage,
  representativeVerification,
} from "./db/schema";
import { threadIdleJob } from "./idle";
import { exportMerges } from "./customer-merge";
import { type CustomerChannel, noCustomerChannel, proofLinkRoutes } from "./customer-proof";
import { deleteCustomers, exportCustomers } from "./customers";
import representativeMigrations from "./migrations.json" with { type: "json" };
import {
  deleteRepresentatives,
  dropApprovalsOfBot,
  exportRepresentatives,
} from "./representatives";
import { representativeTestJob } from "./tests";
import { handOffEndedJob, representativeTurnJob } from "./turn";

export type RepresentativeOptions = {
  /**
   * At most this many Representative Turns run at once in one process; 50 by default. Size it to at
   * least arrivals per second × Turn length in seconds.
   */
  concurrency?: number;
};

/**
 * The `representative` feature (spec #1167): restricted agents that speak for the owner's
 * business, each served only through an approved, unchangeable Release. It has no Computer, and
 * Auto-review and Custom Rules, which belong to Bots, don't reach it. A Host turns it on with
 * `representative()` in `features`. `channel` is where proofs go: not an option a Host has, since no
 * real Channel reaches a Customer until the specs for them, so `src/index.ts` doesn't pass it on.
 */
export function representativeFeature(
  options: RepresentativeOptions = {},
  channel: CustomerChannel = noCustomerChannel,
) {
  return defineFeature({
    id: "representative",
    needs: ["assignments", "models", "releaseApprovals", "representativeLoop", "threads"],
    schema: {
      tables: {
        representative,
        representativeCustomer,
        representativeCustomerIdentity,
        representativeCustomerMerge,
        representativeHandOff,
        representativeRelease,
        representativeTestResult,
        representativeThread,
        representativeThreadMessage,
        representativeVerification,
      },
      migrations: representativeMigrations,
    },
    contract: representativeContract,
    api: (context) => representativeApi(context),
    tools: (turn, context) => botDraftTools(turn, context),
    resetBot: (botId, userId, context) => dropApprovalsOfBot(context, botId, userId),
    publicRoutes: proofLinkRoutes,
    jobs: [
      representativeTurnJob(options.concurrency, channel),
      handOffEndedJob,
      representativeTestJob,
      threadIdleJob,
    ],
    userData: {
      delete: {
        before: async (tx, userId) => {
          // Representatives first: a Turn receiving a message holds its Representative's row, so once
          // this has passed it, no new Customer can appear behind the delete below.
          await deleteRepresentatives(tx, userId);
          await deleteCustomers(tx, userId);
        },
      },
      export: async (tx, userId) => ({
        representatives: await exportRepresentatives(tx, userId),
        customers: await exportCustomers(tx, userId),
        customerMerges: await exportMerges(tx, userId),
      }),
    },
  });
}

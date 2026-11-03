import { defineFeature } from "@botsdk/bot/feature";

import { representativeContract } from "../shared/contract";
import { representativeApi } from "./api";
import { botDraftTools } from "./bot-draft";
import {
  representative,
  representativeHandOff,
  representativeRelease,
  representativeTestResult,
} from "./db/schema";
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
 * `representative()` in `features`.
 */
export function representativeFeature(options: RepresentativeOptions = {}) {
  return defineFeature({
    id: "representative",
    needs: ["assignments", "models", "releaseApprovals", "representativeLoop", "threads"],
    schema: {
      tables: {
        representative,
        representativeHandOff,
        representativeRelease,
        representativeTestResult,
      },
      migrations: representativeMigrations,
    },
    contract: representativeContract,
    api: (context) => representativeApi(context),
    tools: (turn, context) => botDraftTools(turn, context),
    resetBot: (botId, userId, context) => dropApprovalsOfBot(context, botId, userId),
    jobs: [representativeTurnJob(options.concurrency), handOffEndedJob, representativeTestJob],
    userData: {
      delete: { before: (tx, userId) => deleteRepresentatives(tx, userId) },
      export: async (tx, userId) => ({
        representatives: await exportRepresentatives(tx, userId),
      }),
    },
  });
}

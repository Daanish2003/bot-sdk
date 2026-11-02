import { defineFeature } from "@botsdk/bot/feature";

import { representativeContract } from "../shared/contract";
import { representativeApi } from "./api";
import { representative, representativeRelease } from "./db/schema";
import representativeMigrations from "./migrations.json" with { type: "json" };
import { deleteRepresentatives, exportRepresentatives } from "./representatives";

/**
 * The `representative` feature (spec #1167): restricted agents that speak for the owner's
 * business, each served only through an approved, unchangeable Release. It has no Computer, and
 * Auto-review and Custom Rules, which belong to Bots, don't reach it. A Host turns it on with
 * `representative()` in `features`.
 */
export function representativeFeature() {
  return defineFeature({
    id: "representative",
    schema: {
      tables: { representative, representativeRelease },
      migrations: representativeMigrations,
    },
    contract: representativeContract,
    api: (context) => representativeApi(context),
    userData: {
      delete: { before: (tx, userId) => deleteRepresentatives(tx, userId) },
      export: async (tx, userId) => ({
        representatives: await exportRepresentatives(tx, userId),
      }),
    },
  });
}

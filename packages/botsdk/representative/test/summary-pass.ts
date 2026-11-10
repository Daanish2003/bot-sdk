import type { TextOptions } from "@tanstack/ai";

import { customerSummaryMarker } from "../src/server/customer-summary";

/** Whether a scripted Model call is the Customer summary pass a thread close queues, which a test's scripted rounds must not answer. */
export const isSummaryPass = (options: Pick<TextOptions, "systemPrompts">) =>
  JSON.stringify(options.systemPrompts ?? []).includes(customerSummaryMarker);

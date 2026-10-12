import type { ReasoningChoice } from "./models";

/** Tokens a Run used, summed over its model iterations (input includes cached tokens). */
export type MessageUsage = {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  /** True when the Provider reported no usage (a stopped or failed reply) and this is an estimate. */
  estimated: boolean;
};

/**
 * A stored Message, as the isomorphic code reads it. The server's row type is assignable to it,
 * so shared code never imports from `core/server`.
 */
export type MessageRecord = {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  parts: unknown;
  model: string | null;
  /** The reasoning effort the Run used; null when the Model's default was used, and on user Messages. */
  reasoningEffort: ReasoningChoice | null;
  /** `awaiting_approval`: the Run ended on a tool call that waits for the user's decision (ADR 0008). */
  status: "streaming" | "complete" | "stopped" | "error" | "awaiting_approval";
  error: string | null;
  errorReason: "invalid_key" | "rate_limited" | "provider_error" | null;
  /** Tokens the Run used, for display only; null on user Messages and on older Runs. */
  usage: MessageUsage | null;
  /**
   * The first stored Message the Model saw on this reply's Run, when older Messages were dropped to
   * fit the window; null when all were sent. Only the Conversation read carries it.
   */
  contextStartId: string | null;
  createdAt: Date;
};

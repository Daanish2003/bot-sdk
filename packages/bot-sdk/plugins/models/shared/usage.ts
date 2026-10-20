/** Tokens a Run used, summed over its model iterations (input includes cached tokens). */
export type MessageUsage = {
  input: number;
  output: number;
  reasoning: number;
  /** Input tokens read from the Provider's prompt cache. */
  cached: number;
  /**
   * Input tokens written to the Provider's prompt cache. Absent from usage recorded before #667 (a
   * stored Message or Helper, or a Checkpoint replayed after a deploy), which counts as 0.
   */
  cacheWrite?: number;
  /** True when the Provider reported no usage (a stopped or failed reply) and this is an estimate. */
  estimated: boolean;
};

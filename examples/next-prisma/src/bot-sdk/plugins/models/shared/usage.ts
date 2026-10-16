/** Tokens a Run used, summed over its model iterations (input includes cached tokens). */
export type MessageUsage = {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  /** True when the Provider reported no usage (a stopped or failed reply) and this is an estimate. */
  estimated: boolean;
};

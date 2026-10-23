/** A request the server refused for its rate limit (spec 87). `retryAfterSeconds` comes from `Retry-After`. */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Too many requests; try again in ${retryAfterSeconds} seconds`);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Passes a response through, except a 429, which throws a `RateLimitedError` carrying the retry time. */
export function throwIfRateLimited(response: Response): Response {
  if (response.status !== 429) return response;
  const seconds = Number(response.headers.get("Retry-After"));
  throw new RateLimitedError(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 1);
}

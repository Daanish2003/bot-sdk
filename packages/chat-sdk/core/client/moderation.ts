/** A Message the Host's `moderate` refused (HTTP 422, code `moderated`, #267). `message` is the Host's reason, or the default. */
export class ModeratedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeratedError";
  }
}

/** Passes a response through, except a moderated refusal, which throws a `ModeratedError` carrying the reason. */
export async function throwIfModerated(response: Response): Promise<Response> {
  if (response.status !== 422) return response;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (body && typeof body === "object" && (body as { code?: unknown }).code === "moderated") {
    throw new ModeratedError(String((body as { message?: unknown }).message ?? ""));
  }
  return response;
}

/**
 * The `ModeratedError` behind a failed send, if there is one. The connection wraps a failed fetch
 * in its own error, so this follows the `cause` chain.
 */
export function moderatedErrorOf(error: unknown): ModeratedError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof ModeratedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

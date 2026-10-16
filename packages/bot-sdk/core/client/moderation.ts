/**
 * A Message the Host's `moderate` refused (HTTP 422, code `moderated`, #267). `message` is the Host's
 * `reason`, or empty when it gave none: the UI shows its own default then, not the server's English one.
 */
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
    const { reason } = body as { reason?: unknown };
    throw new ModeratedError(typeof reason === "string" ? reason : "");
  }
  return response;
}

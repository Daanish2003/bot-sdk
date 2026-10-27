import { ORPCError, ValidationError } from "@orpc/server";
import type { z } from "zod";

import type { ErrorCode } from "@botsdk/client/i18n";

export type RpcErrorStatus =
  | "BAD_REQUEST"
  | "CONFLICT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "PAYMENT_REQUIRED"
  | "UNAUTHORIZED";

/** The params a code's dictionary text takes. Numbers stay numbers; the client formats them. */
export type ErrorParams = Record<string, string | number>;

/**
 * An oRPC error with its dictionary code in `data` (spec #256). The client shows `t(code, params)`
 * and never the message, which stays English for the logs.
 */
export function rpcError(
  status: RpcErrorStatus,
  code: ErrorCode,
  message: string,
  params?: ErrorParams,
  extra?: Record<string, unknown>,
) {
  // oRPC has no 402 code of its own, so the HTTP status is set beside the code.
  const httpStatus = status === "PAYMENT_REQUIRED" ? 402 : undefined;
  return new ORPCError(status, { message, status: httpStatus, data: { ...extra, code, params } });
}

/** A domain method's argument: the input `Schema` validates, with the acting user's id. */
export type WithUser<Schema extends z.ZodType> = { userId: string } & z.input<Schema>;

/**
 * A domain method's input, parsed with the schema its procedure validates with (spec #873). An
 * invalid one throws the error the procedure answers: BAD_REQUEST, "Input validation failed",
 * with the issues in `data`.
 */
export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const { issues } = result.error;
  throw new ORPCError("BAD_REQUEST", {
    message: "Input validation failed",
    data: { issues },
    cause: new ValidationError({ message: "Input validation failed", issues, data: input }),
  });
}

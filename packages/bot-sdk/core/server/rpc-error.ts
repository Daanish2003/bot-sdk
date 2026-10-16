import { ORPCError } from "@orpc/server";

import type { ErrorCode } from "../shared/i18n";

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

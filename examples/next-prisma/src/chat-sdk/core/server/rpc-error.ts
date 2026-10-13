import { ORPCError } from "@orpc/server";

import type { ErrorCode } from "../shared/i18n";
import { providerLabel, unusableModelMessage } from "../shared/credentials/services";

export type RpcErrorStatus =
  | "BAD_REQUEST"
  | "CONFLICT"
  | "FORBIDDEN"
  | "NOT_FOUND"
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
  return new ORPCError(status, { message, data: { ...extra, code, params } });
}

/** Why a Model can't be used: the key prompt while the user may bring keys (`byok`), else only "pick another". */
export function unusableModelError(service: string, byok: boolean) {
  if (!byok) return rpcError("BAD_REQUEST", "error.pickAnotherModel", "Pick another Model");
  return rpcError("BAD_REQUEST", "error.addKey", unusableModelMessage(service, byok), {
    label: providerLabel(service),
  });
}

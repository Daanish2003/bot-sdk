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

/**
 * Why a Model can't be used, as a code and params: the key prompt while the user may bring keys
 * (`byok`), else only "pick another". Shared by the chat route and the RPC procedures.
 */
export function unusableModelCode(
  service: string,
  byok: boolean,
): { code: ErrorCode; params: ErrorParams } {
  if (!byok) return { code: "error.pickAnotherModel", params: {} };
  return { code: "error.addKey", params: { label: providerLabel(service) } };
}

/** Why a Model can't be used, as an oRPC error (see `unusableModelCode`). */
export function unusableModelError(service: string, byok: boolean) {
  const { code, params } = unusableModelCode(service, byok);
  const message = byok ? unusableModelMessage(service, byok) : "Pick another Model";
  return rpcError("BAD_REQUEST", code, message, params);
}
